/**
 * §4 gate mark pins: the LocalTurnPermissionGate builds the final
 * `RuntimePermissionMark` for every resolved tool call and records it on the
 * per-turn sink keyed by `toolContext.toolCall.id`.
 *
 * Rows of the §4.1 table attributable at the gate:
 *   - check-side rule/builtin/classifier (explicit decision fields — the
 *     production path — and the facade verdict-ledger fallback);
 *   - plugin hook (PreToolUse allow, PermissionRequest auto-approve, hook
 *     deny);
 *   - user replies (allow_once / allow_always / reject_once / reject_always);
 *   - unanswered (no_prompt, error, cancelled).
 *
 * Pin 4.1 (mark-shape-all-keys) walks every produced mark: exactly the five
 * wire keys, `reason` non-empty.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LocalTurnPermissionGate,
  createLocalTurnPermissionMarkSink,
  type LocalTurnPermissionDecision,
  type LocalTurnPermissionMarkSink,
} from '../../../src/service/turn-system/agent-host/runner/policy/local-turn-permission-gate.js';
import {
  localPermissionVerdictKey,
  recordLocalPermissionVerdict,
  resetLocalPermissionVerdictLedger,
  takeLocalPermissionVerdict,
} from '@mavis/local-runtime';
import type { RuntimePermissionMark } from '@mavis/agent-core/protocol/runtime-event';

type Reply = 'allowOnce' | 'allowAlways' | 'deny' | 'denyAlways';

interface GateHarness {
  gate: LocalTurnPermissionGate;
  sink: LocalTurnPermissionMarkSink;
  approval: ReturnType<typeof vi.fn>;
  check: ReturnType<typeof vi.fn>;
  beforeApproval: ReturnType<typeof vi.fn>;
  call(options?: {
    reply?: Reply | Error;
    decision?: LocalTurnPermissionDecision;
    signal?: AbortSignal;
    preToolPermission?: { behavior: 'allow' | 'ask'; reason?: string };
    pluginDecision?: {
      behavior?: 'allow' | 'deny' | 'abstain';
      autoApproval?: 'ordinary_only' | 'any_prompt';
      reason?: string;
    };
  }): Promise<ReturnType<LocalTurnPermissionGate['beforeToolCall']>>;
}

function createHarness(): GateHarness {
  const sink = createLocalTurnPermissionMarkSink();
  const check = vi.fn(
    async (): Promise<LocalTurnPermissionDecision> => ({ behavior: 'ask', reason: 'Needs approval' }),
  );
  const approval = vi.fn(async (): Promise<Reply> => 'allowOnce');
  const beforeApproval = vi.fn(async () => ({ behavior: 'abstain' as const }));
  const gate = new LocalTurnPermissionGate({
    decisions: { check },
    approval: { request: approval },
  });
  const call: GateHarness['call'] = (options = {}) => {
    check.mockImplementation(
      async () => options.decision ?? { behavior: 'ask', reason: 'Needs approval' },
    );
    approval.mockImplementation(async () => {
      if (options.reply instanceof Error) throw options.reply;
      return options.reply ?? 'allowOnce';
    });
    beforeApproval.mockImplementation(async () => options.pluginDecision ?? { behavior: 'abstain' });
    return gate.beforeToolCall({
      sessionId: 'sess-1',
      turnId: 'turn-1',
      agentName: 'mcode',
      model: 'model-1',
      toolContext: {
        toolCall: { id: 'call-1', name: 'mcp_fetch', source: 'mcp' },
        args: { url: 'https://example.com' },
      } as never,
      permissionMarks: sink,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.preToolPermission
        ? { preToolPermission: options.preToolPermission }
        : {}),
      beforeApproval,
    });
  };
  return { gate, sink, approval, check, beforeApproval, call };
}

const ALL_MARK_KEYS = ['decision', 'decidedBy', 'mode', 'reason', 'ruleKind'].sort();

/** Pin 4.1: exactly the five wire keys and a non-empty reason. */
function expectMarkShape(mark: RuntimePermissionMark | undefined): RuntimePermissionMark {
  expect(mark).toBeDefined();
  expect(Object.keys(mark!).sort()).toEqual(ALL_MARK_KEYS);
  expect(typeof mark!.reason).toBe('string');
  expect(mark!.reason.trim().length).toBeGreaterThan(0);
  return mark!;
}

