import type { PiBeforeToolCallHook, PiTurnRunnerLogger } from '@mavis/agent-core/pi-turn-runner';
import type {
  RuntimePermissionMark,
  TurnPermissionMarkSource,
} from '@mavis/agent-core/protocol/runtime-event';
import type { PluginHookPermissionUpdate } from '@mavis/plugin-hooks';
import {
  localPermissionVerdictKey,
  takeLocalPermissionVerdict,
} from '@mavis/local-runtime';

import type { AgentHostChannelContext } from '../../preparation/contracts.js';
import { assertAgentHostCapabilityAvailable } from '../../empty-dependencies.js';
import {
  SIDE_SESSION_APPROVAL_REASON,
  sideSessionRequiresApproval,
} from './side-session-approval.js';

type BeforeToolCallContext = Parameters<PiBeforeToolCallHook>[0];

interface LocalTurnPermissionExecutionPlan {
  readonly originalInput: Readonly<Record<string, unknown>>;
  readonly effectiveInput: Readonly<Record<string, unknown>>;
  readonly intents: readonly unknown[];
  readonly transforms: readonly unknown[];
}

type LocalTurnPermissionRuleMatcher =
  | { readonly kind: 'tool' }
  | { readonly kind: 'command'; readonly pattern: string }
  | {
      readonly kind: 'path';
      readonly pattern: string;
      readonly actions: readonly LocalTurnPermissionRuleAction[];
    };

type LocalTurnPermissionRuleAction = 'read' | 'write' | 'delete' | 'execute' | 'network';

export type LocalTurnPermissionDecision =
  | {
      readonly behavior: 'allow';
      readonly reason: string;
      readonly executionPlan?: Readonly<LocalTurnPermissionExecutionPlan>;
      /** §4 mark attribution (see {@link LocalTurnPermissionMarkAttribution}). */
      readonly decidedBy?: LocalTurnPermissionMarkAttribution['decidedBy'];
      readonly ruleKind?: LocalTurnPermissionMarkAttribution['ruleKind'];
      readonly mode?: LocalTurnPermissionMarkAttribution['mode'];
    }
  | {
      readonly behavior: 'deny';
      readonly reason: string;
      readonly decidedBy?: LocalTurnPermissionMarkAttribution['decidedBy'];
      readonly ruleKind?: LocalTurnPermissionMarkAttribution['ruleKind'];
      readonly mode?: LocalTurnPermissionMarkAttribution['mode'];
    }
  | {
      readonly behavior: 'ask';
      readonly reason: string;
      readonly ruleContents?: readonly string[];
      readonly ruleMatchers?: readonly LocalTurnPermissionRuleMatcher[];
      readonly executionPlan?: Readonly<LocalTurnPermissionExecutionPlan>;
      /** Only ordinary fallback prompts may be answered by a compatible Hook. */
      readonly hookAutoApprovalEligible?: boolean;
      /**
       * Bypass-immune ask ("неотключаемый", §3): no mode may silently
       * auto-allow it and no Hook — including `any_prompt` auto-approval or a
       * PreToolUse allow — may answer it on the user's behalf. Only the user
       * replies (one-time allow/deny; the approval surface offers no
       * allow-always / deny-always).
       */
      readonly bypassImmune?: true;
      readonly decidedBy?: LocalTurnPermissionMarkAttribution['decidedBy'];
      readonly ruleKind?: LocalTurnPermissionMarkAttribution['ruleKind'];
      readonly mode?: LocalTurnPermissionMarkAttribution['mode'];
    };

/**
 * §4 check-side mark attribution carried on every decision variant. A
 * decision source that fills these fields wins; the gate otherwise falls
 * back to the facade's per-process verdict ledger (see
 * `local-runtime/src/permissions/verdict-ledger.ts`) — and a decision with
 * neither source of attribution emits no wire mark at all.
 */
export interface LocalTurnPermissionMarkAttribution {
  readonly decidedBy: 'classifier' | 'rule' | 'mode';
  readonly ruleKind: RuntimePermissionMark['ruleKind'];
  readonly mode: RuntimePermissionMark['mode'];
}

/**
 * Per-turn §4 mark store: the gate records one `RuntimePermissionMark` per
 * resolved tool call (key: `toolContext.toolCall.id`) and the event bridge
 * reads them to stamp the `permission` field onto every status event of
 * that call. Created fresh per Turn by the execution preparation, so the
 * map dies with the Turn — no explicit cleanup is needed.
 */
export interface LocalTurnPermissionMarkSink
  extends Pick<TurnPermissionMarkSource, 'get'> {
  record(toolCallId: string, mark: RuntimePermissionMark): void;
}

export function createLocalTurnPermissionMarkSink(): LocalTurnPermissionMarkSink {
  const marks = new Map<string, RuntimePermissionMark>();
  return {
    record: (toolCallId, mark) => {
      marks.set(toolCallId, mark);
    },
    get: (toolCallId) => marks.get(toolCallId),
  };
}

export interface LocalTurnPermissionDecisionSource {
  check(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly agentName: string;
    readonly model: string;
    readonly toolName: string;
    readonly toolInput: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
    readonly channelContext?: AgentHostChannelContext;
    readonly trustedExactWritePaths: readonly string[];
  }): Promise<LocalTurnPermissionDecision>;
}

export interface LocalTurnPermissionApprovalOwner {
  request(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly agentName: string;
    readonly model: string;
    readonly toolName: string;
    readonly toolInput: Readonly<Record<string, unknown>>;
    readonly reason: string;
    readonly ruleContents: readonly string[];
    readonly ruleMatchers?: readonly LocalTurnPermissionRuleMatcher[];
    readonly signal?: AbortSignal;
    readonly channelContext?: AgentHostChannelContext;
    /** Bypass-immune ask: the surfaced question is one-time allow/deny only. */
    readonly bypassImmune?: true;
  }): Promise<'allowOnce' | 'allowAlways' | 'deny' | 'denyAlways'>;
}

