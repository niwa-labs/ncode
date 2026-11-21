/**
 * LocalPermissionApprovalService reply persistence pins.
 *
 * A reply settles the ask and — only for the persistent decisions — writes a
 * rule through LocalPermissionRuleStore:
 *   - allowAlways / denyAlways persist one global rule (denyAlways mirrors
 *     allowAlways, including the persistWholeToolRuleOnReply ['*'] fallback);
 *   - allowOnce / deny are strictly one-time: no rule is written, so the
 *     same call asks again;
 *   - unanswered asks (dismiss, aborted waiter) resolve to deny without
 *     writing a rule.
 */

import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { LocalPermissionApprovalService } from '../../src/api/local-permission-approval-service.js';
import { LocalPermissionRuleStore } from '../../src/permissions/rules.js';
import type { LocalPermissionRequestInput } from '../../src/api/routes/permission-request-helpers.js';

function freshService(): {
  service: LocalPermissionApprovalService;
  ruleStore: LocalPermissionRuleStore;
  dataDir: string;
} {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'aa-approval-reply-'));
  const ruleStore = new LocalPermissionRuleStore(() => dataDir);
  const service = new LocalPermissionApprovalService({
    agentName: 'mcode',
    nowMs: () => 1_000,
    permissionRules: ruleStore,
    publishGlobalEvent: () => {},
  });
  return { service, ruleStore, dataDir };
}

function askInput(overrides: Partial<LocalPermissionRequestInput> = {}): LocalPermissionRequestInput {
  return {
    sessionId: 'sess-1',
    agentName: 'mcode',
    turnId: 'turn-1',
    toolName: 'bash',
    ruleContents: ['curl https://example.com'],
    reason: 'Network call needs approval',
    ...overrides,
  };
}

function checkCall(
  ruleStore: LocalPermissionRuleStore,
  command: string,
  sessionId = 'sess-1',
): Promise<{ behavior: 'allow' | 'deny' | 'ask' }> {
  return ruleStore.check({
    toolName: 'bash',
    input: { command },
    mode: 'default',
    sessionId,
  });
}

/**
 * Re-raising the same call after a one-time reply opens a brand-new pending
 * ask: no dedupe onto the settled request, no inherited outcome. The new ask
 * is dismissed afterwards so it leaves nothing behind.
 */
async function expectFreshAsk(
  service: LocalPermissionApprovalService,
  settledRequestId: string,
): Promise<void> {
  const again = service.begin(askInput());
  expect(again.requestId).not.toBe(settledRequestId);
  expect(service.listPending().map((pending) => pending.requestId)).toEqual([again.requestId]);
  const outcome = await Promise.race([
    again.promise,
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0)),
  ]);
  expect(outcome).toBe('pending');
  expect(service.dismiss(again.requestId)).toBe(true);
  await expect(again.promise).resolves.toBe('deny');
}

