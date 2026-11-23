import { spawn } from 'node:child_process';

import { buildSpawnCommand, type ResolvedCli } from './cli-resolver.js';
import { NCODE_INSTALL_HINT, NcodeError, NcodeNotFoundError, NcodeVersionError } from './errors.js';

/** Oldest supported Ncode release. Ncode has its own version sequence. */
export const MIN_CLI_VERSION = '0.1.2';

const VERSION_TIMEOUT_MS = 30_000;

export interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease?: string;
}

export function parseVersion(text: string): ParsedVersion | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/u.exec(text);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    ...(match[4] ? { prerelease: match[4] } : {}),
  };
}

/**
 * Compares only `major.minor.patch`. Preview builds such as `0.1.2-preview.N` satisfy `0.1.2`
 * because the preview channel ships the same exec contract as its release line.
 */
export function satisfiesMinimum(version: ParsedVersion, minimum: ParsedVersion): boolean {
  if (version.major !== minimum.major) return version.major > minimum.major;
  if (version.minor !== minimum.minor) return version.minor > minimum.minor;
  return version.patch >= minimum.patch;
}

/** Runs `ncode --version` and rejects CLIs older than {@link MIN_CLI_VERSION}. */
export async function checkCliVersion(
  cli: ResolvedCli,
  env: Readonly<Record<string, string | undefined>>,
  spawnChild: typeof spawn = spawn,
): Promise<string> {
  const output = await readVersionOutput(cli, env, spawnChild);
  // The MCode and Pi lines identify the components bundled into Ncode.
  const version = /^Ncode (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\r?$/mu.exec(output)?.[1];
  const minimum = parseVersion(MIN_CLI_VERSION) as ParsedVersion;
  if (!version) {
    throw new NcodeVersionError(
      `Could not read the ncode version from: ${output.trim() || '(empty)'}.`,
    );
  }
  if (!satisfiesMinimum(parseVersion(version) as ParsedVersion, minimum)) {
    throw new NcodeVersionError(
      `ncode ${version} is older than the minimum ${MIN_CLI_VERSION} required by @niwa-labs/ncode-sdk. Upgrade with \`${NCODE_INSTALL_HINT}\`.`,
      { version },
    );
  }
  return version;
}

function readVersionOutput(
  cli: ResolvedCli,
  env: Readonly<Record<string, string | undefined>>,
  spawnChild: typeof spawn,
): Promise<string> {
  const command = buildSpawnCommand(cli, ['--version']);
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const child = spawnChild(command.command, command.args, {
      env: env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    // Attach before any use of stdio. A failed spawn (EMFILE) emits 'error' on the next tick
    // with null pipes; touching stdout first throws and leaves that event unhandled.
    child.once('error', (error: NodeJS.ErrnoException) => {
      finish(() => {
        reject(
          error.code === 'ENOENT' || error.code === 'EACCES'
            ? new NcodeNotFoundError(`Could not start ncode at ${cli.path}.`, { cause: error })
            : error,
        );
      });
    });
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }, VERSION_TIMEOUT_MS);
    if (!child.stdout || !child.stderr) {
      finish(() => {
        reject(new NcodeError('ncode stdout is unavailable.'));
      });
      return;
    }
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('close', (code, signal) => {
      finish(() => {
        if (code === 0) {
          resolve(stdout);
          return;
        }
        reject(
          new NcodeVersionError(
            `\`ncode --version\` failed (${String(code ?? signal)}); cannot verify CLI compatibility.`,
            { exitCode: code, signal, stderr: stderr.slice(-4096) },
          ),
        );
      });
    });
  });
}
