# MCode TUI Engine fork baseline

- Upstream repository: https://github.com/earendil-works/pi.git
- Upstream source: `packages/tui/src`
- Upstream ref: pinned `48c8f322844087ff6cd80885f093ad44557647d1` (`v1.3.0-51-g48c8f3228`)
- Upstream commit: `48c8f322844087ff6cd80885f093ad44557647d1`
- Upstream package version: `1.3.0`
- Imported at: `2026-08-18` (Pi `0.84.2`, commit `836aee6d38f60428ab6bd2679f93dce43a55dab3`)
- Fork established: `2026-08-19`
- Rebased to the pin: `2026-10-26` (W09; see the rebase log in `LOCAL_CHANGES.md`)
- Local baseline adaptation: relative `.ts` import suffixes are rewritten to `.js` for the MCode
  NodeNext build; no product behavior is added.

This directory is MCode-owned source. `BASELINE.json` preserves exact per-file upstream and adapted
hashes, while `LOCAL_CHANGES.md` records the fork delta. Pi is provenance and a future
selective-sync input, not a runtime boundary.

The engine snapshot is the pinned Pi `1.3.0-51` tree (NodeNext-adapted). The former selective Pi
`0.84.4` maintenance deltas L019/L020, the Engine source delta of L021, and the fork search-index
reuse L025 are upstream-equivalent at the pin and are retired in `LOCAL_CHANGES.md`; the W09 rebase
log records every carried or retired local delta.

The engine is compiled by the MCode package and is the only terminal/input/render foundation used by
the product startup path. Product code may only import `public.ts`; direct imports into
implementation files are forbidden. MCode product composition lives outside this directory and does
not change the upstream baseline digest. Validate the exact imported baseline independently with:

```bash
node packages/tui/scripts/verify-tui-engine-baseline.mjs --upstream-root /path/to/pi/packages/tui/src
pnpm --filter @minimax/code exec tsc --noEmit --pretty false
```

For future syncs, compare:

```bash
git log <previous-commit>..<next-commit> -- packages/tui
```

Then refresh this snapshot and review the relevant Pi TUI commits before changing MCode adapters.
