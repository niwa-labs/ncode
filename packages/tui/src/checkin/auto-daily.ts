import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Owner request 2026-11-17: the daily check-in runs automatically when the
 * interactive TUI opens (never for pipe/exec surfaces), once per local day.
 * The "once" marker is a plain date file in the dataDir — no runtime state,
 * survives daemon restarts, trivially inspectable.
 */
export const AUTO_DAILY_CHECKIN_MARKER = 'daily-checkin-auto';

/** Local calendar day (YYYY-MM-DD), not UTC — "once per day" is the owner's day. */
export function localDay(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** True until MiniMax confirms a manual or automatic check-in for this local day. */
export function shouldAutoCheckin(dataDir: string, now: Date = new Date()): boolean {
  try {
    const marker = join(dataDir, AUTO_DAILY_CHECKIN_MARKER);
    if (!existsSync(marker)) return true;
    return readFileSync(marker, 'utf8').trim() !== localDay(now);
  } catch {
    return true;
  }
}

/** Records a confirmed check-in for the local day the request started. */
export function markAutoCheckinDone(dataDir: string, now: Date = new Date()): void {
  try {
    const marker = join(dataDir, AUTO_DAILY_CHECKIN_MARKER);
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, localDay(now));
  } catch {
    /* The marker is an optimization, never a correctness requirement. */
  }
}
