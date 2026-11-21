/**
 * Wave-2 acceptance over the REAL durable store (canon 05 §3, items 2.1/2.2/
 * 2.4): the append-time image offload — the same image committed three times
 * lands as ONE artifact file and the LOG carries reference blocks plus
 * `offload` events, never base64; the TEXT offload applies as kilobyte
 * `offload` events whose fold shows the stub receipts while the log keeps the
 * original bytes; a stale text-offload plan is refused fail-closed; and the
 * offload grows no generation (a compaction plan stays valid).
 */

import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SessionRecord, SessionRepository } from '../../sessions/repo/contract.js';
import { createDurableHistoryStorage, createDurableSessionSystemCanonicalHistoryProvider } from './durable-canonical-history-provider.js';
import type {
  DurableHistoryStorage,
  DurableSessionSystemCanonicalHistoryProvider,
} from './durable-canonical-history-provider.js';
import { ImageArtifactStore, resolveArtifactsDir } from './image-artifact-store.js';
import { createSessionHistoryIoLane } from './mutation/session-history-coordination.js';
import type { SessionHistoryLocationResolver } from './session-history-location.js';
import type { SessionHistoryPaths } from './session-history-paths.js';

const EVENT_OFFLOAD = 'history.v2.offload';
const APPEND_KIND = 'history.v1.append';
const FULL_KIND = 'history.v1.full';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8AARIQBEwMDCwEAOpMBAbvpB8sAAAAASUVORK5CYII=';

interface Fixture {
  readonly root: string;
  readonly sessions: Pick<SessionRepository, 'get'>;
  readonly locations: SessionHistoryLocationResolver;
  storage: DurableHistoryStorage;
  durable: DurableSessionSystemCanonicalHistoryProvider;
  artifacts: ImageArtifactStore;
}

function stubLocations(root: string): SessionHistoryLocationResolver {
  const pathsFor = (sessionId: string): SessionHistoryPaths => {
    const sessionDir = join(root, 'v2', 'sessions', sessionId);
    return {
      sessionDir,
      manifest: join(sessionDir, 'manifest.json'),
      messages: join(sessionDir, 'messages.jsonl'),
      snapshots: join(sessionDir, 'snapshots'),
      reports: join(sessionDir, 'reports'),
    };
  };
  return {
    resolve: async (session) => pathsFor(session.sessionId),
    allocate: async (session) => pathsFor(session.sessionId),
    ensure: async (session) => pathsFor(session.sessionId),
    inspect: async (session) => pathsFor(session.sessionId),
    inspectSession: async (sessionId) => ({
      session: (await stubSessionRepository(root).get(sessionId)) as SessionRecord,
      paths: pathsFor(sessionId),
    }),
    resolveSession: async (sessionId) => ({
      session: (await stubSessionRepository(root).get(sessionId)) as SessionRecord,
      paths: pathsFor(sessionId),
    }),
  };
}

function stubSessionRepository(root: string): Pick<SessionRepository, 'get'> {
  return {
    get: async (sessionId: string) =>
      ({
        sessionId,
        createdAtMs: 0,
        historyRelativeDir: `sessions/${sessionId}`,
        workspaceDir: join(root, 'workspaces', sessionId),
        agentName: 'root',
      }) as unknown as SessionRecord,
  };
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'durable-offload-'));
  const storage = await createDurableHistoryStorage({ dataDir: root });
  const artifacts = new ImageArtifactStore({ artifactsDir: resolveArtifactsDir(root) });
  return {
    root,
    sessions: stubSessionRepository(root),
    locations: stubLocations(root),
    storage,
    artifacts,
    durable: createDurableSessionSystemCanonicalHistoryProvider({
      storage,
      dataDir: root,
      sessions: stubSessionRepository(root),
      locations: stubLocations(root),
      imageArtifacts: artifacts,
    }),
  };
}

async function disposeFixture(fixture: Fixture): Promise<void> {
  await fixture.storage.dispose();
  await rm(fixture.root, { recursive: true, force: true });
}

async function sessionEntries(storage: DurableHistoryStorage, sessionId: string): Promise<{ id: string; kind: string; payload: Record<string, unknown> }[]> {
  // Per-session storage: the entries live in the session's OWN log file.
  const backend = (await storage.sessionStores(sessionId)).backend;
  return backend
    .readDelta(0, 256 * 1024 * 1024)
    .filter((stored) => !stored.kind.startsWith('pi.'))
    .filter((stored) => (stored.payload as { sessionId?: string }).sessionId === sessionId)
    .map((stored) => ({
      id: stored.id,
      kind: stored.kind,
      payload: stored.payload as Record<string, unknown>,
    }));
}

