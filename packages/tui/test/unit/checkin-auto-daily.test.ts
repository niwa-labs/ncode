import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { localDay, markAutoCheckinDone, shouldAutoCheckin } from '../../src/checkin/auto-daily.js';

describe('auto daily check-in marker', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('runs on a fresh dataDir and again the next local day', () => {
    dir = mkdtempSync(join(tmpdir(), 'checkin-auto-'));
    const morning = new Date(2026, 10, 17, 9, 0, 0);

    expect(shouldAutoCheckin(dir, morning)).toBe(true);
    markAutoCheckinDone(dir, morning);
    expect(shouldAutoCheckin(dir, morning)).toBe(false);
    expect(readFileSync(join(dir, 'daily-checkin-auto'), 'utf8')).toBe('2026-11-17');

    // The same calendar day, later: still done.
    const evening = new Date(2026, 10, 17, 22, 0, 0);
    expect(shouldAutoCheckin(dir, evening)).toBe(false);

    // The next local day runs again.
    const nextDay = new Date(2026, 10, 18, 8, 0, 0);
    expect(shouldAutoCheckin(dir, nextDay)).toBe(true);
  });

  it('uses the local calendar day, not UTC', () => {
    // 2026-11-17 00:30 local (UTC+3 → 2026-11-16 21:30 UTC) must read as the
    // 17th: "once per day" is the owner's wall-clock day.
    expect(localDay(new Date(2026, 10, 17, 0, 30))).toBe('2026-11-17');
  });

  it('stays runnable when the marker file is unreadable', () => {
    dir = mkdtempSync(join(tmpdir(), 'checkin-auto-'));
    const marker = join(dir, 'daily-checkin-auto');
    writeFileSync(marker, '');
    // An empty marker is not today's date → run.
    expect(shouldAutoCheckin(dir)).toBe(true);
  });
});
