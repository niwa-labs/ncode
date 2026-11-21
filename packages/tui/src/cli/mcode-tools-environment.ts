/**
 * The mcode-tools host-environment activation moved to the host-neutral
 * `@mavis/mcode-tools-host` package (revision 11 F2): the daemon-owned
 * readiness needs exactly the same activation, and the package is the home of
 * the launcher lifecycle. This module keeps the TUI import surface (the
 * mcode-tools child entry and the integration tests) stable.
 */
export {
	activateMcodeToolsHostEnvironment as activateTuiMcodeToolsHostEnvironment,
	configureMcodeToolsChildEnvironment,
	type McodeToolsHostEnvironmentActivation as TuiMcodeToolsHostEnvironmentActivation,
} from '@mavis/mcode-tools-host';
