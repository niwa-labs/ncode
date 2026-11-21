import { Console } from 'node:console';
import type { Readable, Writable } from 'node:stream';

import { serveTuiAcpStdio } from '../acp/stdio.js';
import { prepareTuiDataDir } from '../runtime/data-dir.js';
import type { SystemPromptOverrides } from './system-prompt-options.js';
import type {
  CreatedTuiRuntime,
  createTuiRuntime,
  shutdownTuiRuntime,
} from '../runtime/lifecycle.js';

type TuiTerminationSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';

interface TuiAcpProcess {
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
  once(signal: TuiTerminationSignal, listener: () => void): unknown;
  off(signal: TuiTerminationSignal, listener: () => void): unknown;
  exit(code?: number): void;
}

export interface RunTuiAcpCommandDependencies {
  readonly processRef?: TuiAcpProcess;
  readonly workspaceDir?: () => string;
  readonly prepareDataDir?: typeof prepareTuiDataDir;
  readonly createRuntime?: typeof createTuiRuntime;
  readonly shutdownRuntime?: typeof shutdownTuiRuntime;
  readonly serve?: typeof serveTuiAcpStdio;
  readonly loadRuntimeLifecycle?: () => Promise<{
    createTuiRuntime: typeof createTuiRuntime;
    shutdownTuiRuntime: typeof shutdownTuiRuntime;
  }>;
}

export async function runTuiAcpCommand(
  version: string,
  dependencies: RunTuiAcpCommandDependencies = {},
  lane?: string,
  systemPromptOverrides?: SystemPromptOverrides,
  profile?: string,
  noDaemon?: boolean,
): Promise<void> {
  const processRef = dependencies.processRef ?? process;
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('ACP process is stopping.'));
  const restoreConsole = redirectConsoleOutputToStderr(processRef.stderr);
  let runtime: CreatedTuiRuntime | undefined;
  let shutdownRuntime = dependencies.shutdownRuntime;
  processRef.once('SIGINT', cancel);
  processRef.once('SIGTERM', cancel);
  processRef.once('SIGHUP', cancel);
  try {
    const lifecycle =
      dependencies.createRuntime && dependencies.shutdownRuntime
        ? {
            createTuiRuntime: dependencies.createRuntime,
            shutdownTuiRuntime: dependencies.shutdownRuntime,
          }
        : await (dependencies.loadRuntimeLifecycle ?? (() => import('../runtime/lifecycle.js')))();
    const createRuntime = dependencies.createRuntime ?? lifecycle.createTuiRuntime;
    shutdownRuntime ??= lifecycle.shutdownTuiRuntime;
    const dataDir = await (dependencies.prepareDataDir ?? prepareTuiDataDir)();
    runtime = await createRuntime({
      dataDir,
      workspaceDir: (dependencies.workspaceDir ?? (() => process.cwd()))(),
      version,
      surface: 'acp',
      ...(lane ? { lane } : {}),
      ...(profile ? { profile } : {}),
      ...(noDaemon ? { noDaemon: true } : {}),
      ...(systemPromptOverrides ? { systemPromptOverrides } : {}),
    });
    await (dependencies.serve ?? serveTuiAcpStdio)({
      runtime: runtime.adapter,
      version,
      input: processRef.stdin,
      output: processRef.stdout,
      signal: controller.signal,
    });
  } catch (startupError) {
    // Startup failures (daemon env mismatch, dead daemon, auth) used to die
    // as an unhandled rejection: the ACP client that had ALREADY sent its
    // initialize saw silence until its own timeout. Answer that pending
    // initialize with a JSON-RPC error so integrators get the honest cause
    // immediately, then exit non-zero. The exit is explicit: the failed boot
    // leaves open handles (the remote client) that would otherwise keep this
    // process alive as a silent zombie.
    await replyStartupFailureToInitialize(processRef, startupError);
    processRef.exit(1);
  } finally {
    processRef.off('SIGINT', cancel);
    processRef.off('SIGTERM', cancel);
    processRef.off('SIGHUP', cancel);
    try {
      if (runtime && shutdownRuntime) await shutdownRuntime(runtime);
    } finally {
      restoreConsole();
    }
  }
}

function redirectConsoleOutputToStderr(stderr: Writable): () => void {
  const original = globalThis.console;
  globalThis.console = new Console({ stdout: stderr, stderr });
  return () => {
    globalThis.console = original;
  };
}

/**
 * Best-effort answer to the initialize frame a client sent while the runtime
 * was still booting. Bounded (2 s): a client that never sent it (or already
 * gave up) just sees the process exit non-zero with the stderr cause.
 */
async function replyStartupFailureToInitialize(
  processRef: {
    stdin: Readable;
    stdout: Writable;
    exitCode?: number | string | null;
  },
  startupError: unknown,
): Promise<void> {
  const cause =
    startupError instanceof Error ? startupError.message : String(startupError);
  try {
    // process.stdin is paused until something reads it: resume explicitly or
    // the 'data' event never fires and the bounded wait always times out.
    processRef.stdin.resume();
    const line = await new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), 2_000);
      processRef.stdin.once('data', (chunk: string) => {
        clearTimeout(timer);
        resolve(chunk.split('\n')[0] ?? undefined);
      });
      processRef.stdin.once('end', () => {
        clearTimeout(timer);
        resolve(undefined);
      });
      processRef.stdin.once('close', () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
    if (line === undefined) return;
    const request = JSON.parse(line) as { id?: unknown; method?: unknown };
    if (request.id === undefined || request.method !== 'initialize') return;
    processRef.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32000,
          message: `MCODE ACP startup failed: ${cause}`,
        },
      })}\n`,
    );
  } catch {
    // The reply is best-effort; the stderr cause and the non-zero exit remain.
  }
}
