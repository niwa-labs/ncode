/**
 * Permission-mode strictness (spec §2.4): `default` > `auto` >
 * `bypassPermissions` > `off`. `acceptEdits` and `dontAsk` normalize to
 * `default` inside the decision pipeline, so they rank with it. A hook (or an
 * explicit caller override) may only TIGHTEN a Session's bound mode.
 */

const MODE_STRICTNESS: Record<string, number> = {
  default: 0,
  acceptEdits: 0,
  dontAsk: 0,
  auto: 1,
  bypassPermissions: 2,
  off: 3,
};

/** True only when `candidate` is STRICTLY stricter than `reference`. */
export function isStricterPermissionMode(
  candidate: string,
  reference: string,
): boolean {
  return (MODE_STRICTNESS[candidate] ?? 0) < (MODE_STRICTNESS[reference] ?? 0);
}
