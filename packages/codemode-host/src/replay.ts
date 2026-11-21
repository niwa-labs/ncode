/**
 * Deterministic replay (W07 part B, plan :185 «deterministic replay входят в
 * слой целиком»; T :775 «replay safe/never»).
 *
 * `CodemodeSandboxBase.start()` executes a script on a VM whose clock starts at
 * `startedAt`, whose `Math.random()` is seeded, and whose ONLY inputs are the
 * declared tools and the call outcomes the host delivers (`CodemodeRun.deliver`).
 * A recorded exchange therefore reproduces the script's result without touching
 * a tool again (codemode runtime/vm.ts :24–36).
 *
 * Classification is explicit and honest:
 * - `safe` — every issued call has a recorded outcome and the declared tool
 *   identities (jsNames) are unchanged; replay answers calls from the
 *   recording; the gateway executes nothing.
 * - `never` — at least one call has NO recorded outcome (a cancelled or
 *   interrupted call whose effect state is `TOOL_OUTCOME_UNKNOWN`). Replaying
 *   would fabricate an outcome for a call that may have had side effects.
 *   `TOOL_OUTCOME_UNKNOWN` (the speculation outcome vocabulary) and `never`
 *   are distinct: the former is what the SPECULATOR sees about an unknown
 *   effect; the latter is the replay verdict this host issues for it.
 */

import {
  type CodemodeHostCall,
  type CodemodeOutcome,
  type CodemodeResult,
  CodemodeSandboxBase,
  type CodemodeRun,
  type CodemodeRunOptions,
  toCodemodeIdentifier,
} from '@earendil-works/pi-codemode';

import type { CallableToolDeclaration } from './nested-tools.js';

/** One answered call in a recording. */
export interface RecordedCall {
  readonly id: number;
  readonly target: 'tool' | 'global';
  readonly name: string;
  readonly args: unknown;
  readonly outcome: CodemodeOutcome;
}

export interface CodemodeRecording {
  readonly code: string;
  /** The VM clock's start, in ms since the epoch. */
  readonly startedAt: number;
  /** Seeded randomness. */
  readonly seed: number;
  readonly declaredTools: readonly { name: string; jsName: string }[];
  readonly declaredGlobals: readonly { name: string }[];
  readonly calls: readonly RecordedCall[];
  /** VM fingerprint from the recording run, when the run reported it. */
  readonly fingerprint?: string;
}

export type ReplayVerdict =
  | { readonly kind: 'safe' }
  | { readonly kind: 'never'; readonly reason: 'tool-outcome-unknown' | 'declaration-drift' };

/**
 * Whether a recording can be replayed. `declaration-drift` fires when the
 * current callable set would rename a tool under a resumed script (the
 * `CodemodeDeclaredTool.jsName` rule, codemode types.ts :179–182).
 */
export function classifyReplay(
  recording: CodemodeRecording,
  currentTools?: readonly CallableToolDeclaration[],
): ReplayVerdict {
  if (recording.calls.some((call) => call.outcome === undefined)) {
    return { kind: 'never', reason: 'tool-outcome-unknown' };
  }
  if (currentTools) {
    for (const declared of recording.declaredTools) {
      const current = currentTools.find((tool) => tool.name === declared.name);
      if (!current) return { kind: 'never', reason: 'declaration-drift' };
      if (toCodemodeIdentifier(current.name) !== declared.jsName) {
        return { kind: 'never', reason: 'declaration-drift' };
      }
    }
  }
  return { kind: 'safe' };
}

export interface RecordingRunOptions {
  readonly startedAt?: number;
  readonly seed?: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly onStarted?: (fingerprint: string) => void;
}

/**
 * Run a script while recording every call and answer. The invoker runs on the
 * gateway; its outcomes are recorded verbatim.
 */
