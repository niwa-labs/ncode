/** MiniMax Code source baseline (upstream 3c21163). Update when syncing upstream. */
export const MCODE_BASE_VERSION = '0.7.2';
/** Checked against the vendored Pi coding-agent manifest in build-marker.test.ts. */
export const PI_VENDOR_VERSION = '1.6.0';

export function formatComponentVersions(ncodeVersion: string): string {
  return `Ncode ${ncodeVersion}\nMCode ${MCODE_BASE_VERSION}\nPi ${PI_VENDOR_VERSION}`;
}

const FORK_BUILD_CHANNEL = 'chimera';

export function resolveBuildChannel(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const channel = environment['MCODE_BUILD_CHANNEL']?.trim();
  return channel === FORK_BUILD_CHANNEL ? FORK_BUILD_CHANNEL : undefined;
}

export function buildChannelSuffix(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return resolveBuildChannel(environment)
    ? ` · ${FORK_BUILD_CHANNEL} build`
    : '';
}