function imageMessage(text: string, timestamp: number) {
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image', data: PNG_BASE64, mimeType: 'image/png' },
    ],
    timestamp,
  };
}

function appendChange(sessionId: string, operationId: string, messages: readonly unknown[], turnId = 'turn-1') {
  return {
    sessionId,
    turnId,
    reason: 'messageDelta' as const,
    messages,
    operation: { id: operationId, kind: 'test' },
  };
}

describe('durable image offload (2.1: bytes to the artifact, the log keeps the reference)', () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await createFixture();
  });
  afterEach(async () => {
    await disposeFixture(fixture);
  });

  it('the same image committed ×3 → one artifact file; the log holds reference blocks + offload events, no base64', async () => {
    const sessionId = 's-img';
    await fixture.durable.initialize(sessionId);
    for (const op of [1, 2, 3]) {
      await fixture.durable.append(appendChange(sessionId, `op-${op}`, [imageMessage(`shot ${op}`, op)], `turn-${op}`));
    }

    // ONE physical file for the three receipts (dedup by content address).
    const artifactsDir = resolveArtifactsDir(fixture.root);
    expect(existsSync(artifactsDir)).toBe(true);
    const pngs = readdirSync(artifactsDir).filter((name) => name.endsWith('.png'));
    expect(pngs).toHaveLength(1);

    // The log: each append carries ONE offload event naming the same sha;
    // no envelope payload anywhere holds the base64.
    const entries = await sessionEntries(fixture.storage, sessionId);
    const offloads = entries.filter((entry) => entry.kind === EVENT_OFFLOAD);
    expect(offloads).toHaveLength(3);
    for (const [index, offload] of offloads.entries()) {
      expect(offload.payload['artifactRef']).toBe(pngs[0]!.replace(/\.png$/u, ''));
      expect(offload.payload['blockIdx']).toBe(0);
      expect(offload.payload['contentBlockIdx']).toBe(1);
      expect(offload.payload['seq']).toBe((index + 1) * 2);
    }
    const rawLog = JSON.stringify(entries);
    expect(rawLog).not.toContain(PNG_BASE64);
    expect(rawLog).toContain('artifactRef');

    // The read-back: reference blocks (no data), pointing at the artifact.
    const active = await fixture.durable.readActive(sessionId);
    expect(active.messages).toHaveLength(3);
    for (const message of active.messages) {
      const block = (message as { content: { type: string; data?: string; artifact?: string }[] })['content'][1];
      expect(block['type']).toBe('image');
      expect(block['data']).toBeUndefined();
      expect(block['artifact']).toBe(join(artifactsDir, pngs[0]!));
    }
  });

  it('the offload grows no generation and survives the restart (the fold replays the events)', async () => {
    const sessionId = 's-gen';
    await fixture.durable.initialize(sessionId);
    await fixture.durable.append(appendChange(sessionId, 'op-1', [imageMessage('shot', 1)]));
    const before = await fixture.durable.readActive(sessionId);

    // A COMPACT-style read of the fold generation through the compact seam's
    // baseline would be the roundtrip; here the honest observable: the
    // offload wrote no generation-stamping event kinds (only `offload` and
    // the append), so a later compaction plan stays valid. Assert via the
    // log's entry kinds.
    const kinds = (await sessionEntries(fixture.storage, sessionId)).map((entry) => entry.kind);
    expect(kinds).toEqual([FULL_KIND, APPEND_KIND, EVENT_OFFLOAD]);

    // Restart: a NEW provider folds the log from scratch — the reference
    // blocks come back identical.
    const reopened = createDurableSessionSystemCanonicalHistoryProvider({
      storage: fixture.storage,
      dataDir: fixture.root,
      sessions: fixture.sessions,
      locations: fixture.locations,
      imageArtifacts: fixture.artifacts,
    });
    const after = await reopened.readActive(sessionId);
    expect(after.messages).toEqual(before.messages);
  });
});