export interface LocalTurnPermissionMutationOwner {
  applyAtomic(input: {
    readonly sessionId: string;
    readonly cwd: string;
    readonly updates: readonly PluginHookPermissionUpdate[];
    readonly signal?: AbortSignal;
  }): Promise<void>;
  clearSession(sessionId: string): Promise<void>;
}

export interface LocalTurnPermissionGateOptions {
  readonly decisions: LocalTurnPermissionDecisionSource;
  readonly approval?: LocalTurnPermissionApprovalOwner;
  readonly executionPlans?: {
    snapshotInput(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
    validate(
      plan: unknown,
      originalInput: Readonly<Record<string, unknown>>,
    ): Readonly<LocalTurnPermissionExecutionPlan>;
  };
  readonly logger?: PiTurnRunnerLogger;
  readonly mutations?: LocalTurnPermissionMutationOwner;
  /** Optional isolated-host override; product hosts keep Desktop's built-in tool policy. */
  readonly enforceBuiltinTools?: boolean;
  /**
   * Resolves whether a Session is a temporary side Session (`/btw` / Peek).
   * A mutation-capable tool there always requires one explicit user approval,
   * regardless of the current permission mode, because the parent Turn may
   * still be writing to the same workspace.
   */
  readonly sideSessions?: {
    isSideSession(sessionId: string): Promise<boolean>;
  };
}

type PermissionExecutionPlanPort = NonNullable<LocalTurnPermissionGateOptions['executionPlans']>;

interface PermissionToolRequest {
  readonly toolCallId: string;
  readonly toolName: string;
  /** Catalog-owned provenance; never inferred from a user-configured tool name. */
  readonly toolSource: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
}

interface BeforeToolCallInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly agentName: string;
  readonly model: string;
  readonly cwd?: string;
  readonly toolContext: BeforeToolCallContext;
  readonly signal?: AbortSignal;
  readonly channelContext?: AgentHostChannelContext;
  readonly trustedExactWritePaths?: readonly string[];
  /** Per-turn §4 mark sink; absent hosts get no wire marks. */
  readonly permissionMarks?: LocalTurnPermissionMarkSink;
  /** Compatible-compatible PreToolUse permission request. Policy deny always wins. */
  readonly preToolPermission?: {
    readonly behavior: 'allow' | 'ask';
    readonly reason?: string;
  };
  readonly beforeApproval?: (input: {
    readonly toolUseId: string;
    readonly toolName: string;
    readonly toolInput: Readonly<Record<string, unknown>>;
    readonly reason: string;
    readonly ruleContents: readonly string[];
    readonly signal?: AbortSignal;
  }) => Promise<{
    readonly behavior: 'allow' | 'deny' | 'abstain';
    readonly autoApproval?: 'ordinary_only' | 'any_prompt';
    readonly terminateAgent?: boolean;
    readonly reason?: string;
    readonly updatedInput?: Readonly<Record<string, unknown>>;
    readonly updatedPermissions?: readonly PluginHookPermissionUpdate[];
  }>;
}

/**
 * V2-owned permission hook orchestration. The injected decision source owns
 * policy/rules and the approval port owns pending lifecycle, dedupe, UI and
 * persisted replies; this gate owns hook ordering, plan consumption and fail-closed mapping.
 */
export class LocalTurnPermissionGate {
  constructor(private readonly options: LocalTurnPermissionGateOptions) {
    assertAgentHostCapabilityAvailable(
      'permission-decision-source',
      typeof options.decisions?.check === 'function',
    );
  }

  async beforeToolCall(input: BeforeToolCallInput): Promise<
    | {
        readonly block: true;
        readonly reason: string;
        readonly terminateAgent?: boolean;
        readonly blockedBy: 'permission';
      }
    | undefined
  > {
    const request = readPermissionToolRequest(
      input.toolContext,
      this.options.executionPlans?.snapshotInput,
    );
    // The side-Session lookup runs before the built-in bypass so that a
    // mutation-capable built-in (write/edit/bash) cannot skip the mandatory
    // side-Session confirmation.
    const sideSession = await this.resolveSideSessionApprovalRequirement(input, request);
    if (sideSession?.block) return { ...sideSession.block, blockedBy: 'permission' };
    const sideApprovalRequired = sideSession?.approvalRequired === true;
    if (shouldSkipPermissionCheck(this.options, input)) {
      // Desktop's built-in tool policy owns these tools elsewhere; the
      // side-Session confirmation is the only gate-level requirement here.
      if (!sideApprovalRequired) return undefined;
      const blocked = await this.resolveSideSessionApproval(input, request);
      return blocked ? { ...blocked, blockedBy: 'permission' } : undefined;
    }
    let decision = await checkPermissionDecision(this.options.decisions, input, request);
    if (sideApprovalRequired && decision.behavior === 'allow') {
      // A policy or mode auto-approval is not enough inside a side Session:
      // downgrade it to an ordinary ask so exactly one user approval happens.
      // Hook auto-approval eligibility is deliberately not granted. The §4
      // check attribution survives so the eventual user mark keeps its mode.
      decision = {
        behavior: 'ask',
        reason: SIDE_SESSION_APPROVAL_REASON,
        ...(decision.executionPlan ? { executionPlan: decision.executionPlan } : {}),
        ...markAttributionFields(decision),
      };
    }
    const executionPlan = readDecisionExecutionPlan(
      decision,
      request.toolInput,
      this.options.executionPlans?.validate,
    );
    const blocked = await this.resolveCheckedPermission(input, request, decision, executionPlan);
    // This trusted marker describes admission, not an error produced by tool execution.
    return blocked ? { ...blocked, blockedBy: 'permission' } : undefined;
  }

