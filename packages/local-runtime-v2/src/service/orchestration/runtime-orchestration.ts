import { NativeForeground } from './native-foreground.js';
import type { runAgentLoop } from '@earendil-works/pi-agent-core';
import type { ConversationId } from '@earendil-works/pi-durable';
import type { Models } from '@earendil-works/pi-ai';
import {
  CronJobBridge,
  DurableBackgroundTaskStore,
  DurableThreadGoalStore,
  OrchestrationHosts,
  openOrchestrationHarness,
  replaceRoster,
  rosterOf,
  type OrchestrationHarness,
  type RosterMember,
} from '@mavis/durable-orchestration';
import { createLogger } from '@mavis/logging';

import type { AppDb } from '../../infra/db/client.js';
import type { SchedulerClient } from '../../infra/scheduler/index.js';
import { DurableSchedulerClient } from '../cron/orchestration/durable-scheduler-client.js';
import type { DurableSystemStores } from '../session-system/messages/history/durable-session-stores.js';
import type { PiDurableCompositionRoot } from '../session-system/messages/history/pi-durable-root.js';
import { openSessionConversationResolver } from './session-conversation-resolver.js';

const log = createLogger('mcode:orchestration');

/**
 * W10 Part A — the product composition of the W08 orchestration bridges
 * (deferred item 1 of state/w08.md part A, closure №1 "atomic scheduler
 * swap").
 *
 * The pinned pi-durable Harness opens over the runtime's ONE gated pi
 * storage (`PiDurableCompositionRoot.storage`) — the ONE durable scheduler.
 * The product bridges are exposed to the rest of the runtime through this
 * handle:
 *
 * - `goals`   — {@link DurableThreadGoalStore} (swaps the v1
 *   `SqliteThreadGoalStore` at its injection point);
 * - `backgroundTasks` — {@link DurableBackgroundTaskStore} (swaps the
 *   `SqliteLocalBackgroundTaskStore`); `resolveConversation` is REQUIRED and
 *   fail-closed (W08 review closure №2 — no root() fallback);
 * - `cron`    — {@link CronJobBridge}: every cron job's due time is ONE
 *   pi sleeping task; the product timer wheels (croner) are not constructed
 *   in this mode (see `runtime.ts` `enableScheduler` and the services.ts
 *   fail-closed guard — three schedulers never live);
 * - `roster`  — the delegation-supervisor adapter's writer
 *   (`replaceRoster`, one commit per roster update).
 *
 * W06 model runtime injection: `models` feeds the harness's BUILT-IN tasks;
 * the default absence keeps the W08 fail-closed stub (a built-in generation
 * task fails fast rather than silently running).
 *
 * @module
 */

/** Session→conversation resolution; REQUIRED (fail-closed, W08 closure №2). */
export type ConversationOfSession = (
  sessionId: string,
) => Promise<ConversationId | undefined> | ConversationId | undefined;

export interface RuntimeOrchestrationOptions {
  /** The gated pi storage of the runtime (Ш1 composition root). */
  readonly storage: PiDurableCompositionRoot;
  /** REQUIRED, fail-closed: maps a product session id to its pi conversation. */
  readonly conversationOfSession: ConversationOfSession;
  /** W06 model runtime for the harness's built-in tasks (absent = fail-closed stub). */
  readonly models?: Models;
  readonly nativeForeground?: boolean;
  /** Host clock; every process opening the storage must share one clock. */
  readonly nowMs?: () => number;
  /**
   * Daemon alarm seam (W08 `onWake`): the host calls `resume()` on its
   * wakeup; without it the scheduler arms its own in-process timers.
   */
  readonly onWake?: (wake: { readonly active: boolean; readonly at?: number }) => void;
  /** Host timers (default `setTimeout`); tests pass a manual clock. */
  readonly setTimer?: (
    callback: () => void,
    delayMs: number,
    options: { readonly background: boolean },
  ) => (() => void) | undefined;
}

export interface RuntimeOrchestration {
  /** The ONE durable scheduler (pinned pi harness over our storage). */
  readonly harness: OrchestrationHarness;
  readonly foregroundLoop?: (sessionId: string) => typeof runAgentLoop;
  /** Host-intent ports (cron fire/nextFire registered by the cron composition). */
  readonly hosts: OrchestrationHosts;
  /** Durable thread-goal store (v1 `SqliteThreadGoalStore` swap). */
  readonly goals: DurableThreadGoalStore;
  /** Durable background-task store (v1 `SqliteLocalBackgroundTaskStore` swap). */
  readonly backgroundTasks: DurableBackgroundTaskStore;
  /** The cron wake bridge (durable WHEN of every cron job). */
  readonly cron: CronJobBridge;
  /** Delegation-supervisor adapter writer: replace the whole roster in one commit. */
  replaceRoster(conversationId: ConversationId, members: readonly RosterMember[]): Promise<void>;
  /** Current roster of a conversation. */
  rosterOf(conversationId: ConversationId): Promise<readonly RosterMember[]>;
  /** Resolves a session to its pi conversation (fail-closed: throws when unmapped). */
  requireConversation(sessionId: string): Promise<ConversationId>;
  /** Closes the harness (seals admission, settles, closes storage ownership). */
  close(): Promise<void>;
}

/**
 * Opens the runtime orchestration over the ONE gated pi storage. Fails
 * closed: without `conversationOfSession` nothing is opened — the bridges
 * would silently collapse sessions into one root conversation.
 */
