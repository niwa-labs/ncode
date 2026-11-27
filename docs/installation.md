# Installation packages and source builds

## Install Ncode from npm

Run `npm install --global @niwa-labs/ncode`, then open `ncode`. Run the same install command to update.

## Install Ncode from source

Open your checkout of the Niwa Labs fork and build it below. For MiniMax’s
installers, npm packages and GitHub release archives, see the
[upstream installation guide](https://github.com/MiniMax-AI/minimax-code/blob/main/docs/installation.md).
Update this build by checking out a newer fork revision and rebuilding it.
`ncode update` shows the same instruction.

For a source build, you need Git, Node.js 22.19+ (22.x), 24.2+ (24.x), 25, or 26, and pnpm 9.12.0. Regular CI uses Node.js 24 for full verification on Linux, platform checks on macOS and a focused Windows check. The weekly and manual compatibility matrix covers Node.js 22.19.0, 24.2.0, 25, and 26 on both platforms. Source-candidate archives are verified on Linux and macOS. Initial installation and build require access to public npm.

On Windows, check out this repository on a local NTFS volume before running `pnpm install`. The repository uses pnpm workspace links for vendored packages, and those links require NTFS junctions. FAT32/exFAT volumes, network shares, and other non-local Windows volumes cannot create the required junctions. The preflight command below verifies the volume and stops with a clear message before pnpm creates workspace links; run it immediately before `pnpm install`. It queries structured volume properties through Windows PowerShell and CIM, without requiring an elevated shell or parsing localized `fsutil` output. If PowerShell or CIM is unavailable or blocked, verification fails with the query error. A local NTFS volume can still contain a cloud-synced folder, which the preflight cannot identify reliably; keep the checkout outside OneDrive, Google Drive, Dropbox, and similar synced folders.

Node 24.0 and 24.1 are unsupported: their bundled libuv can return inconsistent Windows file identity metadata, causing safe configuration reads to fail. [Node 24.2.0](https://nodejs.org/en/blog/release/v24.2.0) includes libuv 1.51.0 with the [upstream fix](https://github.com/libuv/libuv/commit/82cdfb75f). Use a current patch release of a supported Node line.

```bash
corepack enable
corepack prepare pnpm@9.12.0 --activate
node scripts/check-windows-source-location.mjs
pnpm install --frozen-lockfile
pnpm build
pnpm ncode --help
pnpm ncode
```

If your Node.js installation does not include Corepack, install the exact pnpm version using your existing package manager. Native dependencies without matching prebuilt binaries require C/C++ build tools and Python: the C++ workload in Visual Studio Build Tools on Windows, Command Line Tools on macOS, or the system build toolchain on Linux.

The build extracts mcode-tools from a pinned public `@minimax-ai/code` archive and verifies both archive and CLI hashes. The cache is in `.cache/artifacts`. On integrity failure, check the network or remove that cache and retry; never bypass hash verification.

To use the CLI in another project, open that project's directory and run the built entry point by absolute path:

```bash
node /absolute/path/to/your-checkout/dist/cli.js
```

On Windows, use `node` with the appropriate local absolute path. Builds from
this checkout use the `ncode` command.

## Local daemon

Terminal, headless, and ACP sessions start or reuse a local daemon for the
selected data directory. The daemon keeps running after the client exits.
Inspect it with `ncode daemon status`, or stop it with `ncode daemon stop`.
Use the same `--profile` as the client. A normal stop refuses to interrupt
active work.

Use `MCODE_SERVER_MODE=off` for an in-process session. For JSONL compatibility,
set `MCODE_HISTORY_PROVIDER=jsonl` in the runtime environment. Stop a running
daemon before changing its history backend.
[Architecture](architecture.md) describes the storage and routing choices.

## Accounts and data

Run `/login` in the TUI or `pnpm ncode login`, choosing the region for your account. Token Plan requires an account and available credits. See the root README for BYOK configuration and testing.

Source builds and the published npm CLI use the same default user data directory:

| CLI artifact | Default user data directory |
| --- | --- |
| Published npm `@minimax-ai/code@0.6.9` | `~/.minimax` |
| Build from this repository | `~/.minimax` |

The npm 0.6.9 default was checked against the [public registry artifact](https://registry.npmjs.org/@minimax-ai/code/0.6.9) on 2026-10-13, with its SHA-512 integrity verified. This applies to that published version, including local npm dependencies; do not infer the default of another release from its version label alone. A selected profile uses `~/.minimax-<profile>`. The source default is defined in [`data-dir.ts`](../packages/tui/src/runtime/data-dir.ts). Login state, provider configuration such as `config.yaml`, caches, and sessions belong to the selected data directory.

Both accept a non-empty `MINIMAX_DATA_DIR`, falling back to a non-empty `MAVIS_DATA_DIR`, before the default. The [macOS / Linux / WSL installer](https://filecdn.minimax.chat/public/install.sh) installs the npm package under `~/.minimax-code` by default (`MCODE_INSTALL_DIR` changes the installation location). It does not set either data-directory override. Installation files and user data are separate concerns, even when their directories have the same name.

Earlier source builds used `~/.minimax-code` for user data. The new default does not move or merge that data. To keep using an existing source-build data directory, explicitly set `MINIMAX_DATA_DIR` to its path.

To locate data safely:

1. Identify the launcher you actually use with `command -v ncode` (POSIX) or `Get-Command ncode -All` (PowerShell), and run that launcher's `--version`. For a local npm dependency, use `node_modules/.bin/ncode --version`; a global npm listing does not identify it. A source build may report the same version as the npm release.
2. Check whether either data-directory override is set in that launcher's environment. Otherwise use the artifact-specific default above. Inspect directory and file names/permissions locally, without printing `config.yaml`, authentication files, or session contents. For builds from this repository, `mcode telemetry status` also reports the selected `configFile` path without printing credentials; npm 0.6.9 does not provide that command.
3. If both directories exist, their presence alone does not identify the active one. Keep both protected, and include the launcher, version, installation method, and whether overrides are set when requesting help. Redact personal path components; do not attach configuration or authentication files. Changing an override does not migrate existing data, so do not move or delete either directory merely to match these docs.

For tests, explicitly set `MINIMAX_DATA_DIR` to a temporary directory to keep normal sessions separate. Use `$env:MINIMAX_DATA_DIR = 'C:\path\to\test-profile'` in PowerShell or `export MINIMAX_DATA_DIR=/path/to/test-profile` in a POSIX shell.

### Profiles

A named profile selects an entire data directory, and with it a separate account. With no selector, the `default` profile uses the unsuffixed `~/.minimax`; `--profile work` uses `~/.minimax-work`. This is how a personal token plan and a work token plan can both stay signed in without sharing anything.

Two selectors choose a profile, in priority order:

1. `--profile <name>`, accepted on the root command and on every subcommand. Both `--profile work` and `--profile=work` are accepted, so `ncode --profile work exec` and `ncode login --profile work` select the same profile.
2. `MINIMAX_PROFILE=<name>`, which selects a profile for a whole process tree. The flag wins when both are set.

Like `MINIMAX_DATA_DIR`, `MINIMAX_PROFILE` is stripped from child-process environments at the daemon and agent boundary: each runtime is told its own identity instead of inheriting one. A `mcode` started from a shell inside a profile session therefore starts on the `default` profile rather than silently joining the parent's credentials. Pass `--profile` for such a nested invocation instead of exporting the variable.

A profile owns its whole directory, so two profiles share nothing: OAuth tokens, sessions, `config.yaml` (models and providers), MCP configuration, plugins, skills, and cron or background tasks. Selecting a different profile does not migrate, copy, or merge data; the earlier directory stays exactly where it was. Signing in restarts MCode and keeps the same profile. The `--profile` flag and the `ncode profile` command are available in builds from this repository.

One exception applies to a source build run directly with `pnpm` or from the npm package rather than the installed CLI: the first run against a new profile seeds its `config.yaml` from the default profile's file, including any BYOK API key stored there. That is the same behaviour a derived worktree data directory already had. Edit or delete the new profile's `config.yaml` if it should not carry those settings, and check it before using that profile for a different organisation's work. The installed CLI does not do this; it writes its own defaults.

Names are validated, never sanitised, because the name becomes a directory segment under `$HOME` and an unchecked value could resolve outside the home directory. A name is 1-64 characters, must start and end with a letter or number, and may otherwise contain only letters, numbers, dots, underscores, and hyphens. `.`, `..`, names containing `/` or whitespace, and names longer than 64 characters are refused with an error and exit code 1. See [`auth-profile.ts`](../packages/config/src/auth-profile.ts) for the allowlist.

`default` is reserved. `--profile default` is the same as omitting the flag, so it selects the default profile rather than creating a second account in `~/.minimax-default`.

Selection is resolved once per process, in this order: `--profile`, then `MINIMAX_PROFILE`, then git-branch auto-detection in the `mavis` and `agent-archon` source trees. The flag wins over the environment, and when `--profile` is given more than once the last one wins. Anything after `--` is prompt text and is not read as a profile.

Data directories on macOS and Windows are case-insensitive, so `--profile Work` and `--profile work` select the same account. `ncode profile list` shows such a case variant only once.

Manage profiles with `ncode profile`:

| Command | Effect |
| --- | --- |
| `ncode profile list` | Tab-separated rows of name, sign-in status, and data directory. `*` marks the active profile, `(default)` labels the default one, and status is one of `signed in`, `signed out`, `authorization pending`, or `not created`. |
| `ncode profile list --json` | The same profiles as an array of `name`, `dataDir`, `exists`, `authenticated`, and `pendingAuthorization`. |
| `ncode profile current` | Prints `Current profile: <name>` and `Data directory: <path>`. |
| `ncode profile remove <name> --yes` | Deletes that profile's data directory, and its legacy `~/.mavis-<profile>` compatibility directory when one exists. |

`ncode profile remove` refuses the `default` profile and tells you to delete its directory manually if that is what you want, refuses an invalid name, and refuses to run without `--yes`. It also fails when the named profile has no data directory. A profile directory that is a symlink is unlinked rather than followed, so a link is never walked into. These checks live in [`profile-command.ts`](../packages/tui/src/cli/profile-command.ts).

None of these commands print credentials: listing reports names, statuses, and paths only. To remove profile data without the command, run `ncode profile current` first to confirm the exact path, then delete only that directory. Do not use wildcard deletion across `~/.minimax*`, and do not delete a profile directory to move it elsewhere; profile data is not migrated between directories.

## macOS terminal shortcuts: Ghostty Option+M

In the composer, `Alt+M` (`Option+M` on macOS) cycles permission modes through Ask, Auto, and Full access. Its binding ID is `composer.cycle-permission`. `Shift+Tab` toggles **Plan mode**, a separate setting. You can also use `/permission` to choose a permission mode and `/permission status` to inspect it without an Option shortcut.

If `Option+M` inserts `µ` instead, the terminal is sending text rather than the expected Alt shortcut. MCode preserves literal `µ` as text; it cannot safely infer a permission change from that character. The terminal must forward the modifier, or you can choose another binding.

## Delete guard: recoverable versus permanent deletes

Permission mode answers **when you get asked**. The delete guard is a separate setting that answers **whether a delete is recoverable at all**, so it is deliberately not part of `/permission` and is not implied by Full access.

While the guard is **on** (the default), a destructive command such as `rm` is routed to a recoverable delete: it lands in the platform trash instead of being unlinked, and no permission card is raised for the routine case. The guard also covers deletes that never appear as a literal `rm`, such as `xargs rm`, `find -exec rm`, or a `rm` inside a script the agent just wrote.

Turn it off only when you accept that deletes are immediate and cannot be undone:

- `/delete-guard` opens a picker with **Recoverable** and **Permanent**.
- `/delete-guard status` reports the current setting without changing it.
- `/delete-guard on` keeps deletes recoverable; `/delete-guard off` lets them run permanently.

The setting is stored as `permission.dangerousCommandGateEnabled` in `config.yaml`. It governs **the main window only**: a sub-agent Session keeps the guard on regardless of this value, because it runs unattended and must not inherit a preference the user made while watching their own session. A tool call whose Session cannot be identified — for example the public `POST /permission/check` route, which receives only a Session id — is also treated as a sub-agent, so an unknown origin never relaxes the guard.

Background bash keeps the guard unconditionally for the same reason: that executor is created once per process and cannot tell a main-window run from a sub-agent one at spawn time. A `run_in_background` delete therefore stays recoverable even with the guard off.

The setting is fail-closed: an absent or malformed value keeps the guard **on**, and a host that does not manage the setting reports it as such rather than claiming a protection it is not enforcing.

The switch takes effect on the next command. You do not need to restart MCode.

### Sandbox: what the agent may write and delete

Permission mode and the sandbox are **independent layers**. Permission mode decides when you are asked; the sandbox decides what is reachable even when nothing is asked. Full access (`bypassPermissions`) therefore does **not** lift a sandbox restriction, which is the usual reason a delete is blocked in an unattended session.

The level is stored as `sandbox.filesystem.policy.mode` in `config.yaml`:

| Level | Writes | Deletes (`unlink`) |
| --- | --- | --- |
| `read_only` | Session temp only | Nothing beyond session temp |
| `workspace_write` | Workspace surface, plus the trash destination | Workspace surface only |
| `delete_guard` | Anywhere on the host | Workspace surface only |
| `full_access` | Anywhere on the host | Anywhere on the host |

`delete_guard` is the default when the sandbox is on: writes are unrestricted, but unlinking anything outside the workspace surface is refused. Choose `full_access` when that restriction is what you want removed, and `read_only` when the agent must not change anything at all.

- `/sandbox` opens a picker with all four levels.
- `/sandbox status` reports the current level without changing it.
- `/sandbox <mode>` switches to `read_only`, `workspace_write`, `delete_guard` or `full_access`. An unrecognised value prints usage and writes nothing.

Switching re-initializes the sandbox backend and persists the new level; no restart is needed, and running sessions pick it up on their next command. A host that runs no sandbox reports it as such rather than naming a level it is not enforcing.

### Configure Ghostty's Option key

Ghostty's [`macos-option-as-alt`](https://ghostty.org/docs/config/reference#macos-option-as-alt) default is **keyboard-layout dependent** when unset, not always `false`. The current reference lists U.S. Standard and U.S. International as defaulting to `true`; other layouts default to `false`. Check the active macOS input source and the configuration loaded by your installed Ghostty version.

Set this in your Ghostty configuration to send both Option keys as Alt:

```ini
macos-option-as-alt = true
```

Use `left` or `right` instead of `true` to reserve only that Option key for shortcuts and retain Unicode composition on the other side. Use the configured side when testing `Option+M`.

Follow Ghostty's [configuration locations and precedence](https://ghostty.org/docs/config#file-location): macOS-specific files load after XDG files, and later settings can override earlier ones. Inspect the loaded setting from the same Ghostty installation, without `--default`:

```bash
ghostty +show-config | awk '/^macos-option-as-alt[[:space:]]*=/'
```

If `ghostty` is not on `PATH`, use the executable inside your installed app bundle, typically `/Applications/Ghostty.app/Contents/MacOS/ghostty`. An empty or omitted value is not proof of `false`; unset behavior depends on the layout. After editing, reload Ghostty's configuration from its menu (default `Cmd+Shift+,`) and open a new terminal. This is separate from MCode's `/reload` command.

### Keep Option for text and customize MCode instead

While idle, open `/hotkeys`, select `composer.cycle-permission`, press `Enter`, press `Ctrl+X`, then press `Enter` to save. `Ctrl+X` is unused by the current default MCode bindings; check any custom terminal or multiplexer bindings too. Do not choose `Ctrl+M`: terminals commonly encode it identically to `Enter`.

Alternatively, merge this entry into `<data-dir>/tui/keybindings.json`, preserving any existing entries:

```json
{
  "composer.cycle-permission": "ctrl+x"
}
```

For the default profile this is `~/.minimax/tui/keybindings.json`; [profiles and data-directory overrides](#accounts-and-data) change the path. Create the `tui` directory if needed. After editing the file, run `/reload` while idle with no pending interaction or queued message, or restart MCode. This replaces `Alt+M`; use `["alt+m", "ctrl+x"]` as the value to retain both bindings. `/hotkeys` shows the effective binding.

### Verify the result

With an idle composer and no open picker or permission prompt, note `/permission status`, press the configured shortcut, and check the status again. The mode should advance without inserting text. Restore your intended permission mode through `/permission` afterward. Confirm that `Shift+Tab` still toggles Plan mode and that pasting `µ` still inserts text.

If it still fails, record `ncode --version`, Ghostty's version, active keyboard layout, which Option key you pressed, the setting above, the effective `/hotkeys` entry, and whether tmux or SSH is involved. Compare with a direct Ghostty session. MCode supports both legacy ESC-prefixed Alt input and extended keyboard reports; a shell's raw-key display alone does not establish what Ghostty sends after the TUI negotiates its keyboard protocol.

## Update or remove

Save your changes, fetch a reviewed revision with Git, then repeat the frozen install and build. A source installation does not automatically become an official npm installation.

To uninstall a source build, save any work and remove the source directory you created. Separately stored user data remains in place. To remove the Ncode npm package, run `npm uninstall --global @niwa-labs/ncode`. Your conversation history stays on disk.

### Remove an official MiniMax Code installation

Close running MCode sessions, including editor integrations, before uninstalling. First locate the command with `command -v mcode` (macOS / Linux / WSL) or `Get-Command mcode -All` (PowerShell), then follow the matching installation method below. The current official install scripts do **not** provide an uninstall flag.

#### Installed with the script

The commands below remove the default installation directory, including both launchers, downloaded releases, and any installer-managed Node.js runtime. If you used `MCODE_INSTALL_DIR`, substitute the actual installation directory. Inspect it first: earlier source builds used `~/.minimax-code` for user data, and a custom data directory can overlap the installation. Back up any configuration or sessions you want to keep before deleting it.

##### macOS / Linux / WSL

```bash
rm -rf -- "$HOME/.minimax-code"
```

Remove the `# MiniMax Code CLI` comment and its following PATH line from the shell file the installer updated: `~/.zshrc` for zsh; the first existing file among `~/.bashrc`, `~/.bash_profile`, and `~/.profile` for bash (or a newly created `~/.bashrc`); `~/.config/fish/config.fish` for fish; or `~/.profile` for other shells. The line is `export PATH="/absolute/install/path/bin:$PATH"`, or `fish_add_path -g "/absolute/install/path/bin"` for fish. Remove only the MCode entry, preserving other PATH settings. The installer skips this edit when `MCODE_NO_MODIFY_PATH` is set or the path is already present.

##### Windows (PowerShell)

```powershell
Remove-Item -LiteralPath "$env:USERPROFILE\.minimax-code" -Recurse -Force
```

Open **Edit environment variables for your account**, edit the user **Path**, and remove only the installation directory entry (by default `%USERPROFILE%\.minimax-code`, which may appear as an expanded absolute path). The Windows installer updates the user Path, not the PowerShell profile; `MCODE_NO_MODIFY_PATH` skips that persistent update.

#### Installed with npm or from source

For a global npm installation, use the same npm installation/prefix you used to install MCode:

```bash
npm uninstall -g @minimax-ai/code
```

For a source build, save any work and remove only the checkout you created.

After uninstalling, reopen your terminal (fully restart the editor for integrated terminals) and run `command -v mcode` or `Get-Command mcode -All` again. No result means the command is no longer on PATH. If another copy appears, identify its installation method before removing it.

### Delete user data (optional)

Removing the program leaves separately stored user data in place. To also delete local login state, provider configuration, caches, and sessions, first confirm the selected directory using [Accounts and data](#accounts-and-data) and back up anything you need. Other MCode installations can share this directory. For the default `~/.minimax` directory only:

```bash
# macOS / Linux / WSL — permanently deletes the default user data
rm -rf -- "$HOME/.minimax"
```

```powershell
# Windows — permanently deletes the default user data
Remove-Item -LiteralPath "$env:USERPROFILE\.minimax" -Recurse -Force
```

A profile uses `~/.minimax-<profile>`; `MINIMAX_DATA_DIR` or `MAVIS_DATA_DIR` can select a different location. Remove only the specific directories you intend to discard, without wildcard deletion. Remove any MCode-specific environment variable assignments you added to shell profiles or user environment settings if you no longer need them.