  private async resolveSideSessionApprovalRequirement(
    input: BeforeToolCallInput,
    request: PermissionToolRequest,
  ): Promise<
    | {
        readonly approvalRequired?: boolean;
        readonly block?: { readonly block: true; readonly reason: string };
      }
    | undefined
  > {
    const sideSessions = this.options.sideSessions;
    if (!sideSessions) return undefined;
    if (
      !sideSessionRequiresApproval({ toolName: request.toolName, toolSource: request.toolSource })
    )
      return undefined;
    // The lookup runs only for a tool that would need confirmation, so an
    // ordinary read in a side Session and every tool elsewhere pay nothing.
    try {
      return (await sideSessions.isSideSession(input.sessionId))
        ? { approvalRequired: true }
        : undefined;
    } catch {
      // Fail closed. A transient metadata lookup cannot prove this Session is
      // ordinary, and the unsafe alternative is an unconfirmed workspace
      // mutation racing the parent Turn.
      this.logEnforcement(input, request, {
        policy_behavior: 'deny',
        gate_result: 'blocked',
        decision_source: 'policy',
        rewrite_applied: false,
        side_session: true,
      });
      return {
        block: permissionBlock(
          request.toolName,
          `Could not verify whether this Session is a temporary side Session; ${request.toolName} was blocked before execution. Retry from the main Session.`,
          'policy',
        ),
      };
    }
  }

  /** One explicit user approval for a bypass-eligible built-in tool in a side Session. */
  private async resolveSideSessionApproval(
    input: BeforeToolCallInput,
    request: PermissionToolRequest,
  ): Promise<{ readonly block: true; readonly reason: string } | undefined> {
    const ask: Extract<LocalTurnPermissionDecision, { readonly behavior: 'ask' }> = {
      behavior: 'ask',
      reason: SIDE_SESSION_APPROVAL_REASON,
    };
    const outcome = await this.requestApprovalOutcome(input, request, ask);
    if (outcome.kind === 'unanswered') {
      // No permission check ran on this skip path, so there is no check mode
      // and the §4 mark is omitted rather than fabricated.
      this.logEnforcement(input, request, {
        policy_behavior: 'ask',
        gate_result: 'blocked',
        decision_source: 'approval_or_abort',
        approval_decision: 'deny',
        unanswered: outcome.cause,
        rewrite_applied: false,
        side_session: true,
      });
      return permissionBlock(request.toolName, SIDE_SESSION_APPROVAL_REASON, 'user');
    }
    const approval = outcome.reply;
    if (approval === 'deny' || approval === 'denyAlways') {
      this.logEnforcement(input, request, {
        policy_behavior: 'ask',
        gate_result: 'blocked',
        decision_source: 'approval_or_abort',
        approval_decision: approval,
        rewrite_applied: false,
        side_session: true,
      });
      return permissionBlock(request.toolName, SIDE_SESSION_APPROVAL_REASON, 'user');
    }
    this.logEnforcement(input, request, {
      policy_behavior: 'ask',
      gate_result: 'proceed',
      decision_source: 'user_reply',
      approval_decision: approval,
      rewrite_applied: false,
      side_session: true,
    });
    return undefined;
  }

  private async resolveCheckedPermission(
    input: BeforeToolCallInput,
    request: PermissionToolRequest,
    decision: LocalTurnPermissionDecision,
    executionPlan: Readonly<LocalTurnPermissionExecutionPlan> | undefined,
  ): Promise<
    { readonly block: true; readonly reason: string; readonly terminateAgent?: boolean } | undefined
  > {
    if (decision.behavior === 'deny') {
      this.recordPermissionMark(input, request, permissionMarkFromCheckDecision(decision));
      this.logEnforcement(input, request, {
        policy_behavior: 'deny',
        gate_result: 'blocked',
        decision_source: 'policy',
        rewrite_applied: false,
      });
      return permissionBlock(request.toolName, decision.reason, 'policy');
    }
    const approvalDecision = toApprovalDecision(decision, input.preToolPermission);
    if (!approvalDecision) {
      this.recordPermissionMark(input, request, permissionMarkFromCheckDecision(decision));
      applyExecutionPlan(input.toolContext, executionPlan);
      this.logEnforcement(input, request, {
        policy_behavior: 'allow',
        gate_result: 'proceed',
        decision_source: 'policy',
        rewrite_applied: Boolean(executionPlan?.transforms.length),
        execution_plan_present: Boolean(executionPlan),
        transform_count: executionPlan?.transforms.length ?? 0,
      });
      return undefined;
    }
    if (preToolHookAllowsWithoutApproval(input, approvalDecision)) {
      // §4: the PreToolUse allow answered the prompt — the hook decided.
      this.recordPermissionMark(
        input,
        request,
        permissionMarkFromDecision(approvalDecision, {
          decision: 'allow',
          decidedBy: 'hook',
          ruleKind: null,
          reason: input.preToolPermission?.reason?.trim() || 'plugin hook',
        }),
      );
      applyExecutionPlan(input.toolContext, executionPlan);
      this.logEnforcement(input, request, {
        policy_behavior: 'ask',
        gate_result: 'proceed',
        decision_source: 'plugin_hook',
        approval_decision: 'allow',
        rewrite_applied: Boolean(executionPlan?.transforms.length),
        execution_plan_present: Boolean(executionPlan),
        transform_count: executionPlan?.transforms.length ?? 0,
      });
      return undefined;
    }
    return this.resolvePermissionPrompt(input, request, approvalDecision, executionPlan);
  }