describe('LocalTurnPermissionGate §4 marks', () => {
  afterEach(() => {
    resetLocalPermissionVerdictLedger();
  });

  it('mark-per-source: check-side rule with a session scope', async () => {
    const h = createHarness();
    const result = await h.call({
      decision: {
        behavior: 'allow',
        reason: 'Allowed by session rule',
        decidedBy: 'rule',
        ruleKind: 'session',
        mode: 'default',
      },
    });
    expect(result).toBeUndefined();
    expect(expectMarkShape(h.sink.get('call-1'))).toMatchObject({
      decision: 'allow',
      decidedBy: 'rule',
      ruleKind: 'session',
      mode: 'default',
      reason: 'Allowed by session rule',
    });
  });

  it('mark-per-source: check-side global deny rule', async () => {
    const h = createHarness();
    const result = await h.call({
      decision: {
        behavior: 'deny',
        reason: 'Denied by global rule',
        decidedBy: 'rule',
        ruleKind: 'global',
        mode: 'default',
      },
    });
    expect(result).toMatchObject({ block: true, blockedBy: 'permission' });
    expect(expectMarkShape(h.sink.get('call-1'))).toMatchObject({
      decision: 'deny',
      decidedBy: 'rule',
      ruleKind: 'global',
      reason: 'Denied by global rule',
    });
  });

  it('mark-per-source: builtin checker policy via explicit decision fields', async () => {
    const h = createHarness();
    await h.call({
      decision: {
        behavior: 'allow',
        reason: 'Safe bash command',
        decidedBy: 'rule',
        ruleKind: 'builtin',
        mode: 'default',
      },
    });
    expect(h.sink.get('call-1')).toMatchObject({
      decidedBy: 'rule',
      ruleKind: 'builtin',
    });
  });

  it('mark-per-source: classifier allow via explicit decision fields', async () => {
    const h = createHarness();
    await h.call({
      decision: {
        behavior: 'allow',
        reason: 'Auto-classifier allowed',
        decidedBy: 'classifier',
        ruleKind: null,
        mode: 'auto',
      },
    });
    expect(h.sink.get('call-1')).toMatchObject({
      decision: 'allow',
      decidedBy: 'classifier',
      ruleKind: null,
      mode: 'auto',
    });
  });

  it('mark-per-source: mode waiver via explicit decision fields', async () => {
    const h = createHarness();
    await h.call({
      decision: {
        behavior: 'allow',
        reason: 'Allowed under bypassPermissions',
        decidedBy: 'mode',
        ruleKind: null,
        mode: 'bypassPermissions',
      },
    });
    expect(h.sink.get('call-1')).toMatchObject({
      decision: 'allow',
      decidedBy: 'mode',
      ruleKind: null,
      mode: 'bypassPermissions',
    });
  });

  it('mark-per-source: verdict-ledger fallback for decision sources without fields', async () => {
    // Fallback for a decision source that strips the facade attribution
    // (the production hosted adapter passes it through): the facade records
    // it in the take-once ledger keyed by (sessionId, toolName, input) and
    // the gate picks it up.
    recordLocalPermissionVerdict(
      localPermissionVerdictKey('sess-1', 'mcp_fetch', { url: 'https://example.com' }),
      { decidedBy: 'rule', ruleKind: 'builtin', mode: 'default' },
    );
    const h = createHarness();
    await h.call({
      decision: { behavior: 'allow', reason: 'Allowed by builtin policy' },
    });
    expect(expectMarkShape(h.sink.get('call-1'))).toMatchObject({
      decision: 'allow',
      decidedBy: 'rule',
      ruleKind: 'builtin',
      mode: 'default',
    });
    // Take-once: the entry was consumed.
    resetLocalPermissionVerdictLedger();
  });

  it('explicit decision fields win AND drain the ledger entry (no pile-up on the primary path)', async () => {
    const key = localPermissionVerdictKey('sess-1', 'mcp_fetch', { url: 'https://example.com' });
    recordLocalPermissionVerdict(key, { decidedBy: 'rule', ruleKind: 'builtin', mode: 'default' });
    const h = createHarness();
    await h.call({
      decision: {
        behavior: 'allow',
        reason: 'Allowed by session rule',
        decidedBy: 'rule',
        ruleKind: 'session',
        mode: 'auto',
      },
    });
    expect(h.sink.get('call-1')).toMatchObject({ ruleKind: 'session', mode: 'auto' });
    expect(takeLocalPermissionVerdict(key)).toBeUndefined();
  });

  it('a malformed attribution is dropped, never failing the check', async () => {
    const h = createHarness();
    const result = await h.call({
      decision: {
        behavior: 'allow',
        reason: 'Allowed',
        decidedBy: 'rule',
        ruleKind: 'plugin',
        mode: 'default',
      } as unknown as LocalTurnPermissionDecision,
    });
    expect(result).toBeUndefined();
    expect(h.sink.get('call-1')).toBeUndefined();
  });

  it('a thrown approval wait under an aborted Turn signal is unanswered: cancelled', async () => {
    const h = createHarness();
    const controller = new AbortController();
    controller.abort();
    const result = await h.call({
      decision: { behavior: 'ask', reason: 'Needs approval', decidedBy: 'rule', ruleKind: 'builtin', mode: 'default' },
      reply: new Error('aborted'),
      signal: controller.signal,
    });
    expect(result).toMatchObject({ block: true, blockedBy: 'permission' });
    expect(h.sink.get('call-1')).toMatchObject({
      decision: 'deny',
      decidedBy: 'user',
      reason: 'unanswered: cancelled',
    });
  });

  it('omits the mark when neither decision fields nor a ledger entry exist', async () => {
    const h = createHarness();
    await h.call({
      decision: { behavior: 'allow', reason: 'Opaque decision source' },
    });
    expect(h.sink.get('call-1')).toBeUndefined();
  });

  it('mark-per-source: PreToolUse hook allow answers an eligible ask', async () => {
    const h = createHarness();
    await h.call({
      decision: {
        behavior: 'ask',
        reason: 'Needs approval',
        hookAutoApprovalEligible: true,
        decidedBy: 'rule',
        ruleKind: 'builtin',
        mode: 'default',
      },
      preToolPermission: { behavior: 'allow', reason: 'PreToolUse hook trusted this call' },
    });
    expect(h.approval).not.toHaveBeenCalled();
    expect(expectMarkShape(h.sink.get('call-1'))).toMatchObject({
      decision: 'allow',
      decidedBy: 'hook',
      ruleKind: null,
      mode: 'default',
      reason: 'PreToolUse hook trusted this call',
    });
  });

  it('mark-per-source: PermissionRequest hook auto-approval (any_prompt)', async () => {
    const h = createHarness();
    await h.call({
      decision: {
        behavior: 'ask',
        reason: 'Needs approval',
        decidedBy: 'rule',
        ruleKind: 'builtin',
        mode: 'default',
      },
      pluginDecision: { behavior: 'allow', autoApproval: 'any_prompt' },
    });
    expect(h.approval).not.toHaveBeenCalled();
    expect(expectMarkShape(h.sink.get('call-1'))).toMatchObject({
      decision: 'allow',
      decidedBy: 'hook',
      ruleKind: null,
      reason: 'plugin hook',
    });
  });

  it('mark-per-source: PermissionRequest hook deny blocks with a hook mark', async () => {
    const h = createHarness();
    const result = await h.call({
      decision: {
        behavior: 'ask',
        reason: 'Needs approval',
        decidedBy: 'rule',
        ruleKind: 'builtin',
        mode: 'default',
      },
      pluginDecision: { behavior: 'deny', reason: 'Hook forbade this tool' },
    });
    expect(result).toMatchObject({ block: true });
    expect(expectMarkShape(h.sink.get('call-1'))).toMatchObject({
      decision: 'deny',
      decidedBy: 'hook',
      ruleKind: null,
      reason: 'Hook forbade this tool',
    });
  });

  it.each([
    ['allowOnce', { decision: 'allow', decidedBy: 'user', ruleKind: null, reason: 'allow_once' }],
    ['allowAlways', { decision: 'allow', decidedBy: 'user', ruleKind: 'global', reason: 'allow_always' }],
    ['deny', { decision: 'deny', decidedBy: 'user', ruleKind: null, reason: 'reject_once' }],
    ['denyAlways', { decision: 'deny', decidedBy: 'user', ruleKind: 'global', reason: 'reject_always' }],
  ] as const)('mark-per-source: user reply %s', async (reply, expected) => {
    const h = createHarness();
    const result = await h.call({
      reply,
      decision: {
        behavior: 'ask',
        reason: 'Needs approval',
        decidedBy: 'rule',
        ruleKind: 'builtin',
        mode: 'default',
      },
    });
    if (expected.decision === 'deny') {
      expect(result).toMatchObject({ block: true });
    } else {
      expect(result).toBeUndefined();
    }
    expect(expectMarkShape(h.sink.get('call-1'))).toMatchObject({ ...expected, mode: 'default' });
  });

  it.each([
    ['no_prompt', 'HOST_CAPABILITY_UNAVAILABLE: this Runtime host cannot prompt for permission.'],
    ['error', 'approval pipeline exploded'],
  ] as const)('mark-per-source: unanswered %s', async (cause, message) => {
    const h = createHarness();
    const result = await h.call({
      reply: new Error(message),
      decision: {
        behavior: 'ask',
        reason: 'Needs approval',
        decidedBy: 'rule',
        ruleKind: 'builtin',
        mode: 'default',
      },
    });
    // Fail-closed deny instead of aborting the turn.
    expect(result).toMatchObject({ block: true, blockedBy: 'permission' });
    expect(expectMarkShape(h.sink.get('call-1'))).toMatchObject({
      decision: 'deny',
      decidedBy: 'user',
      ruleKind: null,
      mode: 'default',
      reason: `unanswered: ${cause}`,
    });
  });

  it('mark-per-source: a deny landing on an aborted signal is unanswered: cancelled', async () => {
    const h = createHarness();
    const controller = new AbortController();
    controller.abort(new Error('turn cancelled'));
    const result = await h.call({
      reply: 'deny',
      signal: controller.signal,
      decision: {
        behavior: 'ask',
        reason: 'Needs approval',
        decidedBy: 'rule',
        ruleKind: 'builtin',
        mode: 'default',
      },
    });
    expect(result).toMatchObject({ block: true });
    expect(expectMarkShape(h.sink.get('call-1'))).toMatchObject({
      decision: 'deny',
      decidedBy: 'user',
      ruleKind: null,
      mode: 'default',
      reason: 'unanswered: cancelled',
    });
  });

  it('denied-call-gets-failed-with-mark (gate half): a policy deny records the mark before blocking', async () => {
    const h = createHarness();
    const result = await h.call({
      decision: {
        behavior: 'deny',
        reason: 'Denied by global rule',
        decidedBy: 'rule',
        ruleKind: 'global',
        mode: 'default',
      },
    });
    expect(result).toMatchObject({ block: true, blockedBy: 'permission' });
    expect(expectMarkShape(h.sink.get('call-1'))).toMatchObject({ decision: 'deny', decidedBy: 'rule' });
  });

  it('keys marks by toolContext.toolCall.id across multiple calls in one turn', async () => {
    const h = createHarness();
    const decision: LocalTurnPermissionDecision = {
      behavior: 'allow',
      reason: 'Allowed',
      decidedBy: 'rule',
      ruleKind: 'builtin',
      mode: 'default',
    };
    await checkOnce(h, 'call-a', decision);
    await checkOnce(h, 'call-b', decision);
    expect(h.sink.get('call-a')).toBeDefined();
    expect(h.sink.get('call-b')).toBeDefined();
  });

  it('mark-shape-all-keys: every produced row carries exactly the five keys', async () => {
    // Collect one mark per table row and validate the shape exhaustively.
    const marks: RuntimePermissionMark[] = [];

    const allow = createHarness();
    await allow.call({
      decision: {
        behavior: 'allow',
        reason: 'rule allow',
        decidedBy: 'rule',
        ruleKind: 'global',
        mode: 'default',
      },
    });
    marks.push(allow.sink.get('call-1')!);

    const hook = createHarness();
    await hook.call({
      decision: {
        behavior: 'ask',
        reason: 'ask',
        hookAutoApprovalEligible: true,
        decidedBy: 'rule',
        ruleKind: 'builtin',
        mode: 'default',
      },
      preToolPermission: { behavior: 'allow' },
    });
    marks.push(hook.sink.get('call-1')!);

    const user = createHarness();
    await user.call({
      reply: 'allowOnce',
      decision: {
        behavior: 'ask',
        reason: 'ask',
        decidedBy: 'rule',
        ruleKind: 'builtin',
        mode: 'default',
      },
    });
    marks.push(user.sink.get('call-1')!);

    const unanswered = createHarness();
    await unanswered.call({
      reply: new Error('HOST_CAPABILITY_UNAVAILABLE: no prompt'),
      decision: {
        behavior: 'ask',
        reason: 'ask',
        decidedBy: 'rule',
        ruleKind: 'builtin',
        mode: 'default',
      },
    });
    marks.push(unanswered.sink.get('call-1')!);

    expect(marks.length).toBe(4);
    for (const mark of marks) expectMarkShape(mark);
  });
});

async function checkOnce(
  h: GateHarness,
  toolCallId: string,
  decision: LocalTurnPermissionDecision,
): Promise<void> {
  h.check.mockImplementation(async () => decision);
  await h.gate.beforeToolCall({
    sessionId: 'sess-1',
    turnId: 'turn-1',
    agentName: 'mcode',
    model: 'model-1',
    toolContext: {
      toolCall: { id: toolCallId, name: 'mcp_fetch', source: 'mcp' },
      args: { url: 'https://example.com' },
    } as never,
    permissionMarks: h.sink,
  });
}
