import type { ConversationId } from '@earendil-works/pi-durable';
import { createLogger } from '@mavis/logging';

import type { PiDurableCompositionRoot } from '../session-system/messages/history/pi-durable-root.js';

const log = createLogger('mcode:orchestration');

/**
 * W10 Part A — the product session→conversation resolver of the orchestration
 * composition (W08 deferred item 2: "session→conversation резолвера —
 * композиция"; review closure №2 made the resolution REQUIRED/fail-closed).
 *
 * One pi conversation per product session, on the runtime's ONE storage: the
 * assignment is minted lazily on first use and persisted as an
 * `mcode.session-map.v1` record in the bridge log (the same log the turn
 * driver store writes), so reopen rebuilds the map by scanning the log once
 * per process — the same rebuild-once model as the Ш1 history provider. A
 * missing mapping NEVER falls back to the root conversation (that would
 * collapse sessions into one conversation — the W08 review failure mode).
 *
 * All writes go through the composition root's ONE gate: mint + conversation
 * write + map record are serialized against worker appends and pi commits.
 *
 * @module
 */

/** Bridge-log record kind of one session→conversation assignment. */
export const SESSION_CONVERSATION_MAP_KIND = 'mcode.session-map.v1';

interface SessionConversationRecord {
  readonly sessionId: string;
  readonly conversationId: number;
}

export interface SessionConversationResolver {
  /** The product mapping (fail-closed: never undefined-fallback to root). */
  conversationOfSession(sessionId: string): Promise<ConversationId | undefined>;
  /** Assignment observed at open (observability). */
  readonly size: () => number;
}

/**
 * Builds the resolver over the composition root. The initial map is rebuilt
 * from the bridge log synchronously at open (the port's index is warm).
 */
export function openSessionConversationResolver(options: {
  readonly root: PiDurableCompositionRoot;
}): SessionConversationResolver {
  const { port, storage, gate } = options.root;
  const map = new Map<string, ConversationId>();
  // Rebuild once: walk the log delta-by-delta (the port's windowed reader);
  // O(map records) after the port's own open index pass.
  let afterSeq = 0;
  for (;;) {
    const delta = port.readDeltaChecked(afterSeq, 8 * 1024 * 1024);
    for (const entry of delta.entries) {
      if (entry.kind !== SESSION_CONVERSATION_MAP_KIND) continue;
      const record = entry.payload as unknown;
      if (
        typeof record === 'object' &&
        record !== null &&
        typeof (record as SessionConversationRecord).sessionId === 'string' &&
        Number.isSafeInteger((record as SessionConversationRecord).conversationId)
      ) {
        const typed = record as SessionConversationRecord;
        map.set(typed.sessionId, typed.conversationId as ConversationId);
      }
    }
    if (delta.nextAfterSeq === null) break;
    afterSeq = delta.nextAfterSeq;
  }
  log.info('session-conversation resolver opened', { assignments: map.size });

  const pending = new Map<string, Promise<ConversationId>>();
  async function assign(sessionId: string): Promise<ConversationId> {
    const existing = pending.get(sessionId);
    if (existing) return existing;
    const created = (async () => {
      // 1. Mint the pi conversation id and write the conversation record —
      //    through the gated storage, serialized with every other writer.
      //    Crash window: a crash between (1) and (2) leaves an orphan
      //    conversation; the map record (2) is the source of truth, so the
      //    next assign mints a fresh conversation and the orphan stays
      //    unused (fail-closed — never a wrong mapping).
      const conversationId = (await gate.run(() => storage.mintId())) as ConversationId;
      await gate.run(() =>
        (storage as unknown as { commit(writes: readonly unknown[]): Promise<number> }).commit([
          { type: 'conversation', value: { id: conversationId } },
        ]),
      );
      // 2. Persist the assignment in the bridge log (one pi commit).
      await port.appendBatch([
        {
          id: `${SESSION_CONVERSATION_MAP_KIND}:${sessionId}`,
          kind: SESSION_CONVERSATION_MAP_KIND,
          payload: { sessionId, conversationId } satisfies SessionConversationRecord as never,
        },
      ]);
      map.set(sessionId, conversationId);
      log.debug('session conversation assigned', { sessionId, conversationId: String(conversationId) });
      return conversationId;
    })();
    pending.set(sessionId, created);
    try {
      return await created;
    } finally {
      pending.delete(sessionId);
    }
  }

  return {
    conversationOfSession: async (sessionId: string) => {
      const known = map.get(sessionId);
      if (known !== undefined) return known;
      return assign(sessionId);
    },
    size: () => map.size,
  };
}