  private async resolvePermissionPrompt(
    input: BeforeToolCallInput,
    request: PermissionToolRequest,
    approvalDecision: Extract<LocalTurnPermissionDecision, { readonly behavior: 'ask' }>,
    executionPlan: Readonly<LocalTurnPermissionExecutionPlan> | undefined,
  ): Promise<
    { readonly block: true; readonly reason: string; readonly terminateAgent?: boolean } | undefined
  > {
    const pluginDecision = await requestPluginPermissionDecision(
      input,
      request,
      approvalDecision.reason,
      approvalRuleContents(approvalDecision, request),
    );
    const pluginBlock = toPluginBlock(request, pluginDecision);
    if (pluginBlock) {
      // §4: a PermissionRequest hook denied the call — the hook decided.
      this.recordPermissionMark(
        input,
        request,
        permissionMarkFromDecision(approvalDecision, {
          decision: 'deny',
          decidedBy: 'hook',
          ruleKind: null,
          reason: pluginBlock.reason,
        }),
      );
      this.logEnforcement(input, request, {
        policy_behavior: 'ask',
        gate_result: 'blocked',
        decision_source: 'plugin_hook',
        rewrite_applied: false,
      });
      return pluginBlock;
    }
    if (pluginDecision.updatedPermissions?.length) {
      const mutationBlock = await this.applyPluginPermissionUpdates(input, request, pluginDecision);
      if (mutationBlock) {
        this.recordPermissionMark(
          input,
          request,
          permissionMarkFromDecision(approvalDecision, {
            decision: 'deny',
            decidedBy: 'hook',
            ruleKind: null,
            reason: mutationBlock.reason,
          }),
        );
        this.logEnforcement(input, request, {
          policy_behavior: 'ask',
          gate_result: 'blocked',
          decision_source: 'plugin_hook',
          rewrite_applied: false,
        });
        return mutationBlock;
      }
    }
    if (pluginDecision.updatedInput || pluginDecision.updatedPermissions?.length) {
      return this.resolveRewrittenPermission(input, pluginDecision);
    }
    return this.resolveApproval({
      input,
      request,
      decision: approvalDecision,
      pluginDecision,
      executionPlan,
    });
  }

