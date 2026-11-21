# Source boundaries

By default, the terminal, `mcode exec`, and ACP connect to the same daemon for
the selected profile and data directory. The CLI starts the daemon on demand.
It runs the local runtime and owns the shared orchestration log. Set
`MCODE_SERVER_MODE=off` to run the runtime in the client process.

- `packages/tui` owns the three CLI surfaces and their runtime adapters.
- `packages/mcoded` owns the daemon and its local socket. It carries turn
  events, permission decisions, queue receipts, and reconnect cursors.
- The [local runtime](../packages/local-runtime-v2) owns sessions, turns, tool execution, and
  orchestration. Each session gets its own durable SQLite/Zstd history store.
  The runtime can read the older shared store and supports JSONL through
  `MCODE_HISTORY_PROVIDER=jsonl`.
- The context packages project canonical history, bound media residency,
  compact history into checkpoints, and assemble provider requests.
- Pi v1.5.2 runs the provider and tool loop. Pi Durable and Chord supply
  persistence and orchestration primitives. Their licenses and pins are in
  [Third-party notices](../THIRD_PARTY_NOTICES.md).
- `packages/local-runtime` supplies shared host facilities such as permissions,
  filesystem tools, databases, and sandboxing. OAuth Core manages MiniMax
  credentials. The tool launcher obtains short-lived leases from the host.

The private `@mavis/*` packages resolve to workspace sources.
`release/public-source.json` lists the exported files. `pnpm check:source`
checks the inventory and `pnpm check:standalone` checks the build graph.

See [Installation](installation.md#local-daemon) for daemon commands and
[Verification](verification.md) for the scenarios exercised by local tests.
