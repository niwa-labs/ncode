# MCode ACP

Build the Niwa Labs fork using the [source instructions](../../README.md#quick-start).
Then run `pnpm mcode acp` in the checkout. An editor can start the same server by
running `node` with the absolute path to the checkout's `dist/cli.js` and the
`acp` argument.

## Upstream npm launcher

`@minimax-ai/code-acp` is the launcher published by [MiniMax](https://agent.minimax.io). It runs the `mcode`
binary from `@minimax-ai/code`, forwarding all arguments, stdio, signals and the
exit code:

```sh
npx -y @minimax-ai/code-acp@<version> acp
```

Why: `@minimax-ai/code` ships two bins (`mcode`, `mcode-tools`), so
`npx @minimax-ai/code acp` cannot decide which to run. This package has a single
bin, which is what the [ACP registry](https://github.com/agentclientprotocol/registry)
npx distribution needs.

MiniMax publishes the launcher at the same version as its CLI and pins the CLI
dependency to that version. The ACP registry follows the upstream launcher.
