import path from 'node:path';
import { fileURLToPath } from 'node:url';

type ProcessEnvironment = Record<string, string | undefined>;

/**
 * Resolves the bundled mcode-tools resource directory next to the running
 * bundle (`<bundleDir>/embedded/mcode-tools`), honoring the published-artifact
 * dev override. Moved here from the TUI runtime (revision 11 F2): the
 * daemon-owned readiness resolves the SAME layout — both hosts are bundled
 * into the same dist directory, so `entryUrl: import.meta.url` resolves
 * identically from either package.
 */
export function resolveBundledMcodeToolsResourceDir(
	entryUrl: string,
	environment: ProcessEnvironment = process.env,
): string {
	if (environment.MAVIS_DEV_MCODE_TOOLS_MODE === 'published') {
		const override = environment.MAVIS_DEV_MCODE_TOOLS_RESOURCE_DIR?.trim();
		if (!override || !path.isAbsolute(override)) {
			throw new Error('MAVIS_DEV_MCODE_TOOLS_RESOURCE_DIR must be an absolute path');
		}
		return path.normalize(override);
	}
	return path.join(path.dirname(fileURLToPath(entryUrl)), 'embedded', 'mcode-tools');
}

/** Resolves the launcher bin directory next to the running bundle. */
export function resolveBundledMcodeToolsCommandBinDir(entryUrl: string): string {
	return path.join(path.dirname(fileURLToPath(entryUrl)), 'internal-bin');
}