describe('LocalPermissionApprovalService reply persistence', () => {
  it('reject-once-never-persists-rule', async () => {
    const { service, ruleStore, dataDir } = freshService();

    const handle = service.begin(askInput());
    const { processed } = await service.reply([handle.requestId], 'deny');
    expect(processed).toEqual([handle.requestId]);
    await expect(handle.promise).resolves.toBe('deny');

    expect(await ruleStore.listRules()).toEqual([]);
    expect(existsSync(path.join(dataDir, 'permission.json'))).toBe(false);
    // The same call in the same session asks again.
    await expect(checkCall(ruleStore, 'curl https://example.com')).resolves.toMatchObject({
      behavior: 'ask',
    });
    await expectFreshAsk(service, handle.requestId);

    const wholeTool = service.begin(
      askInput({ ruleContents: [], persistWholeToolRuleOnReply: true }),
    );
    await service.reply([wholeTool.requestId], 'deny');
    await expect(wholeTool.promise).resolves.toBe('deny');

    expect(await ruleStore.listRules()).toEqual([]);
    await expect(checkCall(ruleStore, 'rm -rf /tmp/scratch')).resolves.toMatchObject({
      behavior: 'ask',
    });
  });

  it('allow-once-never-persists-rule', async () => {
    const { service, ruleStore, dataDir } = freshService();

    const handle = service.begin(askInput());
    await service.reply([handle.requestId], 'allowOnce');
    await expect(handle.promise).resolves.toBe('allowOnce');

    expect(await ruleStore.listRules()).toEqual([]);
    expect(existsSync(path.join(dataDir, 'permission.json'))).toBe(false);
    // The same call asks again — allowOnce is strictly one-time.
    await expect(checkCall(ruleStore, 'curl https://example.com')).resolves.toMatchObject({
      behavior: 'ask',
    });
    await expectFreshAsk(service, handle.requestId);

    const wholeTool = service.begin(
      askInput({ ruleContents: [], persistWholeToolRuleOnReply: true }),
    );
    await service.reply([wholeTool.requestId], 'allowOnce');
    await expect(wholeTool.promise).resolves.toBe('allowOnce');

    expect(await ruleStore.listRules()).toEqual([]);
    await expect(checkCall(ruleStore, 'rm -rf /tmp/scratch')).resolves.toMatchObject({
      behavior: 'ask',
    });
  });

  it('reject-always-persists-global', async () => {
    const { service, ruleStore } = freshService();

    const handle = service.begin(askInput());
    await service.reply([handle.requestId], 'denyAlways');
    await expect(handle.promise).resolves.toBe('denyAlways');

    const rules = await ruleStore.listRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      source: 'global',
      destination: 'global',
      ruleBehavior: 'deny',
    });
    expect(rules[0].ruleValue).toMatchObject({
      toolName: 'bash',
      ruleContent: 'curl https://example.com',
    });
    // The same call in a brand-new session is denied without asking.
    await expect(
      checkCall(ruleStore, 'curl https://example.com', 'sess-new'),
    ).resolves.toMatchObject({ behavior: 'deny' });

    // persistWholeToolRuleOnReply with empty ruleContents falls back to ['*'].
    const wholeTool = service.begin(
      askInput({ ruleContents: [], persistWholeToolRuleOnReply: true }),
    );
    await service.reply([wholeTool.requestId], 'denyAlways');
    await expect(wholeTool.promise).resolves.toBe('denyAlways');

    const afterFallback = await ruleStore.listRules();
    expect(afterFallback).toHaveLength(2);
    expect(afterFallback[1].ruleValue).toMatchObject({ toolName: 'bash', ruleContent: '*' });
    await expect(checkCall(ruleStore, 'rm -rf /tmp/scratch', 'sess-other')).resolves.toMatchObject(
      {
        behavior: 'deny',
      },
    );

    // denyAlways with nothing to persist still denies and writes no rule.
    const bare = service.begin(askInput({ ruleContents: [] }));
    await service.reply([bare.requestId], 'denyAlways');
    await expect(bare.promise).resolves.toBe('denyAlways');
    expect(await ruleStore.listRules()).toHaveLength(2);
  });

  it('bypass-immune request never persists a rule, even on an always reply', async () => {
    const { service, ruleStore, dataDir } = freshService();

    for (const decision of ['allowAlways', 'denyAlways'] as const) {
      const handle = service.begin(
        askInput({ bypassImmune: true, persistWholeToolRuleOnReply: true }),
      );
      await service.reply([handle.requestId], decision);
      // The reply still settles the waiter with what the user chose…
      await expect(handle.promise).resolves.toBe(decision);
    }
    // …but no rule is written for an immune ask.
    expect(await ruleStore.listRules()).toEqual([]);
    expect(existsSync(path.join(dataDir, 'permission.json'))).toBe(false);

    // Control: the same always reply on an ordinary request does persist.
    const ordinary = service.begin(askInput());
    await service.reply([ordinary.requestId], 'allowAlways');
    expect(await ruleStore.listRules()).toHaveLength(1);
  });

  it('unanswered-is-deny-no-rule', async () => {
    const { service, ruleStore, dataDir } = freshService();

    // Dismissed ask (card closed on another surface).
    const dismissed = service.begin(askInput());
    expect(service.dismiss(dismissed.requestId)).toBe(true);
    await expect(dismissed.promise).resolves.toBe('deny');

    // Aborted waiter (turn signal dropped while the ask was pending).
    const aborted = service.begin(askInput({ ruleContents: ['npm test'] }), AbortSignal.abort());
    await expect(aborted.promise).resolves.toBe('deny');

    // An ACP client that errors or cancels is converted to a plain deny reply.
    const unanswered = service.begin(askInput({ ruleContents: ['git push'] }));
    await service.reply([unanswered.requestId], 'deny');
    await expect(unanswered.promise).resolves.toBe('deny');

    expect(await ruleStore.listRules()).toEqual([]);
    expect(existsSync(path.join(dataDir, 'permission.json'))).toBe(false);
    await expect(checkCall(ruleStore, 'npm test')).resolves.toMatchObject({ behavior: 'ask' });
    await expect(checkCall(ruleStore, 'git push')).resolves.toMatchObject({ behavior: 'ask' });
  });
});
