import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureTuiStderr } from '../../src/tui/stderr-capture.js';

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

describe('captureTuiStderr (terminal ownership)', () => {
  it('routes stderr writes into the observability log file while installed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tui-stderr-'));
    cleanup.push(dir);
    const capture = captureTuiStderr(dir, { force: true });
    expect(capture.logFile).toBeDefined();

    process.stderr.write('captured line 1\n');
    process.stderr.write('captured line 2\n', 'utf8', () => {});

    const logged = readFileSync(capture.logFile!, 'utf8');
    expect(logged).toContain('captured line 1');
    expect(logged).toContain('captured line 2');

    capture.restore();
    // After restore the original stream is back and the file is closed.
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    process.stderr.write('post-restore line\n');
    expect(writeSpy).toHaveBeenCalled();
    writeSpy.mockRestore();
    expect(readFileSync(capture.logFile!, 'utf8')).not.toContain('post-restore line');
  });

  it('honours the write() callback contract while capturing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tui-stderr-'));
    cleanup.push(dir);
    const capture = captureTuiStderr(dir, { force: true });
    let done = false;
    process.stderr.write('with callback\n', () => {
      done = true;
    });
    expect(done).toBe(true);
    let doneEncoding = false;
    process.stderr.write('with encoding-callback\n', 'utf8', () => {
      doneEncoding = true;
    });
    expect(doneEncoding).toBe(true);
    capture.restore();
  });

  it('is a no-op for a non-interactive stderr (headless keeps stderr verbatim)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tui-stderr-'));
    cleanup.push(dir);
    const capture = captureTuiStderr(dir, { force: false });
    expect(capture.logFile).toBeUndefined();
    capture.restore();
  });

  it('restore is idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tui-stderr-'));
    cleanup.push(dir);
    const capture = captureTuiStderr(dir, { force: true });
    capture.restore();
    expect(() => capture.restore()).not.toThrow();
  });
});
