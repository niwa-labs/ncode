/**
 * Remote execution environment → tool gateway adapter (W08 PORT-PI-1.3).
 *
 * Plan §4 :511: pi-env adds an ENVIRONMENT ADAPTER to the same gateway — the
 * bash tool definition, permission path, effect checkpoint, and cancellation
 * stay exactly the product ones; only the `operations` backend swaps from the
 * local spawn to a (local or remote) pi `ExecutionEnv`. The `BashOperations`
 * shape mirrors pi coding-agent `core/tools/bash.ts` structurally (documented:
 * "Override these to delegate command execution to remote systems").
 *
 * Fail-closed mapping:
 *   * abort signal → chord `Context` cancellation (`withAbortSignal`), so a
 *     cancelled turn kills only this command remotely, exactly like locally.
 *   * `timeout` passes through in seconds (both surfaces are seconds).
 *   * `env` replaces the remote environment by default (`inheritEnv: false`),
 *     matching the local spawn semantics where the sanitized env is exact.
 *   * error `Result`s are thrown: local operations throw too, and the tool's
 *     own error funnel produces the model-facing result — no silent success.
 */
import { withAbortSignal, BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';

/** Structural mirror of pi coding-agent `BashOperations` (kept local so this package does not depend on pi-coding-agent). */
export interface GatewayBashOperations {
  exec: (
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      /** Seconds, mirroring pi bash semantics. */
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ) => Promise<{ exitCode: number | null }>;
}

export interface RemoteBashOperationsOptions {
  /**
   * `true` merges `env` over the remote shell environment (pi `inheritEnv`);
   * default `false` — the provided env is the exact child environment, like
   * the local spawn path.
   */
  inheritEnv?: boolean;
}

export function createRemoteBashOperations(
  env: ExecutionEnv,
  options: RemoteBashOperationsOptions = {},
): GatewayBashOperations {
  return {
    async exec(command, cwd, execOptions) {
      if (execOptions.signal?.aborted) {
        throw new Error('aborted');
      }
      const context: Context = execOptions.signal
        ? withAbortSignal(execOptions.signal, BACKGROUND_CONTEXT)
        : BACKGROUND_CONTEXT;
      const result = await env.exec(
        command,
        {
          cwd,
          ...(execOptions.env !== undefined
            ? { env: envRecordFrom(execOptions.env) }
            : {}),
          inheritEnv: options.inheritEnv === true,
          ...(execOptions.timeout !== undefined ? { timeout: execOptions.timeout } : {}),
          onOutput: (text) => {
            execOptions.onData(Buffer.from(text, 'utf8'));
          },
        },
        context,
      );
      if (!result.ok) {
        throw result.error;
      }
      return { exitCode: result.value.exitCode };
    },
  };
}

function envRecordFrom(processEnv: NodeJS.ProcessEnv): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(processEnv)) {
    if (typeof value === 'string') record[key] = value;
  }
  return record;
}