export async function openRuntimeOrchestration(
  options: RuntimeOrchestrationOptions,
): Promise<RuntimeOrchestration> {
  if (options.conversationOfSession === undefined) {
    throw new Error(
      'openRuntimeOrchestration requires conversationOfSession: the product composition must map owner sessions to conversations (fail-closed, no root() fallback)',
    );
  }
  const startedMs = Date.now();
  const foreground = options.nativeForeground ? new NativeForeground(options.models) : undefined;
  const models = foreground?.models ?? options.models;
  const harness = await openOrchestrationHarness({
    storage: options.storage.storage as never,
    ...(options.nowMs !== undefined ? { now: options.nowMs } : {}),
    ...(models ? { models } : {}),
    // The existing product transport owns physical provider retries and quota waits.
    ...(foreground ? { settings: { retry: { enabled: false } } } : {}),
    ...(options.onWake !== undefined ? { onWake: options.onWake } : {}),
    ...(options.setTimer !== undefined ? { setTimer: options.setTimer } : {}),
  });
  // The hosts the registry's task definitions are bound to — the harness's
  // OWN instance (a separately created OrchestrationHosts would be an orphan:
  // the wake/background definitions would fault with "no cron host bound").
  const hosts = harness.hosts;
  const goals = new DurableThreadGoalStore({
    harness,
    conversationOfSession: options.conversationOfSession,
    ...(options.nowMs !== undefined ? { now: options.nowMs } : {}),
  });
  const backgroundTasks = new DurableBackgroundTaskStore({
    harness,
    resolveConversation: requireResolved(options.conversationOfSession),
    ...(options.nowMs !== undefined ? { now: options.nowMs } : {}),
  });
  const cron = new CronJobBridge({ harness, hosts });
  log.info('runtime orchestration opened', {
    bridgedConversationId: options.storage.bridgedConversationId,
    durationMs: Date.now() - startedMs,
  });
  return {
    harness,
    ...(foreground ? {
      foregroundLoop: (sessionId: string) => foreground.loop(harness, async () => {
        const id = await options.conversationOfSession(sessionId);
        const conversation = id === undefined ? undefined : await harness.pi.conversation(id, harness.context);
        if (!conversation) throw new Error('Native foreground session has no conversation');
        return conversation;
      }),
    } : {}),
    hosts,
    goals,
    backgroundTasks,
    cron,
    replaceRoster: (conversationId, members) => replaceRoster(harness, conversationId, members),
    rosterOf: (conversationId) => rosterOf(harness, conversationId),
    requireConversation: async (sessionId) => {
      const conversationId = await options.conversationOfSession(sessionId);
      if (conversationId === undefined) {
        throw new Error(
          `Session ${sessionId} is not mapped to a pi conversation (fail-closed conversation resolution)`,
        );
      }
      return conversationId;
    },
    close: async () => {
      await harness.close();
      log.info('runtime orchestration closed');
    },
  };
}

function requireResolved(resolve: ConversationOfSession): (sessionId: string) => Promise<ConversationId> {
  return async (sessionId: string) => {
    const conversationId = await resolve(sessionId);
    if (conversationId === undefined) {
      throw new Error(
        `Session ${sessionId} is not mapped to a pi conversation (fail-closed conversation resolution)`,
      );
    }
    return conversationId;
  };
}

// ---------------------------------------------------------------------------
// The runtime composition entry (services.ts Ш1 → orchestration → cron swap)
// ---------------------------------------------------------------------------

export interface OpenDurableRuntimeOrchestrationOptions {
  /**
   * The SYSTEM log of this runtime (owner decision 2026-11-18): the
   * orchestration harness, its session→conversation map and the cron bridge
   * live on the daemon-owned shared log — per-session embedded runtimes open
   * no orchestration at all.
   */
  readonly durableSystem: DurableSystemStores;
  readonly nativeForeground?: boolean;
  readonly db: AppDb;
  readonly nowMs: () => number;
  readonly metrics?: { counter?(name: string, delta?: number, labels?: Record<string, string>): void };
  /** Daemon alarm seam (passed to the harness `onWake`). */
  readonly onWake?: (wake: { readonly active: boolean; readonly at?: number }) => void;
  /** Host timers (default `setTimeout`); tests pass a manual clock. */
  readonly setTimer?: (
    callback: () => void,
    delayMs: number,
    options: { readonly background: boolean },
  ) => (() => void) | undefined;
}

/** The composed orchestration plus its swapped cron scheduler client. */
export interface DurableRuntimeOrchestration {
  readonly orchestration: RuntimeOrchestration;
  /** The {@link SchedulerClient} over the CronJobBridge (the swapped timer). */
  readonly scheduler: SchedulerClient;
}

/**
 * The product composition the W08 deferred item 1 asks for, in one place:
 * fail-closed session→conversation resolver → orchestration harness over the
 * ONE gated storage → the goal/background/cron/roster bridges → the
 * {@link DurableSchedulerClient} bound to the bridge hosts (the atomic
 * cron-timer swap).
 */
export async function openDurableRuntimeOrchestration(
  options: OpenDurableRuntimeOrchestrationOptions,
): Promise<DurableRuntimeOrchestration> {
  const conversations = openSessionConversationResolver({ root: options.durableSystem.pi });
  const orchestration = await openRuntimeOrchestration({
    storage: options.durableSystem.pi,
    nativeForeground: options.nativeForeground,
    conversationOfSession: (sessionId) => conversations.conversationOfSession(sessionId),
    nowMs: options.nowMs,
    ...(options.onWake !== undefined ? { onWake: options.onWake } : {}),
    ...(options.setTimer !== undefined ? { setTimer: options.setTimer } : {}),
  });
  const scheduler = new DurableSchedulerClient({
    db: options.db,
    bridge: orchestration.cron,
    ...(options.metrics ? { metrics: options.metrics as never } : {}),
    nowMs: options.nowMs,
  });
  scheduler.bindCronHost(orchestration.hosts);
  return { orchestration, scheduler };
}