export function startRecordingRun(
  sandbox: CodemodeSandboxBase,
  code: string,
  tools: readonly CallableToolDeclaration[],
  invoker: (call: CodemodeHostCall, signal: AbortSignal | undefined) => Promise<CodemodeOutcome>,
  options: RecordingRunOptions = {},
): { run: CodemodeRun; recording: Promise<CodemodeRecording> } {
  const calls: RecordedCall[] = [];
  let fingerprint: string | undefined;
  const startedAt = options.startedAt ?? Date.now();
  const seed = options.seed ?? 0;
  const run = sandbox.start(code, {
    startedAt,
    seed,
    tools: tools.map((tool) => ({ name: tool.name })),
    signal: options.signal,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    onStarted: (value) => {
      fingerprint = value;
      options.onStarted?.(value);
    },
    onCall: (call) => {
      // Answers are delivered in call order (seq 1,2,... without gaps); each
      // call is executed through the invoker exactly once.
      const seq = calls.length + 1;
      invoker(call, options.signal)
        .then((outcome) => {
          calls.push({ id: call.id, target: call.target, name: call.name, args: call.args, outcome });
          run.deliver(seq, Date.now(), call.id, outcome);
        })
        .catch((error: unknown) => {
          calls.push({
            id: call.id,
            target: call.target,
            name: call.name,
            args: call.args,
            outcome: { ok: false, message: error instanceof Error ? error.message : String(error) },
          });
          run.deliver(seq, Date.now(), call.id, {
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          });
        });
    },
  });
  const recording: Promise<CodemodeRecording> = run.result.then(
    () =>
      ({
        code,
        startedAt,
        seed,
        declaredTools: tools.map((tool) => ({ name: tool.name, jsName: toCodemodeIdentifier(tool.name) })),
        declaredGlobals: [],
        calls: [...calls],
        ...(fingerprint !== undefined ? { fingerprint } : {}),
      }) satisfies CodemodeRecording,
  );
  return { run, recording };
}

export interface ReplayOutcome {
  readonly verdict: ReplayVerdict;
  /** Set when `verdict.kind === 'safe'` and the replay was run. */
  readonly result?: CodemodeResult;
}

/**
 * Replay a recording: calls are answered from the recording, never executed.
 * Argument drift makes the replay fail loudly — a recording belongs to exactly
 * one script and one call sequence.
 */
export function replayRecording(
  sandbox: CodemodeSandboxBase,
  recording: CodemodeRecording,
  currentTools?: readonly CallableToolDeclaration[],
): Promise<ReplayOutcome> {
  const verdict = classifyReplay(recording, currentTools);
  if (verdict.kind !== 'safe') return Promise.resolve({ verdict });
  return new Promise<ReplayOutcome>((resolve) => {
    let seq = 0;
    const run = sandbox.start(recording.code, {
      startedAt: recording.startedAt,
      seed: recording.seed,
      tools: recording.declaredTools.map((tool) => ({ name: tool.name, jsName: tool.jsName })),
      onStarted: (fingerprint) => {
        if (recording.fingerprint !== undefined && fingerprint !== recording.fingerprint) {
          // A different VM must not replay a recording it cannot reproduce.
          resolve({ verdict: { kind: 'never', reason: 'declaration-drift' } });
          void run.result.catch(() => undefined);
        }
      },
      onCall: (call) => {
        seq += 1;
        const recorded = recording.calls.find((candidate) => candidate.id === call.id);
        if (!recorded) {
          resolve({ verdict: { kind: 'never', reason: 'tool-outcome-unknown' } });
          return;
        }
        if (JSON.stringify(call.args) !== JSON.stringify(recorded.args)) {
          throw new Error(`Replay drift: call ${call.id} arguments differ from the recording`);
        }
        run.deliver(seq, recording.startedAt, call.id, recorded.outcome);
      },
    });
    void run.result.then(
      (result) => resolve({ verdict, result }),
      () => resolve({ verdict: { kind: 'never', reason: 'tool-outcome-unknown' } }),
    );
  });
}

export type { CodemodeRunOptions };
