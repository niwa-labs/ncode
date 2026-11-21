# Ncode · Niwa Labs

Ncode is an independent fork of MiniMax Code (MCode) maintained by Niwa Labs. It uses Pi for terminal, headless and ACP sessions. It adds a resident daemon, durable session history and context, and account profiles.

<p align="center">
  <a href="#quick-start">Get started</a> ·
  <a href="docs/README.md">Documentation</a> ·
  <a href="docs/examples.md">Examples</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>
<p align="center"><strong>English</strong> · <a href="README_ZH.md">简体中文</a></p>
<p align="center">
  <img src="docs/assets/source-preview.svg" alt="Source preview">
  <img src="docs/assets/node.svg" alt="Compatibility: Node.js 22.19+, 24.2+, 25, and 26">
  <a href="LICENSE-STATUS.md"><img src="docs/assets/license.svg" alt="First-party default license: MIT"></a>
</p>

Give a blinking pocket pet a focus timer. Then ask: “Make pause a long press, and celebrate when the timer ends.” Watch a request become something you can actually use.

[![Pocket Pet: from a blinking face to a working focus companion](docs/assets/pocket-pet-demo.png)](docs/demo.md)

<p align="center"><a href="docs/demo.md">Watch the build story and browser demo →</a> · <a href="examples/pocket-pet">Build it yourself →</a></p>

**No hardware required.** The example runs locally in your browser, with no frontend dependencies. Asking the CLI to edit code requires a MiniMax account with available credits or your own compatible model API; model calls may incur charges. The finished example runs without a model account.

## Quick start

### 1. Build the Niwa Labs fork

From your checkout, run the following with a supported Node.js version and pnpm 9.12.0.

```sh
node scripts/check-windows-source-location.mjs
pnpm install --frozen-lockfile
pnpm build
pnpm ncode --version
```

