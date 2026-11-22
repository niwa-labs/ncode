# Maintaining Ncode

Issues, pull requests and releases are managed in the Niwa Labs repository. Route reports about Ncode here, including bugs seen with MiniMax models. Follow the [security policy](../SECURITY.md) for private vulnerability reports.

## Issue triage

Use the issue form to identify the interface and record how to reproduce a problem. Keep profile credentials, private code and session data out of reports. The triage workflow labels issues in this repository. For terminal bugs, ask for the terminal, operating system and `ncode --version`; for ACP bugs, ask for the editor and the operation that failed.

## Pull request labels

Use `bug`, `enhancement`, `documentation` or `dependencies` for the change. Use `cli` for Ncode, including headless and ACP, and add `tui` for an interactive terminal change. The `perf:full` label selects the extended performance check. [Performance checks](../CONTRIBUTING.md#performance-checks)

## Review and merge

Check the source verification and release audit results for the proposed commit. When importing upstream changes, record their revision, preserve their notices and explain local adaptations. Review changes to the public source inventory before regenerating it. [Contributing](../CONTRIBUTING.md) · [Verification](verification.md)

## Release handoff

The released CLI is `@niwa-labs/ncode`. Record the source commit, tested archive checksum and public registry version. [Release instructions](releasing.md)
