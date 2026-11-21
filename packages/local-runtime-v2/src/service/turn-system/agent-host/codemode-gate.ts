/**
 * The one `run_code` fact for a Turn (K2). The tool catalog appends the tool
 * and the V2 prompts render the "Tool calls in this turn" section from THIS
 * decision, so a turn never sees the tool without its prompt or the reverse.
 *
 * The resolved `beta` is the whole gate: `beta.runCode: true` enables,
 * `false` disables. The MCODE_CODEMODE=1 dev/probe hatch lives at config
 * parse time (configuredBetaValue in @mavis/config), where "absent" is still
 * distinguishable from an owner's explicit `false`.
 */
export function isRunCodeEnabled(beta: { runCode?: boolean } | undefined): boolean {
  return beta?.runCode === true;
}
