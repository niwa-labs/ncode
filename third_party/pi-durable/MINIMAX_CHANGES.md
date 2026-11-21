# MiniMax local changes for pi-durable and chord

This directory (`third_party/pi-durable`, plus its sibling `third_party/chord`) vendors two packages from the `pi` monorepo as source so MiniMax can integrate and patch the durable runtime and its typed host runtime without waiting on upstream release cadence.

- `third_party/pi-durable` ← upstream `packages/durable` (imported name: `@minimax/local/pi-durable`)
- `third_party/chord` ← upstream `packages/chord` (imported name: `@minimax/local/chord`)

## Upgrade policy

Upstream is never upgraded without a deliberate rebase. Do not bump the pin, copy newer sources over this tree, or cherry-pick upstream commits casually; any re-import must consciously re-apply the local changes listed below, refresh this pin, and be reviewed as a separate change.

## Import baseline

- Upstream: `https://github.com/earendil-works/pi.git`
- Ref: `refs/tags/v1.5.2`
- Commit: `b4afdddf44e059c67ccf5097e5317d913521b470` (Release v1.5.2)
- Imported at: 2026-11-11

## 2026-11-11 — native commit receipts and Chord v2

- Rebased durable and Chord to the same release as pi-mono; Chord now exposes its v2 host/contracts/watch APIs.
- Adapted the product SQLite storage and single-writer gate to native batched commits and ordered durable-prefix receipts. Preserved the legacy flat commit port at the existing product journal boundary. Known refusal keeps the writer usable; unknown commit failure poisons it while preserving confirmed prefix receipts.
- Product orchestration now supplies a real empty native Models registry rather than an unsafe structural stub; native reports use the new single-object callback. Product identity disables Pi CLI attribution.
- Kept the portable writer's MessageChannel scheduling fallback while making its handler assignment compatible with Node types.
- Migrated the separate product plugin-host adapter to Chord v2 contract declarations, load/reload, contexts and watch lifecycle. Preserved capability allowlists, canonical state ownership, SQLite guards and telemetry links. Included its entry point in standalone type checking so CLI reachability cannot hide adapter breakage.
- Native foreground GenerationTask is not enabled by this rebaseline. The existing canonical transcript, background compaction scheduler and product turn owner are retained.


The copied trees are byte-identical to upstream at that commit (verified with `diff -rq`), except for the local changes below.

## Local patch ledger

Baseline import; no upstream source files are changed.

- `pi-durable/package.json`: `name` changed from `@earendil-works/pi-durable` to `@minimax/local/pi-durable` (interim W00 name; see the 2026-10-23 W01 entry below).
- `chord/package.json`: `name` changed from `@earendil-works/chord` to `@minimax/local/chord` (interim W00 name; see the 2026-10-23 W01 entry below).
- Both renames existed only to avoid colliding with pi's npm publication. Dependency declarations still reference the upstream internal names (`@earendil-works/*`) on purpose.
- `../../tsconfig.base.json` (repository `src/tsconfig.base.json`): created for this vendor import, content identical to the upstream `pi` root `tsconfig.base.json`, because both vendored `tsconfig.build.json` files extend `../../tsconfig.base.json`.

### 2026-10-21 — removed the `test` scripts (MiniMax-specific glue, not upstream material)

- Affected: `pi-durable/package.json` (`test` script: `vitest --run && PI_DURABLE_DOCUMENT_RETENTION_MS=0 vitest --run && npm run test:workers` removed), `chord/package.json` (`test` script: `vitest --run` removed).
- Reason: both suites require the full upstream monorepo that this distribution does not vendor — `test/telemetry-sqlite.test.ts` imports `../../telemetry/src/testing/index.ts` (no `third_party/telemetry` exists), pi-durable tests import `../../ai/src/api/*.ts` (no `third_party/ai`; see "TypeScript paths left dangling on purpose") and resolve `@earendil-works/pi-codemode` (declared, not vendored) — and chord's `test/context.test.ts` calls `addLink`, which the vendored `@earendil-works/pi-telemetry@1.3.0` spans do not implement. Their suites are excluded from this distribution's verification per `src/AGENTS.md` ("Their test suites are not part of this distribution's verification"); keeping the scripts only made the workspace-wide `pnpm -r test` fail (`ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL @minimax/local/chord@1.3.0`).
- Failure counts at removal time: chord 3 files / 2 tests failed of 50 files / 548; pi-durable 45 files / 632 tests failed of 70 files / 1170.
- `pi-durable`'s `test:workers` script is kept — `pnpm -r test` never invokes it.
- Validation: `pnpm -r test` green across all workspace packages (2026-10-21); `node scripts/run-vitest-suite.mjs status-contract|policy|sandbox` green.

### 2026-10-23 — correction (W01 round 3): the `addLink` premise above is obsolete; durable/chord testability restored via G-PORT

