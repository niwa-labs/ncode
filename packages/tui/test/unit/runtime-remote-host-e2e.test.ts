/**
 * W4 reopen-gate e2e (round 2, finding 2): "окно закрыто посреди хода →
 * открытие окна его показывает" — the PRODUCT chain, composed:
 *
 *   TuiRemoteCliService (the port adapter) → real McodedClient → real
 *   McodedDaemon on a real unix socket → CliBridge attach filtering.
 *
 * A window that NEVER streamed a turn attaches by VIEWING the session
 * (`getSession`), after which (a) the ask-push fallback reaches it, (b) the
 * daemon-filtered `listPendingPermissions` snapshot shows the approval and
 * feeds the reply map, and (c) `replyPermission` re-attaches the session id
 * the daemon requires. Before the view, all three hide the approval — that
 * ordering IS the test.
 *
 * @module
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CliBridge,
  EchoRuntimeAdapter,
  MCODED_TOKEN_BASENAME,
  McodedClient,
  McodedDaemon,
  PushableIterable,
  RemoteCliService,
} from '@mavis/mcoded';

import { TuiRemoteCliService } from '../../src/runtime/remote-host.js';

/** CliService double: the daemon bridge only touches these members. */
function fakeRuntimeCli(events: PushableIterable<unknown>) {
  return {
    calls: [] as Array<{ method: string; args: unknown[] }>,
    getSession: async (req: unknown) => ({ session: { id: (req as { id: string }).id } }),
    listPendingPermissions: async () => ({
      requests: [{ requestId: 'req-open', sessionId: 's9', toolName: 'bash' }],
    }),
    replyPermission: async (req: unknown) => {
      thisCalls.push({ method: 'replyPermission', args: [req] });
      events.push({
        type: 'permission.resolved',
        payload: { requestId: (req as { requestId: string }).requestId, sessionId: 's9', decision: 'allowOnce' },
      });
      return { success: true };
    },
    sendMessage: async () => ({ ok: true, source: (async function* () {})() }),
    isGoalEnabled: () => false,
    getSessionPublishStaleSessions: () => [] as readonly string[],
  };
}
const thisCalls: Array<{ method: string; args: unknown[] }> = [];

describe('W4 reopen gate: a late window sees and answers the pending approval', () => {
  let root: string;

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('view attaches; the snapshot, the push and the reply all follow (product composition)', { timeout: 30_000 }, async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'w4-reopen-')));
    writeFileSync(join(root, MCODED_TOKEN_BASENAME), 'test-token');
    const events = new PushableIterable<unknown>();
    const cli = fakeRuntimeCli(events) as never;
    const daemon = new McodedDaemon({
      root,
      adapter: new EchoRuntimeAdapter(),
      durableLayout: false,
      listenFd: null,
      handshake: { token: 'test-token', dataDir: root },
      hub: {
        bridge: new CliBridge({ cliService: () => cli }),
        globalEvents: events,
      },
    });
    await daemon.start();
    try {
      const client = new McodedClient({
        socketPath: daemon.socketPath,
        handshake: { token: 'test-token', dataDir: root, clientInstanceId: 'win-late' },
        readyTimeoutMs: 10_000,
      });
      await client.connect();
      const tui = new TuiRemoteCliService(client, new RemoteCliService(client));

      // BEFORE the view: no attach → the daemon hides everything (§4.5).
      const hidden = await tui.listPendingPermissions({});
      expect(hidden.requests ?? []).toEqual([]);

      // The window opens the session — the VIEW is the attach.
      await tui.getSession({ id: 's9' });

      // (a) the snapshot now shows the pending approval…
      const shown = await tui.listPendingPermissions({});
      expect((shown.requests ?? []).map((request) => request.requestId)).toEqual(['req-open']);

      // (b) …and the push (no initiator: nobody streamed a turn) reaches it.
      events.push({ type: 'permission.ask', payload: { requestId: 'req-push', sessionId: 's9', toolName: 'bash' } });
      const watch = tui.watchEvents();
      const pushSeen = await Promise.race([
        (async () => {
          for await (const event of watch) {
            if ((event as { type?: string }).type === 'permission.ask') return true;
          }
          return false;
        })(),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 3_000)),
      ]);
      expect(pushSeen).toBe(true);

      // (c) the reply re-attaches the session id the daemon's rule requires.
      await tui.replyPermission({ name: 'a', requestId: 'req-open', reply: 0 });
      expect(thisCalls.some((call) => call.method === 'replyPermission')).toBe(true);
      const reply = thisCalls.find((call) => call.method === 'replyPermission');
      expect(reply?.args[0]).toMatchObject({ requestId: 'req-open', sessionId: 's9' });

      client.close();
    } finally {
      await daemon.shutdown();
    }
  });
});
