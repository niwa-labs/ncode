# Source status

Niwa Labs distributes Ncode as source and as the npm package `@niwa-labs/ncode`. MiniMax publishes the official
installers and registry packages.

## Version and evidence baseline

| Concern | Version or revision |
| --- | --- |
| Ncode CLI and workspace | 0.1.0 |
| Upstream MCode | 0.7.2 |
| Git fork base | `3c21163c85a9684030cb147bfef48c6284fa3c46` |
| Earlier upstream source extraction | `9b9885e42a3cf1a3df1cfa52a46e4fdb034cfcee` in `release/extraction.json` |
| Pi, Pi Durable and Chord | Pi v1.6.0 + 43 commits (`780bf31f`), with fork changes noted under `third_party/` |
| Embedded mcode-tools | 0.0.4, extracted from the pinned public npm archive |

The product version identifies the CLI interface. The build receipt records the
source revision. See [Verification](verification.md) for the tested scope and
the [historical release audit](release-audit.md) for upstream evidence.

## Source boundary

The source tree includes terminal, headless and ACP clients, the local daemon,
durable session history and context, and compatible BYOK and MiniMax account
clients. Some capabilities require accounts, quota, or external services.
[Architecture](architecture.md) describes how they connect.

## Repository baseline

The checked-in [source inventory](../release/public-source.json) lists the files
included in the source export. See [license status](../LICENSE-STATUS.md) and
[third-party notices](../THIRD_PARTY_NOTICES.md) for their terms.
