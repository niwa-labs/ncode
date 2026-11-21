# Verification

## Current source verification status

Run `pnpm verify` from a clean checkout. It checks the source export, dependency
boundaries, types, build artifacts, CLI and ACP smoke tests, offline BYOK,
permissions and platform-specific sandboxing. `pnpm verify --list` lists the
checks for your platform.

Local verification of the reconstructed runtime ran on macOS arm64 with Node
22.23.3 and pnpm 9.12.0. It used synthetic providers and temporary data
directories. The CLI tests exercised JSONL compatibility, cancellation,
media input and saved history after a daemon restart. The release archive
was installed in a temporary npm prefix and tested through its installed CLI.

These checks cover offline behavior on the tested host. Live login, provider
billing and quota resets, and Linux and Windows runtime behavior require their
own evidence.

## Upstream records

The [release audit](release-audit.md) records the older upstream TUI review.
The [upstream verification records](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/docs/verification.md)
preserve its import and live-service results.