  private async applyPluginPermissionUpdates(
    input: BeforeToolCallInput,
    request: PermissionToolRequest,
    pluginDecision: PluginPermissionDecision,
  ): Promise<{ readonly block: true; readonly reason: string } | undefined> {
    const updates = pluginDecision.updatedPermissions;
    if (!updates?.length) return undefined;
    if (!input.cwd?.trim()) {
      return permissionBlock(
        request.toolName,
        'Plugin Hook permission update has no trusted workspace identity.',
        'policy',
      );
    }
    const owner = this.options.mutations;
    if (!owner?.applyAtomic) {
      return permissionBlock(
        request.toolName,
        'Plugin Hook requested permission updates, but this runtime cannot apply them.',
        'policy',
      );
    }
    try {
      await owner.applyAtomic({
        sessionId: input.sessionId,
        cwd: input.cwd,
        updates,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return undefined;
    } catch (error) {
      return permissionBlock(
        request.toolName,
        `Plugin Hook permission update was rejected: ${boundedPermissionError(error)}`,
        'policy',
      );
    }
  }

  private async resolveRewrittenPermission(
    input: BeforeToolCallInput,
    pluginDecision: PluginPermissionDecision,
  ): Promise<{ readonly block: true; readonly reason: string } | undefined> {
    applyHookUpdatedInput(input.toolContext, pluginDecision.updatedInput);
    const request = readPermissionToolRequest(
      input.toolContext,
      this.options.executionPlans?.snapshotInput,
    );
    const policyDecision = await checkPermissionDecision(this.options.decisions, input, request);
    const executionPlan = readDecisionExecutionPlan(
      policyDecision,
      request.toolInput,
      this.options.executionPlans?.validate,
    );
    if (policyDecision.behavior === 'deny') {
      this.recordPermissionMark(input, request, permissionMarkFromCheckDecision(policyDecision));
      this.logEnforcement(input, request, {
        policy_behavior: 'deny',
        gate_result: 'blocked',
        decision_source: 'policy_recheck',
        rewrite_applied: false,
      });
      return permissionBlock(request.toolName, policyDecision.reason, 'policy');
    }
    const approvalDecision = toApprovalDecision(policyDecision, input.preToolPermission);
    if (!approvalDecision) {
      this.recordPermissionMark(input, request, permissionMarkFromCheckDecision(policyDecision));
      applyExecutionPlan(input.toolContext, executionPlan);
      this.logEnforcement(input, request, {
        policy_behavior: 'allow',
        gate_result: 'proceed',
        decision_source: 'policy_recheck',
        rewrite_applied: Boolean(executionPlan?.transforms.length),
        execution_plan_present: Boolean(executionPlan),
        transform_count: executionPlan?.transforms.length ?? 0,
      });
      return undefined;
    }
    return this.resolveApproval({
      input,
      request,
      decision: approvalDecision,
      pluginDecision,
      executionPlan,
    });
  }

  private async resolveApproval(
    resolution: ApprovalResolutionInput,
  ): Promise<{ readonly block: true; readonly reason: string } | undefined> {
    const { input, request, decision, pluginDecision, executionPlan } = resolution;
    if (canPluginAutoApprove(pluginDecision, decision)) {
      // §4: the hook's auto-approval answered the prompt — the hook decided.
      this.recordPermissionMark(
        input,
        request,
        permissionMarkFromDecision(decision, {
          decision: 'allow',
          decidedBy: 'hook',
          ruleKind: null,
          reason: pluginDecision.reason?.trim() || 'plugin hook',
        }),
      );
      applyExecutionPlan(input.toolContext, executionPlan);
      this.logEnforcement(input, request, {
        policy_behavior: 'ask',
        gate_result: 'proceed',
        decision_source: 'plugin_hook',
        approval_decision: 'allow',
        rewrite_applied: Boolean(executionPlan?.transforms.length),
        execution_plan_present: Boolean(executionPlan),
        transform_count: executionPlan?.transforms.length ?? 0,
      });
      return undefined;
    }
    const outcome = await this.requestApprovalOutcome(input, request, decision);
    if (outcome.kind === 'unanswered') {
      // §4: no answer ever arrived — a host that cannot prompt, or a failed
      // approval owner. Fail-closed deny attributed to the user channel.
      this.recordPermissionMark(
        input,
        request,
        permissionMarkFromDecision(decision, {
          decision: 'deny',
          decidedBy: 'user',
          ruleKind: null,
          reason: `unanswered: ${outcome.cause}`,
        }),
      );
      this.logEnforcement(input, request, {
        policy_behavior: 'ask',
        gate_result: 'blocked',
        decision_source: 'approval_or_abort',
        approval_decision: 'deny',
        unanswered: outcome.cause,
        rewrite_applied: false,
      });
      return permissionBlock(request.toolName, decision.reason, 'user');
    }
    const approval = outcome.reply;
    if (approval === 'deny' || approval === 'denyAlways') {
      this.recordPermissionMark(
        input,
        request,
        permissionMarkFromDecision(decision, {
          decision: 'deny',
          decidedBy: 'user',
          ruleKind: approval === 'denyAlways' ? 'global' : null,
          reason: permissionReplyReason(approval, input),
        }),
      );
      this.logEnforcement(input, request, {
        policy_behavior: 'ask',
        gate_result: 'blocked',
        decision_source: 'approval_or_abort',
        approval_decision: approval,
        rewrite_applied: false,
      });
      return permissionBlock(request.toolName, decision.reason, 'user');
    }
    this.recordPermissionMark(
      input,
      request,
      permissionMarkFromDecision(decision, {
        decision: 'allow',
        decidedBy: 'user',
        ruleKind: approval === 'allowAlways' ? 'global' : null,
        reason: approval === 'allowAlways' ? 'allow_always' : 'allow_once',
      }),
    );
    applyExecutionPlan(input.toolContext, executionPlan);
    this.logEnforcement(input, request, {
      policy_behavior: 'ask',
      gate_result: 'proceed',
      decision_source: 'user_reply',
      approval_decision: approval,
      rewrite_applied: Boolean(executionPlan?.transforms.length),
      execution_plan_present: Boolean(executionPlan),
      transform_count: executionPlan?.transforms.length ?? 0,
    });
    return undefined;
  }

  private logEnforcement(
    input: { readonly sessionId: string; readonly turnId: string },
    request: PermissionToolRequest,
    fields: Readonly<Record<string, unknown>>,
  ): void {
    this.options.logger?.info?.(
      {
        session_id: input.sessionId,
        turn_id: input.turnId,
        tool_call_id: request.toolCallId,
        tool_name: request.toolName,
        ...fields,
      },
      'permission.enforcement',
    );
  }

  private requestApproval(
    input: {
      readonly sessionId: string;
      readonly turnId: string;
      readonly agentName: string;
      readonly model: string;
      readonly toolContext: BeforeToolCallContext;
      readonly signal?: AbortSignal;
      readonly channelContext?: AgentHostChannelContext;
    },
    request: PermissionToolRequest,
    decision: Extract<LocalTurnPermissionDecision, { readonly behavior: 'ask' }>,
  ): Promise<'allowOnce' | 'allowAlways' | 'deny' | 'denyAlways'> {
    const approval = this.options.approval;
    if (!approval || typeof approval.request !== 'function') {
      assertAgentHostCapabilityAvailable('permission-approval-owner', false);
      throw new Error('Unreachable permission approval owner validation.');
    }
    const ruleContents = approvalRuleContents(decision, request);
    return requestApproval(approval, {
      sessionId: input.sessionId,
      turnId: input.turnId,
      agentName: input.agentName,
      model: input.model,
      toolName: request.toolName,
      toolInput: request.toolInput,
      reason: decision.reason,
      ruleContents,
      ...(decision.ruleMatchers ? { ruleMatchers: decision.ruleMatchers } : {}),
      ...(decision.bypassImmune ? { bypassImmune: true } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.channelContext ? { channelContext: input.channelContext } : {}),
    });
  }

  /**
   * §4-aware approval await: a thrown owner (a host that cannot prompt at
   * all, or a broken approval pipeline) maps to an `unanswered` deny instead
   * of aborting the whole turn, matching the fail-closed §4.1 row
   * `unanswered: <no_prompt|error>`.
   */
  private async requestApprovalOutcome(
    input: BeforeToolCallInput,
    request: PermissionToolRequest,
    decision: Extract<LocalTurnPermissionDecision, { readonly behavior: 'ask' }>,
  ): Promise<
    | { readonly kind: 'reply'; readonly reply: 'allowOnce' | 'allowAlways' | 'deny' | 'denyAlways' }
    | { readonly kind: 'unanswered'; readonly cause: 'no_prompt' | 'error' | 'cancelled' }
  > {
    try {
      return { kind: 'reply', reply: await this.requestApproval(input, request, decision) };
    } catch (error) {
      // A wait torn down by the Turn's own abort was cancelled, not failed.
      if (input.signal?.aborted === true) return { kind: 'unanswered', cause: 'cancelled' };
      const message = error instanceof Error ? error.message : String(error);
      return {
        kind: 'unanswered',
        cause: isNoPromptHostError(message) ? 'no_prompt' : 'error',
      };
    }
  }

  /** §4: record the final mark for this tool call onto the per-turn sink. */
  private recordPermissionMark(
    input: BeforeToolCallInput,
    request: PermissionToolRequest,
    mark: RuntimePermissionMark | undefined,
  ): void {
    if (!mark) return;
    input.permissionMarks?.record(request.toolCallId, mark);
  }
}

/**
 * §4 mark fields carried on a decision, as a spreadable bag. Returns an
 * empty object when the decision carries no attribution (the spread must
 * not blanket the target with `undefined` keys).
 */
function markAttributionFields(
  decision: LocalTurnPermissionDecision,
): Pick<LocalTurnPermissionDecision, 'decidedBy' | 'ruleKind' | 'mode'> | Record<string, never> {
  if (decision.decidedBy === undefined) return {};
  return { decidedBy: decision.decidedBy, ruleKind: decision.ruleKind, mode: decision.mode };
}

/**
 * Wire mark for an outcome the CHECK itself decided (allow/deny without any
 * prompt): the decision's own attribution plus its rendered reason. An
 * `ask` reaching here would be a logic error upstream — no mark is
 * fabricated for it.
 */
function permissionMarkFromCheckDecision(
  decision: LocalTurnPermissionDecision,
): RuntimePermissionMark | undefined {
  if (decision.behavior === 'ask') return undefined;
  if (decision.decidedBy === undefined || decision.mode === undefined) return undefined;
  return {
    decision: decision.behavior === 'deny' ? 'deny' : 'allow',
    decidedBy: decision.decidedBy,
    ruleKind: decision.ruleKind ?? null,
    mode: decision.mode,
    // The wire parser drops a mark with an empty reason; keep it whole.
    reason: decision.reason.trim() || `${decision.decidedBy} ${decision.behavior}`,
  };
}

/**
 * Build the wire mark for a resolved call. The decision supplies the check
 * attribution (`decidedBy`/`ruleKind`/`mode`); `overrides` re-attribute the
 * outcome when someone other than the check decided (hook, user reply,
 * unanswered). Without a check mode there is no honest mark — the call
 * ships without one.
 */
function permissionMarkFromDecision(
  decision: LocalTurnPermissionDecision,
  overrides: {
    decision: RuntimePermissionMark['decision'];
    decidedBy: RuntimePermissionMark['decidedBy'];
    ruleKind: RuntimePermissionMark['ruleKind'];
    reason: string;
  },
): RuntimePermissionMark | undefined {
  if (decision.mode === undefined) return undefined;
  return {
    decision: overrides.decision,
    decidedBy: overrides.decidedBy,
    ruleKind: overrides.ruleKind,
    mode: decision.mode,
    reason: overrides.reason,
  };
}

/**
 * §4.1 reason token for a deny-side approval reply. A deny that arrives
 * with the turn signal already aborted was never answered by the user —
 * the wait was cancelled out from under the ask.
 */
function permissionReplyReason(
  reply: 'deny' | 'denyAlways',
  input: { readonly signal?: AbortSignal },
): string {
  if (input.signal?.aborted === true) return 'unanswered: cancelled';
  return reply === 'denyAlways' ? 'reject_always' : 'reject_once';
}

function isNoPromptHostError(message: string): boolean {
  return (
    message.includes('HOST_CAPABILITY_UNAVAILABLE') ||
    message.includes('permission-approval-owner')
  );
}

function preToolHookAllowsWithoutApproval(
  input: BeforeToolCallInput,
  decision: Extract<LocalTurnPermissionDecision, { readonly behavior: 'ask' }>,
): boolean {
  // A bypass-immune ask is owned by the user-facing approval flow; a
  // PreToolUse allow may not answer it even when the ask would otherwise be
  // hook-eligible.
  if (decision.bypassImmune === true) return false;
  return (
    input.preToolPermission?.behavior === 'allow' && decision.hookAutoApprovalEligible === true
  );
}

function shouldSkipPermissionCheck(
  options: LocalTurnPermissionGateOptions,
  input: BeforeToolCallInput,
): boolean {
  return (
    options.enforceBuiltinTools !== true &&
    isBuiltinTool(input.toolContext.toolCall) &&
    input.preToolPermission?.behavior !== 'ask'
  );
}

async function checkPermissionDecision(
  source: LocalTurnPermissionDecisionSource,
  input: BeforeToolCallInput,
  request: PermissionToolRequest,
): Promise<LocalTurnPermissionDecision> {
  const decision = validatePermissionDecision(
    await source.check({
      sessionId: input.sessionId,
      turnId: input.turnId,
      agentName: input.agentName,
      model: input.model,
      toolName: request.toolName,
      toolInput: request.toolInput,
      trustedExactWritePaths: [...(input.trustedExactWritePaths ?? [])],
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.channelContext ? { channelContext: input.channelContext } : {}),
    }),
  );
  return withLedgerMarkAttribution(decision, input, request);
}

/**
 * §4 attribution fallback. The production decision source (the hosted
 * capabilities adapter) passes the facade's attribution through on the
 * decision — that always wins. The facade ALSO records each final verdict
 * in a per-process ledger keyed by `(sessionId, toolName, input)` for
 * sources that strip the fields. Permission checks are strictly sequential
 * per session (pi awaits `prepareToolCall` per tool call, even in the
 * parallel batch executor), so the entry taken here right after this call's
 * check resolved is exactly this call's verdict. The entry is taken on
 * every check — including when the decision already carries the fields —
 * so the primary path drains the ledger instead of leaving it to eviction.
 */
function withLedgerMarkAttribution(
  decision: LocalTurnPermissionDecision,
  input: BeforeToolCallInput,
  request: PermissionToolRequest,
): LocalTurnPermissionDecision {
  const attribution = takeLocalPermissionVerdict(
    localPermissionVerdictKey(input.sessionId, request.toolName, request.toolInput),
  );
  if (decision.decidedBy !== undefined && decision.mode !== undefined) return decision;
  return attribution ? { ...decision, ...attribution } : decision;
}

function toApprovalDecision(
  decision: Exclude<LocalTurnPermissionDecision, { readonly behavior: 'deny' }>,
  preToolPermission: BeforeToolCallInput['preToolPermission'],
): Extract<LocalTurnPermissionDecision, { readonly behavior: 'ask' }> | undefined {
  if (decision.behavior === 'ask') {
    return {
      ...decision,
      ...(preToolPermission?.behavior === 'ask' && preToolPermission.reason
        ? { reason: preToolPermission.reason }
        : {}),
    };
  }
  if (preToolPermission?.behavior !== 'ask') return undefined;
  return {
    behavior: 'ask',
    reason: preToolPermission.reason ?? 'Plugin Hook requested approval.',
    ...(decision.executionPlan ? { executionPlan: decision.executionPlan } : {}),
  };
}

async function requestPluginPermissionDecision(
  input: BeforeToolCallInput,
  request: PermissionToolRequest,
  reason: string,
  ruleContents: readonly string[],
): Promise<PluginPermissionDecision> {
  return (
    (await input.beforeApproval?.({
      toolUseId: request.toolCallId,
      toolName: request.toolName,
      toolInput: request.toolInput,
      reason,
      ruleContents,
      ...(input.signal ? { signal: input.signal } : {}),
    })) ?? { behavior: 'abstain' }
  );
}

function approvalRuleContents(
  decision: Extract<LocalTurnPermissionDecision, { readonly behavior: 'ask' }>,
  request: PermissionToolRequest,
): readonly string[] {
  return decision.ruleContents?.length && decision.ruleContents.every(Boolean)
    ? [...decision.ruleContents]
    : deriveRuleContents(request.toolName, request.toolInput);
}

interface PluginPermissionDecision {
  readonly behavior: 'allow' | 'deny' | 'abstain';
  readonly autoApproval?: 'ordinary_only' | 'any_prompt';
  readonly terminateAgent?: boolean;
  readonly reason?: string;
  readonly updatedInput?: Readonly<Record<string, unknown>>;
  readonly updatedPermissions?: readonly PluginHookPermissionUpdate[];
}

interface ApprovalResolutionInput {
  readonly input: BeforeToolCallInput;
  readonly request: PermissionToolRequest;
  readonly decision: Extract<LocalTurnPermissionDecision, { readonly behavior: 'ask' }>;
  readonly pluginDecision: PluginPermissionDecision;
  readonly executionPlan: Readonly<LocalTurnPermissionExecutionPlan> | undefined;
}

function canPluginAutoApprove(
  pluginDecision: PluginPermissionDecision,
  productDecision: Extract<LocalTurnPermissionDecision, { readonly behavior: 'ask' }>,
): boolean {
  // Bypass-immune asks are never hook-approvable — not even by an
  // `any_prompt` auto-approval (§3: only the user answers them).
  if (productDecision.bypassImmune === true) return false;
  if (pluginDecision.behavior !== 'allow') return false;
  if (pluginDecision.autoApproval === 'any_prompt') return true;
  return (
    pluginDecision.autoApproval === 'ordinary_only' &&
    productDecision.hookAutoApprovalEligible === true
  );
}

function toPluginBlock(
  request: PermissionToolRequest,
  decision: PluginPermissionDecision,
):
  | { readonly block: true; readonly reason: string; readonly terminateAgent?: boolean }
  | undefined {
  if (decision.terminateAgent === true) {
    return {
      block: true,
      reason: decision.reason ?? `Agent stopped by Plugin Hook for ${request.toolName}`,
      terminateAgent: true,
    };
  }
  return decision.behavior === 'deny'
    ? {
        block: true,
        reason: decision.reason ?? `Permission denied by Plugin Hook for ${request.toolName}`,
      }
    : undefined;
}

function permissionBlock(
  toolName: string,
  reason: string,
  source: 'policy' | 'user',
): { readonly block: true; readonly reason: string } {
  return {
    block: true,
    reason:
      source === 'user'
        ? `Permission denied by user for ${toolName}: ${reason}`
        : `Permission denied for ${toolName}: ${reason}`,
  };
}

async function requestApproval(
  owner: LocalTurnPermissionApprovalOwner,
  input: Parameters<LocalTurnPermissionApprovalOwner['request']>[0],
): Promise<'allowOnce' | 'allowAlways' | 'deny' | 'denyAlways'> {
  return validateApprovalDecision(await owner.request(input));
}

function validatePermissionDecision(decision: unknown): LocalTurnPermissionDecision {
  if (!isPermissionDecisionObject(decision)) {
    throw new TypeError('Permission decision source returned an invalid decision.');
  }
  return withValidMarkAttribution(decision as LocalTurnPermissionDecision);
}

/**
 * §4 attribution is diagnostic, never part of the decision's validity: a
 * malformed `decidedBy` / `ruleKind` / `mode` drops the attribution (the
 * call then ships without a mark, or the ledger fills it) instead of
 * failing the whole check and the Turn with it.
 */
function withValidMarkAttribution(
  decision: LocalTurnPermissionDecision,
): LocalTurnPermissionDecision {
  const { decidedBy, ruleKind, mode } = decision;
  if (decidedBy === undefined && ruleKind === undefined && mode === undefined) return decision;
  if (
    isPermissionMarkDecidedBy(decidedBy) &&
    (ruleKind === undefined || ruleKind === null || isPermissionMarkRuleKind(ruleKind)) &&
    isPermissionMarkMode(mode)
  ) {
    return decision;
  }
  const stripped: Record<string, unknown> = { ...decision };
  delete stripped.decidedBy;
  delete stripped.ruleKind;
  delete stripped.mode;
  return stripped as LocalTurnPermissionDecision;
}

function isPermissionDecisionObject(decision: unknown): decision is Record<PropertyKey, unknown> {
  if (!decision || typeof decision !== 'object') return false;
  const behavior = Reflect.get(decision, 'behavior');
  const reason = Reflect.get(decision, 'reason');
  const executionPlan = Reflect.get(decision, 'executionPlan');
  const legacyRewrite = Reflect.get(decision, 'rewrittenInput');
  const ruleContents = Reflect.get(decision, 'ruleContents');
  const ruleMatchers = Reflect.get(decision, 'ruleMatchers');
  const hookAutoApprovalEligible = Reflect.get(decision, 'hookAutoApprovalEligible');
  const bypassImmune = Reflect.get(decision, 'bypassImmune');
  return (
    isPermissionBehavior(behavior) &&
    typeof reason === 'string' &&
    isOptionalRecord(executionPlan) &&
    legacyRewrite === undefined &&
    isOptionalRuleContents(ruleContents) &&
    isOptionalRuleMatchers(ruleMatchers, ruleContents) &&
    isOptionalBoolean(hookAutoApprovalEligible) &&
    (bypassImmune === undefined || bypassImmune === true)
  );
}

function isPermissionMarkDecidedBy(value: unknown): boolean {
  return value === 'classifier' || value === 'rule' || value === 'mode';
}

function isPermissionMarkRuleKind(value: unknown): boolean {
  return value === 'builtin' || value === 'session' || value === 'agent' || value === 'global';
}

function isPermissionMarkMode(value: unknown): boolean {
  return (
    value === 'default' ||
    value === 'auto' ||
    value === 'bypassPermissions' ||
    value === 'acceptEdits' ||
    value === 'dontAsk' ||
    value === 'off'
  );
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function isPermissionBehavior(value: unknown): value is LocalTurnPermissionDecision['behavior'] {
  return value === 'allow' || value === 'deny' || value === 'ask';
}

function isOptionalRecord(value: unknown): boolean {
  return (
    value === undefined || (Boolean(value) && typeof value === 'object' && !Array.isArray(value))
  );
}

function isOptionalRuleContents(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every((rule) => typeof rule === 'string' && Boolean(rule.trim())))
  );
}