- The 2026-10-21 reason describes the pre-W01 state and no longer holds. Its "vendored `@earendil-works/pi-telemetry@1.3.0` spans do not implement `addLink`" claim was true for the **npm-dist telemetry copy** of that time; since W01 part A/B the telemetry tree is vendored from the pin (`third_party/pi-mono/packages/telemetry`), where `addLink` **is** implemented: interface `telemetry/src/index.ts:106`, in-memory span `telemetry/src/memory.ts:206`, noop `telemetry/src/noop.ts:29`. Likewise `third_party/ai` (now `third_party/pi-mono/packages/ai`) and `@earendil-works/pi-codemode` are vendored, so the "not vendored" premises are gone too.
- What still fails — and why — is different: cross-tree **relative** imports (`../../telemetry/...`, `../../ai/...`) assume the upstream monorepo layout (`packages/chord` beside `packages/telemetry`/`packages/ai`); our vendored roots `third_party/chord` / `third_party/pi-durable` rename those paths, so those specific files cannot resolve (ERR_MODULE_NOT_FOUND, reproduced 2026-10-23). `../../chord/...` from pi-durable happens to resolve because the two roots are siblings.
- Testability restored (plan :687 «восстановить тестируемость durable/chord, включая `TelemetrySpan.addLink` drift»): the G-PORT gate now runs both trees through `vitest.port.config.mjs` — chord `test/context.test.ts` (the addLink caller) passes 7/7 against the vendored pin telemetry. Current selection: chord 48/50 files (548 tests) and pi-durable 68/72 files (1286 tests, 2 skipped) green; 6 files excluded with verified reasons (2 chord `../../telemetry` layout, 2 pi-durable `../../ai` layout + live-provider e2e, 2 `cloudflare:test` workers-runtime) — see `test/port-conformance-suites.json` inventory. This supersedes the 2026-10-21 failure counts (chord 3 files/2 tests failed; pi-durable 45 files failed).

## Required from the integrator

Dependency declarations were left untouched; the integrator must resolve them on the next step. Both packages declare `engines: node >=22.19.0`.

### pi-durable (`@minimax/local/pi-durable`)

Internal (pi monorepo packages, not on npm as resolvable workspace deps here):

- `@earendil-works/chord` `1.3.0` — vendored here as `third_party/chord` (`@minimax/local/chord`); needs an alias/override
- `@earendil-works/pi-ai` `1.3.0`
- `@earendil-works/pi-codemode` `1.3.0`
- `@earendil-works/pi-telemetry` `1.3.0`

External:

- `@silvia-odwyer/photon` `0.3.3`
- `diff` `8.0.4`
- `typebox` `1.3.27`

External devDependencies (test/build only):

- `@cloudflare/vitest-plugin` `1.4.4`
- `shx` `0.3.4`
- `vitest` `4.1.11`

### chord (`@minimax/local/chord`)

Internal:

- `@earendil-works/pi-telemetry` `1.3.0`

External:

- `typebox` `1.3.27`

External devDependencies (test/build only):

- `@types/ws` `8.18.2`
- `shx` `0.3.4`
- `vitest` `4.1.11`
- `ws` `8.21.0`

### TypeScript paths left dangling on purpose

`pi-durable/tsconfig.build.json` maps `@earendil-works/chord` to `../chord/dist/index.d.ts` (resolves to `third_party/chord` and requires its built `dist`) and `@earendil-works/pi-ai` to `../ai/dist/index.d.ts` (dangling — no `third_party/ai` exists). The integrator decides how internal `@earendil-works/*` imports resolve (aliases, overrides, or workspace links); these declarations were not rewritten.

For future changes, add one entry per MiniMax patch with reason, affected package, whether the change is generic upstream material or MiniMax-specific glue, and validation commands and results.

## 2026-10-23 · W01 part B: upstream names restored, workspace closure

- `pi-durable/package.json`: `name` restored to the upstream `@earendil-works/pi-durable`; `@types/node` `22.19.19` added to `devDependencies` (matches the pi-mono vendored packages; upstream provides these types from the monorepo root, which we do not vendor).
- `chord/package.json`: `name` restored to the upstream `@earendil-works/chord`; `@types/node` `22.19.19` added to `devDependencies` for the same reason.
- Rationale: with the interim `@minimax/local/*` names, every `@earendil-works/{chord,pi-durable}` dependency (including the new `packages/env` of the pi-mono vendor) resolved to the public npm releases `@earendil-works/{chord,pi-durable}@1.3.0` instead of these vendored trees (verified: lockfile integrity hashes matched registry.npmjs.org; the alias overrides in `pnpm-workspace.yaml` never took effect under pnpm 9.12). Restoring the upstream names plus `link-workspace-packages` makes the version-matched specs resolve to these workspace trees; the failed alias overrides were removed. `pnpm-lock.yaml` now records `link:` for every `@earendil-works/*` edge of the vendored closure and holds no registry entry for any `@earendil-works/*` package.
- No source files were changed; the trees remain byte-identical to pin `48c8f32` outside `package.json`.
- Accepted risk, recorded deliberately (W01 round-2 review): the original reason for the interim `@minimax/local/*` names was "avoid colliding with pi's npm publication" — that reason is cancelled by this rename. Publishing or installing this source distribution under the public names `@earendil-works/{chord,pi-durable}@1.3.0` collides with the upstream npm releases of the same name/version: inside this workspace pnpm resolves the vendored trees (`link:` edges, no registry fallback), but an environment that installs from a registry instead of the workspace could silently fetch upstream artifacts. Guards: `pnpm-lock.yaml` carries zero registry entries for `@earendil-works/*` and the `port-deps` suite (`test/port-dependency-exports.test.ts`) fails if any vendored `@earendil-works/*` edge stops being a workspace link or a registry record appears. Divergence from the plan's AS-IS note («локальные имена `@minimax/local/*`», plan §1.1) is recorded there and in `state/w01-build.md`.
- Review status: the rename was independently reviewed by the opposite network (mcode review, W01 rounds 1–2: "технически вынужденное и корректное", `hybrid-plans/upstream/port-pi-1.3/reviews/w01-review-round1.md`); final R sign-off for the W01 tree happens in the next review round over the round-2-fixed tree.

## Product foreground execution

The MCode foreground adapter runs the built-in GenerationTask and ToolTask in the existing Harness. The afterTools hook may terminate the generation after all tool outcomes settle, so product stop decisions apply at the same boundary. Product compaction and physical request retry policies are configured by the host.
