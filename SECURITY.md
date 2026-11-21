# Security

Use **Security → Advisories → Report a vulnerability** on the Niwa Labs fork
when private vulnerability reporting is available. Include the affected commit,
Node.js version, operating system and redacted evidence. Keep credentials and
real session data out of public issues.

For an issue in upstream MiniMax Code or a MiniMax service, see the
[upstream security policy](https://github.com/MiniMax-AI/minimax-code/blob/main/SECURITY.md).

## Data and service boundaries

- The active data directory stores login state, provider configuration (including API keys in `config.yaml`), and sessions. Builds from this repository and the published npm CLI `@minimax-ai/code@0.6.9` default to `~/.minimax` (or `~/.minimax-<profile>` when a profile is selected). Environment overrides can select another directory. Follow [Accounts and data](docs/installation.md#accounts-and-data) to identify it; the installer location alone does not identify stored credentials. Restrict local access to every data directory you have used and keep them out of Git, including old profiles. They are not shareable project configuration.
- Models, official plugins, connectors, search, media, feedback, and telemetry may contact external services. Those services continue to control authorization and credits; source access does not grant access to accounts or third-party resources.
- mcode-tools obtains short-lived access tokens through the host's lease broker. Never pass refresh tokens to tool processes.
- Permissions and sandboxing do not replace review of untrusted plugins, MCP servers, and shell commands. If automatic permission classification is unavailable, retain user confirmation rather than allowing operations by default.
- If credentials leak, revoke or rotate them with the service first, then remediate files and Git history. Deleting the current file does not remove historical copies.

Scan source, Git history, and build artifacts separately. A passing scan does not guarantee the absence of unknown vulnerabilities.