function isOptionalRuleMatchers(value: unknown, ruleContents: unknown): boolean {
  if (value === undefined) return true;
  if (
    !Array.isArray(value) ||
    !Array.isArray(ruleContents) ||
    value.length !== ruleContents.length
  ) {
    return false;
  }
  return value.every(isRuleMatcher);
}

function isRuleMatcher(value: unknown): value is LocalTurnPermissionRuleMatcher {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const kind = Reflect.get(value, 'kind');
  if (kind === 'tool') return true;
  const pattern = Reflect.get(value, 'pattern');
  if (kind === 'command') return isNonBlankString(pattern);
  if (kind !== 'path' || !isNonBlankString(pattern)) return false;
  const actions = Reflect.get(value, 'actions');
  return isPermissionRuleActions(actions);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function isPermissionRuleActions(
  value: unknown,
): value is readonly LocalTurnPermissionRuleAction[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const validActions = new Set(['read', 'write', 'delete', 'execute', 'network']);
  return value.every((action) => typeof action === 'string' && validActions.has(action));
}

function validateApprovalDecision(
  decision: unknown,
): 'allowOnce' | 'allowAlways' | 'deny' | 'denyAlways' {
  if (
    decision !== 'allowOnce' &&
    decision !== 'allowAlways' &&
    decision !== 'deny' &&
    decision !== 'denyAlways'
  ) {
    throw new TypeError('Permission approval owner returned an invalid decision.');
  }
  return decision;
}

function readDecisionExecutionPlan(
  decision: LocalTurnPermissionDecision,
  originalInput: Readonly<Record<string, unknown>>,
  validate: PermissionExecutionPlanPort['validate'] | undefined,
): Readonly<LocalTurnPermissionExecutionPlan> | undefined {
  if (decision.behavior === 'deny' || !decision.executionPlan) return undefined;
  if (!validate) {
    assertAgentHostCapabilityAvailable('permission-execution-plan-validator', false);
    throw new Error('Unreachable permission execution-plan validator validation.');
  }
  return validate(decision.executionPlan, originalInput);
}

function applyExecutionPlan(
  context: BeforeToolCallContext,
  plan: Readonly<LocalTurnPermissionExecutionPlan> | undefined,
): void {
  if (!plan) return;
  const target = readMutableRecord(context.args);
  for (const key of Reflect.ownKeys(target)) {
    if (!Reflect.deleteProperty(target, key)) {
      throw new TypeError('Permission gate could not replace the execution input.');
    }
  }
  Object.assign(target, plan.effectiveInput);
  if (context.args !== target) Object.assign(context, { args: target });
}

function applyHookUpdatedInput(
  context: BeforeToolCallContext,
  updatedInput: Readonly<Record<string, unknown>> | undefined,
): void {
  if (!updatedInput) return;
  const target = readMutableRecord(context.args);
  for (const key of Reflect.ownKeys(target)) {
    if (!Reflect.deleteProperty(target, key)) {
      throw new TypeError('Permission gate could not replace the Hook-updated input.');
    }
  }
  Object.assign(target, updatedInput);
  if (context.args !== target) Object.assign(context, { args: target });
}

function readPermissionToolRequest(
  context: BeforeToolCallContext,
  snapshotInput: PermissionExecutionPlanPort['snapshotInput'] | undefined,
): PermissionToolRequest {
  const toolInput = readRecord(context.args);
  const request = {
    toolCallId: readToolCallField(context.toolCall, 'id'),
    toolName: readToolCallField(context.toolCall, 'name'),
    toolSource: readToolCallField(context.toolCall, 'source'),
    toolInput: snapshotInput ? snapshotInput(toolInput) : Object.freeze({ ...toolInput }),
  };
  if (
    typeof request.toolCallId !== 'string' ||
    !request.toolCallId ||
    typeof request.toolName !== 'string' ||
    !request.toolName
  ) {
    throw new TypeError('Permission tool-call identity must contain a non-empty id and name.');
  }
  return request;
}

function readToolCallField(toolCall: unknown, field: 'id' | 'name' | 'source'): string {
  if (!toolCall || typeof toolCall !== 'object') return '';
  const value = Reflect.get(toolCall, field);
  return typeof value === 'string' ? value : '';
}

function isBuiltinTool(toolCall: unknown): boolean {
  const source =
    toolCall && typeof toolCall === 'object' ? Reflect.get(toolCall, 'source') : undefined;
  return source === 'builtin' || source === 'builtin-matrix';
}

function deriveRuleContents(toolName: string, input: Readonly<Record<string, unknown>>): string[] {
  const direct =
    input.command ?? input.path ?? input.filePath ?? input.file_path ?? input.url ?? input.pattern;
  return typeof direct === 'string' && direct.trim() ? [direct.trim()] : [toolName];
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function readMutableRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function boundedPermissionError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_024);
}