describe('durable TEXT offload (2.4: tool_archive as offload events, never a rewrite)', () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await createFixture();
  });
  afterEach(async () => {
    await disposeFixture(fixture);
  });

  it('the fold shows the stub receipt; the log keeps the original bytes; media survives', async () => {
    const sessionId = 's-text';
    await fixture.durable.initialize(sessionId);
    const bigText = 'x'.repeat(4_000);
    await fixture.durable.append(
      appendChange(sessionId, 'op-1', [
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} }],
          timestamp: 1,
        },
      ]),
    );
    await fixture.durable.append(
      appendChange(
        sessionId,
        'op-2',
        [
          {
            role: 'toolResult',
            toolCallId: 'call-1',
            toolName: 'bash',
            content: [
              { type: 'text', text: bigText },
              { type: 'image', data: PNG_BASE64, mimeType: 'image/png' },
            ],
            isError: false,
            timestamp: 2,
          },
        ],
        'turn-1',
      ),
    );

    const receipt = '[Earlier tool output externalized\nArtifact: cas://sha256/abc\nArchived reference only; not evidence.]';
    await fixture.durable.offloadToolText(sessionId, [
      { envelopeIndex: 1, replacement: receipt, reference: 'abc123' },
    ]);

    // Kilobyte events only — the whole-history rewrite is gone. TWO offload
    // events total: the append-time IMAGE offload of the receipt's own
    // screenshot, plus the TEXT offload this test applies.
    const entries = await sessionEntries(fixture.storage, sessionId);
    const offloadEvents = entries.filter((entry) => entry.kind === EVENT_OFFLOAD);
    expect(offloadEvents).toHaveLength(2);
    const textOffload = offloadEvents.find((event) => event.payload['replacement'] !== undefined)!;
    expect(textOffload.payload['replacement']).toBe(receipt);
    expect(textOffload.payload['artifactRef']).toBe('abc123');

    // The ACTIVE history shows the receipt; the media block (an offloaded
    // reference by now — the append-time image offload) survives; the role
    // and tool metadata are intact.
    const active = await fixture.durable.readActive(sessionId);
    const toolResult = active.messages[1] as { role: string; toolCallId: string; content: { type: string; text?: string; data?: string; artifact?: string }[] };
    expect(toolResult['role']).toBe('toolResult');
    expect(toolResult['toolCallId']).toBe('call-1');
    expect(toolResult['content']).toHaveLength(2);
    expect(toolResult['content'][0]).toEqual({ type: 'text', text: receipt });
    expect(toolResult['content'][1]!['type']).toBe('image');
    expect(toolResult['content'][1]!['artifact']).toBeDefined();

    // The LOG keeps the original bytes (append-only): the append entry still
    // carries the full text.
    const appendEntry = entries.find((entry) => {
      if (entry.kind !== APPEND_KIND) return false;
      const envelopes = (entry.payload as { envelopes?: { message?: { content?: { text?: string }[] }[] } }).envelopes;
      return envelopes?.some((envelope) => envelope.message?.content?.some((block) => block.text === bigText)) === true;
    });
    expect(appendEntry).toBeDefined();

    // The offload grew no generation: no replace/repair/replace-all event
    // (the generation-stamping kinds) was written for the offload.
    expect(
      entries.every(
        (entry) =>
          entry.kind !== 'history.v2.replace' &&
          entry.kind !== 'history.v2.repair' &&
          entry.kind !== 'history.v2.compaction.replace',
      ),
    ).toBe(true);

    // Restart parity: a fresh fold applies the event to the same result.
    const reopened = createDurableSessionSystemCanonicalHistoryProvider({
      storage: fixture.storage,
      dataDir: fixture.root,
      sessions: fixture.sessions,
      locations: fixture.locations,
    });
    const after = await reopened.readActive(sessionId);
    expect(after.messages).toEqual(active.messages);
  });

  it('a stale plan (a foreign envelope index) is refused fail-closed and writes NOTHING', async () => {
    const sessionId = 's-stale';
    await fixture.durable.initialize(sessionId);
    await fixture.durable.append(appendChange(sessionId, 'op-1', [{ role: 'user', content: 'go', timestamp: 1 }]));
    const before = await sessionEntries(fixture.storage, sessionId);

    await expect(
      fixture.durable.offloadToolText(sessionId, [
        { envelopeIndex: 9, replacement: 'receipt', reference: 'ref-9' },
      ]),
    ).rejects.toThrow('offload plan is stale');

    expect((await sessionEntries(fixture.storage, sessionId))).toHaveLength(before.length);
  });
});