Run `pnpm ncode` from the checkout, or run its built `dist/cli.js` with Node.js
from another directory. The examples below use `ncode` as shorthand for that
built CLI. The `mcode` launcher remains available for existing integrations.
The official MiniMax installers, registry packages and update channel
belong to [upstream](https://github.com/MiniMax-AI/minimax-code). Update this source
build by rebuilding a newer checkout.

### 2. Sign in or bring your own API key

For a mainland China account:

```bash
ncode login
```

For a Global account:

```bash
ncode login --region global
```

Complete sign-in in your browser, then open `ncode` and use `/status` to check your account and `/provider` to choose a model. Run `ncode logout` to sign out.

Token Plan requires an account with available credits. Builds from this repository and the published npm CLI `@minimax-ai/code@0.6.9` default to `~/.minimax` for user data (or `~/.minimax-<profile>` when a profile is selected). `MINIMAX_DATA_DIR` or `MAVIS_DATA_DIR` can override the data directory. The installer's `~/.minimax-code` installation directory is separate from this choice. See [Run two accounts](#run-two-accounts) to keep two accounts side by side, and [Accounts and data](docs/installation.md#accounts-and-data) before locating or removing configuration and sessions.

#### Run two accounts

A named profile owns a separate data directory, so its tokens, sessions, `config.yaml`, MCP configuration, plugins, and skills stay out of your other account. With no selector, `ncode` uses the `default` profile.

```bash
ncode login                      # personal account -> ~/.minimax
ncode login --profile work       # work account     -> ~/.minimax-work
ncode                            # personal
ncode --profile work             # work
ncode profile list               # see both
ncode profile remove work --yes  # forget the work profile
```

`--profile` is accepted on the root command and on every subcommand, so `ncode --profile work exec` and `ncode login --profile work` select the same profile. `MINIMAX_PROFILE=work` selects a profile for a whole shell or process tree and loses to the flag. Profile names are 1-64 characters of letters, numbers, dots, underscores, and hyphens, starting and ending with a letter or number; any other name is refused with an error rather than corrected. `default` is reserved and means the same as omitting the flag. See [Profiles](docs/installation.md#profiles) for the naming rules, the isolated state, and every `ncode profile` subcommand.

<details>
<summary>Use your own API key (BYOK)</summary>

BYOK does not require a MiniMax login. Set `MCODE_PROVIDER_API_KEY` in your current shell, then add a provider. Replace the example URL and model name with your provider's values:

```bash
ncode provider add --name my-provider --base-url https://example.com/v1 \
  --api-format openai-completions --model my-model \
  --api-key-env MCODE_PROVIDER_API_KEY --use
ncode
```

`--use` tests the first listed model before saving and selecting it. A failed connection test saves nothing. Omit `--use` to save without testing or changing the default model. For custom/local models, add `--context-limit 32768 --output-limit 4096` (use your server's actual limits). Each value must be a positive safe integer and applies to every repeated `--model`. Inspect configured limits with `ncode provider list --json`. Omitting these flags preserves the existing model-limit defaults.

Supported API formats: `openai-completions`, `openai-responses`, and `anthropic-messages`. See the [model examples](docs/examples.md#2-choose-your-own-model) for environment variable setup, connection checks, and model overrides for a single run.

Providers added this way are stored under `custom_provider` in the active profile's `config.yaml`; this is the supported path for third-party or self-hosted endpoints, while `minimax_api` stays reserved for the official MiniMax API. Relays that require `Authorization: Bearer` on an Anthropic-compatible endpoint can set custom headers in `config.yaml`; see [Third-party relays and custom auth headers](docs/examples.md#third-party-relays-and-custom-auth-headers).

</details>

### 3. Build the pocket pet

Clone this repository and copy the starter into a separate directory:

```bash
node examples/pocket-pet/setup.mjs ../my-pocket-pet
cd ../my-pocket-pet
node serve.mjs
```

Open `http://127.0.0.1:4173`. In a second terminal, open `ncode` in `my-pocket-pet` and paste [the first prompt](examples/pocket-pet/README.md#first-request), then [the follow-up](examples/pocket-pet/README.md#change-the-requirement). Refresh the browser after each change.

Prefer to try the result first? From the repository root, run `node examples/pocket-pet/serve.mjs finished` and open the same URL. Add `?demo=1` for the visibly labeled 10-second mode.

[Full walkthrough and requirements](examples/pocket-pet) · [Small code-repair example](examples/clamp) · [Models, search, and tools](docs/examples.md)


### Work in your own project

Open the project you want to work on:

```bash
cd /path/to/your/project
ncode
```

Describe your task in the TUI, or submit it directly when you launch Ncode:

```bash
ncode "Find a failing test, fix the implementation, and run the relevant tests."
```

Use `ncode init .` to generate or update project guidance in `AGENTS.md`. Describe the expected result, allowed changes, and how to verify the task.

| Entry point | Command | Use it for |
| --- | --- | --- |
| Interactive TUI | `ncode [prompt]` | Explore code, continue a conversation, and review changes or permissions. |
| Headless | `ncode exec [prompt]` | Shell scripts, CI, batch work, and evaluations. |
| ACP | `ncode acp` | Editors and clients supporting Agent Client Protocol. |
| TypeScript SDK | [`@minimax-ai/code-sdk`](packages/code-sdk/README.md) | Drive `ncode exec` from Node.js code: start, stream and resume conversations. |

### Lightweight conversations

For simple conversation or general knowledge questions, start a new Session with
`--mode lightweight`:

```bash
ncode --mode lightweight "Explain how DNS caching works."
ncode exec --mode lightweight "Summarize the CAP theorem."
```

Lightweight mode sends a small conversational system prompt and no tool schemas. It omits workspace
instructions, Skills, memory blocks, MCP schemas, and the full environment block from provider
context, so it cannot inspect or change local files. Start a new standard Session for coding or tool use with
`ncode --mode standard` or `ncode exec --mode standard`; omitting `--mode` is identical to standard
mode.

The mode is fixed when a root Session is created. `--mode lightweight` therefore cannot be combined
with `--session` or `--continue`. Child/sub-agent Sessions do not inherit it, `/compact` continues to
use the standard compaction context, and ACP and desktop Sessions remain standard. Reopening a
lightweight Session keeps its mode and shows `Lightweight` in the TUI status line; opening a standard
Session from a lightweight launch remains standard and shows no indicator.

### Continue your work

```bash
# Resume the latest session in the current workspace
ncode --continue

# Open the session picker
ncode --session
```

The terminal, headless CLI, and ACP share a local daemon for the selected
profile. See [daemon commands](docs/installation.md#local-daemon). Inside the
TUI, use `/sessions` to find previous sessions and `/help` for commands and shortcuts.

| Action | Shortcut |
| --- | --- |
| Send a message or steer the running task | `Enter` |
| Queue a follow-up while a task is running | `Alt+Enter` |
| Insert a newline | `Shift+Enter` |
| Reference a workspace file or directory | `@` |
| Toggle Plan Mode | `Shift+Tab` |
| Switch permission modes | `Alt+M` |
| Close a panel or interrupt a running task; interrupting before the model replies returns the message to the composer | `Esc` |

## Uninstall

Close running MCode sessions, including editor integrations, before uninstalling. First locate the command with `command -v mcode` (macOS / Linux / WSL) or `Get-Command mcode -All` (PowerShell), then follow the matching installation method below. The current official install scripts do **not** provide an uninstall flag.

### Installed with the script

The commands below remove the default installation directory, including both launchers, downloaded releases, and any installer-managed Node.js runtime. If you used `MCODE_INSTALL_DIR`, substitute the actual installation directory. Inspect it first: earlier source builds used `~/.minimax-code` for user data, and a custom data directory can overlap the installation. Back up any configuration or sessions you want to keep before deleting it.

**macOS / Linux / WSL**

```bash
rm -rf -- "$HOME/.minimax-code"
```

Remove the `# MiniMax Code CLI` comment and its following PATH line from the shell file the installer updated: `~/.zshrc` for zsh; the first existing file among `~/.bashrc`, `~/.bash_profile`, and `~/.profile` for bash (or a newly created `~/.bashrc`); `~/.config/fish/config.fish` for fish; or `~/.profile` for other shells. The line is `export PATH="/absolute/install/path/bin:$PATH"`, or `fish_add_path -g "/absolute/install/path/bin"` for fish. Remove only the MCode entry, preserving other PATH settings. The installer skips this edit when `MCODE_NO_MODIFY_PATH` is set or the path is already present.

**Windows (PowerShell)**

```powershell
Remove-Item -LiteralPath "$env:USERPROFILE\.minimax-code" -Recurse -Force
```

Open **Edit environment variables for your account**, edit the user **Path**, and remove only the installation directory entry (by default `%USERPROFILE%\.minimax-code`, which may appear as an expanded absolute path). The Windows installer updates the user Path, not the PowerShell profile; `MCODE_NO_MODIFY_PATH` skips that persistent update.

### Installed with npm or from source

For a global npm installation, use the same npm installation/prefix you used to install MCode:

```bash
npm uninstall -g @minimax-ai/code
```

For a source build, save any work and remove only the checkout you created; see [Update or remove](docs/installation.md#update-or-remove).

After uninstalling, reopen your terminal (fully restart the editor for integrated terminals) and run `command -v mcode` or `Get-Command mcode -All` again. No result means the command is no longer on PATH. If another copy appears, identify its installation method before removing it.

### Optional: delete user data

Removing the program leaves separately stored user data in place. To also delete local login state, provider configuration, caches, and sessions, first confirm the selected directory using [Accounts and data](docs/installation.md#accounts-and-data) and back up anything you need. Other MCode installations can share this directory. For the default `~/.minimax` directory only:

```bash
# macOS / Linux / WSL — permanently deletes the default user data
rm -rf -- "$HOME/.minimax"
```

```powershell
# Windows — permanently deletes the default user data
Remove-Item -LiteralPath "$env:USERPROFILE\.minimax" -Recurse -Force
```

A profile uses `~/.minimax-<profile>`; `MINIMAX_DATA_DIR` or `MAVIS_DATA_DIR` can select a different location. Remove only the specific directories you intend to discard, without wildcard deletion. Remove any MCode-specific environment variable assignments you added to shell profiles or user environment settings if you no longer need them.

## What you can do

| Task | Capabilities |
| --- | --- |
| **Edit and verify code** | Read files, inspect diffs, run shell commands and tests, and control tool execution with permissions and sandboxing. |
| **Choose your model** | Use a MiniMax account / Token Plan, or custom providers with OpenAI- or Anthropic-compatible API formats. |
| **Search and work with media** | Use built-in search, `mcode-tools` media tools, MCP, and managed connectors, subject to account access and service credits. |
| **Keep work moving** | Resume sessions, plan tasks, use subagents, and extend the agent with official, local, or GitHub plugins and built-in skills. |
| **Connect your workflow** | Run scripted tasks with the headless CLI, or connect compatible editors and clients through ACP. |

Account features, updates, feedback, and diagnostics are also included. Managed tools require network access and the relevant authorization. See [capabilities and service boundaries](docs/tui-capabilities.md) for details.


## Build from source

To develop Ncode or run this source checkout, you need Git, **Node.js 22.19+ (22.x), 24.2+ (24.x), 25, or 26**, and **pnpm 9.12.0**. On Windows, keep the checkout on a local NTFS volume and outside cloud-synced folders; the preflight command below checks the volume before pnpm creates workspace links.
```bash
node scripts/check-windows-source-location.mjs
pnpm install --frozen-lockfile
pnpm build
pnpm ncode
```

The first build requires an internet connection. Dependencies and the integrity-checked `mcode-tools` bundle come from public npm. See the [source installation guide](docs/installation.md) for pnpm setup, system dependencies, and updates.

From the source directory, use `pnpm ncode` in place of `ncode` in the examples above. To work on your own project, open its directory and launch the built CLI:

```bash
node /absolute/path/to/minimax-code/dist/cli.js
```

This checkout builds the **Niwa Labs Ncode 0.7.2** source fork. See the [source status](docs/open-source-status.md#version-and-evidence-baseline) for its upstream base and embedded tools.

## Documentation and contributing

- [Installation and account profiles](docs/installation.md)
- [Architecture](docs/architecture.md)
- [Contributing](CONTRIBUTING.md), [security reporting](SECURITY.md) and [third-party notices](THIRD_PARTY_NOTICES.md)

Use the Niwa Labs fork’s issues for fork behavior. For MiniMax accounts,
official installers or the desktop app, see [upstream MiniMax Code](https://github.com/MiniMax-AI/minimax-code).

## License

First-party code defaults to [MIT](LICENSE). Existing file-level and package-level licenses remain in place. See [third-party notices](THIRD_PARTY_NOTICES.md) and [license status](LICENSE-STATUS.md) for dependencies, assets, and `mcode-tools`.
