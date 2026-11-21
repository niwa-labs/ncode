import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/**
 * While the TUI owns the terminal, NOTHING may write raw bytes to stderr:
 * the engine paints the same tty, and every stray line splices frames,
 * freezes transient rows (the startup spinner) mid-paint and pushes painted
 * rows into native scrollback — the "doubled welcome banner" class of
 * corruption. Loggers (@mavis/logging writes text lines to `process.stderr`)
 * are routed into the session's observability log directory instead.
 *
 * The capture is installed only for an interactive TUI (a real tty stderr):
 * headless surfaces (`exec`, ACP, tests, pipes) keep stderr verbatim, and the
 * returned restore puts the original stream back so post-stop crash reports
 * still reach the operator's terminal.
 */
export interface TuiStderrCapture {
  /** Log file the captured lines are appended to (diagnostics); undefined when inactive. */
  readonly logFile: string | undefined;
  /** Restores the original `process.stderr.write` and closes the file. */
  restore(): void;
}

export function captureTuiStderr(
  dataDir: string,
  options: { readonly force?: boolean } = {},
): TuiStderrCapture {
  const interactive = options.force === true || process.stderr.isTTY === true;
  if (!interactive) return { logFile: undefined, restore: () => {} };

  const directory = join(dataDir, 'v2', 'observability', 'logs');
  const logFile = join(directory, `tui-stderr-${process.pid}.log`);
  let fd: number;
  try {
    mkdirSync(directory, { recursive: true });
    fd = openSync(logFile, 'a');
  } catch {
    // A capture failure must never take the TUI down; stderr stays as-is.
    return { logFile: undefined, restore: () => {} };
  }

  const original: typeof process.stderr.write = process.stderr.write.bind(process.stderr);
  let restored = false;
  process.stderr.write = ((chunk: Uint8Array | string, encoding?, callback?) => {
    try {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
      writeSync(fd, bytes);
    } catch {
      // Dropped by the logging spec's own contract (sink failures are silent).
    }
    if (typeof encoding === 'function') encoding();
    else if (typeof callback === 'function') callback();
    return true;
  }) as typeof process.stderr.write;

  return {
    logFile,
    restore: () => {
      if (restored) return;
      restored = true;
      process.stderr.write = original;
      try {
        closeSync(fd);
      } catch {
        // Already closed.
      }
    },
  };
}
