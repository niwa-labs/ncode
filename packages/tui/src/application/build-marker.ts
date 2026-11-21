/**
 * Identifies a build that is NOT the published npm package.
 *
 * WHY THE VERSION STRING IS NOT ENOUGH
 * ------------------------------------
 * The installed `@minimax-ai/code` and a source build of this repository report
 * different numbers for closely related code: the published artifact is
 * versioned by the release pipeline, while this fork keeps the version of the
 * upstream projection it tracks (they meet at the periodic master sync). Reading
 * `v…` therefore cannot tell a developer whether they just launched their own
 * build or the installed package — which is the one thing they most need to know
 * before trusting a behaviour change.
 *
 * WHAT THIS DOES INSTEAD
 * ----------------------
 * The dev launcher exports `MCODE_BUILD_CHANNEL=chimera`. Only a build started
 * through that launcher can carry the marker, so the badge is a positive claim
 * ("this is our fork build") rather than an inference from a number that is
 * ambiguous by design. An installed package never sets the variable and
 * therefore never claims to be the fork.
 *
 * The name: the fork is a chimera — the mcode body, the pi 1.5.2 core, and the
 * durable MCode layer grafted on top. The badge names all three parts so the
 * next session can tell at a glance which body the heart is beating in.
 *
 * Fail-closed: an unset, empty or unknown value renders nothing, so an
 * unexpected value can never mislabel an official build as the fork.
 */

/** Channel value the dev launcher exports. */
const FORK_BUILD_CHANNEL = 'chimera';

/**
 * The vendored pi release this fork runs on (the harness behind GenerationTask).
 * Pinned by hand at every vendor upgrade; `build-marker` unit tests fail the
 * build when this drifts from `third_party/pi-mono/packages/coding-agent`.
 */
export const PI_VENDOR_VERSION = '1.5.2';

export function resolveBuildChannel(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const channel = environment['MCODE_BUILD_CHANNEL']?.trim();
  return channel === FORK_BUILD_CHANNEL ? FORK_BUILD_CHANNEL : undefined;
}

/**
 * Header suffix for a fork build, or an empty string for an installed package.
 * Returns an empty string — not `undefined` — so it can be interpolated without
 * a conditional at the call site. Names the lineage (fork), the pi core the
 * fork runs on, and the build channel.
 */
export function buildChannelSuffix(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return resolveBuildChannel(environment)
    ? ` · fork · pi ${PI_VENDOR_VERSION} · ${FORK_BUILD_CHANNEL} build`
    : '';
}
