# MiniMax local changes for pi-mono

This directory vendors `pi-mono` as source so MiniMax can patch, validate, and ship agent-loop fixes without waiting on upstream release cadence.

## Import baseline

- Upstream: `https://github.com/earendil-works/pi.git` (the pi monorepo; the 0.79.x baseline was published as `pi-mono.git`, both share history)
- Ref: `refs/heads/main`, commit `780bf31fcaeb252fa9b68df3964c735eae75bde3` (43 commits after v1.6.0)
- Imported at: 2026-11-22
- Previous baseline: v1.5.2, commit `b4afdddf44e059c67ccf5097e5317d913521b470`, imported 2026-11-11

## 2026-11-22 — Pi 1.6.0 and subsequent main updates

Ncode imports the upstream libraries as workspace source. The provider adapters, agent loop, coding tools and MCP library use this baseline with the product hooks recorded below. Pi Durable and Chord are maintained in their sibling vendor directories. Ncode owns the terminal, daemon, session storage and delivery of queued input. The standalone Pi apps are outside this source projection.

## 2026-11-11 — Pi 1.5.2 rebaseline

- Three-way merged the previous `48c8f322` baseline, the local working tree and release `v1.5.2`; retained product agent-loop ownership/steering hooks, system-section patches, tool execution facts, output stream separation and bounded edit receipts.
- Added the upstream `pi-schema` package and adopted the native TypeBox-compatible tool/schema API. Preserved MiniMax package source exports; added source-side effect entries for image registration in the standalone bundle.
- Replaced the old blanket empty-tools omission with upstream's explicit `requiresToolsWithToolHistory` compatibility switch. Default requests still omit empty tools; configured backends can opt in. This supersedes the October 24 empty-tools patch below.
- Kept upstream byte-preserving edit writes and child-process timeout cleanup; retained product execution observations and bounded diff/patch rendering. Compute bounded receipts before writing, preserving the upstream guarantee that a diff exception leaves the file unchanged; adapted the upstream mock to the bounded renderer. Preserve the upstream explanation and typed facts when the shell finished but descendant output caused a timeout.
- Hydrated the public provider catalog using the release-specific official catalog endpoint, including its current schema and provider shards.
- Explicitly opted product Agent construction out of Pi CLI attribution. Product prompt/cache layout, background compaction and daemon/ACP ownership remain product policy.
- Historical ledger entries below describe earlier imports; where upstream implementations replaced a patch, this rebaseline entry takes precedence. Product foreground execution still uses `pi-agent-core`; native durable foreground generation is a separate architectural transition, not claimed by this version update.

## Local patch ledger

All `src/**`, `test/**`, docs, and asset files under `packages/{agent,ai,coding-agent,tui}` are byte-identical to the pinned upstream trees except where a ledger entry below records the delta: packaging adaptations (per-package `package.json`, vendor-root `tsconfig.base.json`) and behavior patches re-applied per the §5.1 patch registry (`state/w01-patch-registry.md`).

### 2026-10-24 — reapply №6 empty-tools omission onto the pin (W06 part A; registry PR-05, verdict take)

- Reason: the pin still sends `tools: []` when a conversation has tool history but no request tools (`api/openai-completions.ts` `else if (hasToolHistory(...)) params.tools = []`, comment "Anthropic (via LiteLLM/proxy) requires tools param"). Registry PR-05 №6 (original in-repo fix `bf3916f` "omit empty tools from OpenAI compaction requests"): OpenAI-compatible backends (DashScope/Qwen compatible-mode) reject `tools: []` with HTTP 400 `"[] is too short - 'tools'"`.
- Change: the `else if` branch and the `hasToolHistory` helper are removed — no request tools means the `tools` field is omitted entirely, tool history or not (the 0.79 fix's exact shape). The proxy-concern conflict named by the registry is resolved by scope: Anthropic-behind-proxy deployments route through the anthropic-messages api, which is untouched. Mirrored into the untracked `dist/api/openai-completions.js` build artifact (same convention as the W02 round-3 detectCompat mirror).
- The pin's own `test/openai-completions-empty-tools.test.ts` carried the opposite assertion ("still emits tools: [] for Anthropic/LiteLLM proxy…"); its final case now asserts omission (renamed "omits tools when conversation has tool history but no tool definitions") — the upstream test is the mcode regression restored per the registry's removal condition («тест на target (G-PORT)»). The file is also added to `test/port-conformance-suites.json` ai selection so G-PORT runs it permanently.
- Validation (run in this round): `npx vitest run --config vitest.port.config.mjs third_party/pi-mono/packages/ai/test/openai-completions-empty-tools.test.ts third_party/pi-mono/packages/ai/test/openai-completions-tool-choice.test.ts third_party/pi-mono/packages/ai/test/openai-completions-cache-control-format.test.ts` → 64 passed; full `node scripts/run-port-conformance.mjs ai` → 11 files / 148 passed (was 10/137). The reapply also closes the documented W02/W04/W05 carry-forward `compaction-openai-transport.integration.test.ts 6 failed|1 passed` (its fake provider rejects `tools: []` exactly like DashScope): now `npx vitest run --config vitest.oss.config.mjs packages/local-runtime-v2/test/integration/compaction-openai-transport.integration.test.ts` → 7 passed.
- Removal condition: upstream takes the omission (or documents a real OpenAI-compat backend that requires `tools: []`), superseded by a target-tree test; cross-review by the opposite network at execution time (R-gate of the W06 wave cycle).

### 2026-10-24 — close the default-thinking-models temporary copy via pin catalog metadata (W06 part A; registry PR-03 №12/№37, verdict adapt)

- Reason: the W02-round-2 product-side copy `local-runtime-v2/src/service/model-system/resolution/default-thinking-models.ts` (`DEFAULT_THINKING_MODEL_IDS`/`isDefaultThinkingModelId`, the 0.79-era local pi-ai patch) carried the hardcoded Claude default-thinking family. Its removal condition was "W06 reapply lands". No vendored `src/**` or `dist/**` bytes change in this entry: the pin's own catalog metadata is the mechanism — every family member at the pin carries `compat.forceAdaptiveThinking: true` (`providers/data/anthropic.json`: opus-4-6/4-7/4-8/5/5-5, sonnet-4-6/5/5-5, fable-5/5-1, haiku-5-5), the same metadata the pin's native anthropic-messages path branches on.
- Product change: `default-thinking-models.ts` deleted; new `resolution/adaptive-thinking-models.ts` classifies the family as `getBuiltinModels('anthropic')` entries with `compat.forceAdaptiveThinking === true` (keeping the 0.79 `[1m]`-decoration tolerance and case/trim normalization). Consumers re-pointed: `resolution/model-ref.ts` (`resolveModelThinkingProtocol` anthropic branch: effort kept on `output_config`, `thinking` omitted for family ids) and `turn-system/agent-host/assembly/local-turn-payload-transform.ts` (`patchThinkingPayload` guard). The mcode wire-form preference itself stays host-side (the pin has no "omit thinking, keep effort" wire form); only the family classification source changes from list to pin metadata, per the registry verdict «перепроверить/переписать поверх metadata-пути пина».
- Behavior deltas (both registry-sanctioned consequences of metadata-driven classification): `claude-mythos-5`/`claude-mythos-preview` (in the 0.79 list, absent from the pin catalog) now follow the generic adaptive path; catalog-only family members (`claude-opus-4-6/4-7/4-8`, `claude-sonnet-4-6`, `claude-fable-5-1`, `claude-haiku-5-5`, `claude-opus-5-5`, `claude-sonnet-5-5`) are now matched without a product-side list entry.
- Validation (run in this round): `npx vitest run --config vitest.oss.config.mjs packages/local-runtime-v2/src/service/model-system/resolution/model-ref.test.ts` → 74 passed (incl. 5 new pin-metadata parity tests: classification ≡ live pin catalog `forceAdaptiveThinking`, `[1m]`/case tolerance, bracket-suffix negative, mythos follow-the-pin, non-family rejection); `.../resolution/local-model-resolver.test.ts` → 109 passed; `.../agent-host/assembly/local-turn-payload-transform.test.ts` → 7 passed; new `.../resolution/pi-provider-surface.test.ts` (4) asserts all 42 builtin providers resolve through the product resolver (typesafe is classifier-only) incl. minimax/minimax-cn/zai/zai-coding-cn/kimi-coding and the adaptive-family parity.
- Removal condition: none to remove — the copy is gone; this entry records that the family now lives on pin metadata. Revisit only if the pin catalog drops `forceAdaptiveThinking` (a pin bump changes the family set automatically, which is the intended data-driven behavior).

### 2026-10-24 — re-apply the six agent-loop host seams onto the pin (W04 part A; registry §5.1 rows 1/15/16/17/44 + row 32 host migration)

- Reason: the 2026-10-23 rebaseline deliberately did NOT re-apply the six MiniMax agent-loop seams (see that entry's "Agent-loop seams" fate paragraph — migration owned by W04). W04 part A now ports them. Row 32 (`shouldStopAfterTurn`) needs NO vendored change: it migrates host-side onto the pin-native `finishTurn` hook (product `true` → `{action:"end"}`, `false`/`undefined` → undefined, never `continue`) in `packages/agent-core/src/pi-turn-runner/{agent,events}.ts`. The other five seams have no native pin surface, so they land here as the plan-sanctioned «точечный vendored driver seam с ledger» (port plan :729).
- Changes to `packages/agent/src/types.ts`: `BeforeToolCallResult.terminateAgent?: boolean`, `AfterToolCallResult.terminateAgent?: boolean`, `AgentToolCallOutcome.terminateAgent?: boolean` (row 16); `AgentLoopConfig.shouldStopAfterSteering?: () => boolean | Promise<boolean>` (row 15, post-dequeue steering admission veto); `AgentLoopConfig.unexpectedToolCallFallback?: string` (row 1); `AgentLoopConfig.onToolExecutionStart?: (context: BeforeToolCallContext) => void` (row 17).
- Changes to `packages/agent/src/agent-loop.ts`: veto call site after the post-turn steering poll (wins over pending tool continuation, emits `agent_end`, no further provider request); `normalizeUnexpectedToolCall` applied to every finalized result of `streamAssistantResponse` (successful structural tool calls become terminal text with `stopReason:"stop"`; error/aborted untouched); `terminateAgent` threaded from blocked `beforeToolCall` results and `afterToolCall` overrides through `FinalizedToolCallOutcome`; whole-agent batch termination — sequential: remaining calls get skipped error outcomes («Tool execution skipped because the agent was stopped by a hook»); parallel: prepared-but-unstarted entries are replaced and the not-yet-prefetched tail appended as skipped outcomes (parallel entries switched from closures to `{kind:"prepared-entry"}` objects so replacement is possible before any effect starts; the abort-check-at-execution semantics of the pin's closures are preserved verbatim in the executor branch); `shouldTerminateToolBatch` = `some(terminateAgent) || every(result.terminate)`; `onToolExecutionStart` fired inside `executePreparedToolCall` immediately before `tool.execute` (after validation + admission; denied/blocked/skipped/aborted calls never reach it) via the `admittedExecutionStart` helper. Semantics taken byte-faithful from the pre-rebaseline fork (`git show 624746c:third_party/pi-mono/packages/agent/src/agent-loop.ts`), with one deliberate narrowing: on plain `signal.abort` the pin's original no-outcome break is kept (skip-with-outcome fires only for `terminateAgent`), matching the pin's own abort contract rather than the 0.79 fork's.
- Changes to `packages/agent/src/agent.ts`: `PendingMessageQueue` stores single messages OR atomic groups — `enqueueBatch` (row 44 `steerBatch`), `one-at-a-time` drains one ITEM (a group is never split), `all` flattens; `peekQueuedMessages`/`hasQueuedMessages` unchanged in contract (peek still never consumes); `Agent` gains public `onToolExecutionStart`, `shouldStopAfterSteering`, `unexpectedToolCallFallback` fields (constructor + `createLoopConfig` forwarding) and the `steerBatch(messages)` method.
- New vendored regression suite `packages/agent/test/minimax-seams.test.ts` (14 tests) — ported from the pre-rebaseline `agent.test.ts`/`agent-loop.test.ts` seam tests onto the pin harness: steerBatch atomic slot + peek≠consume, steering-veto graceful end with zero extra requests, terminateAgent before-denial/parallel-prepared/mixed-after-hook skips with one outcome per toolCallId, ordinary block stays non-terminal, native batch `terminate` rule intact, `onToolExecutionStart` order (`before → execution-start → execute → after`) and never-fired-for-denied, unexpected-tool-call fallback (error/aborted pass-through; guidance appended once).
- Validation (run in this round): `pnpm exec vitest run --config vitest.port.config.mjs third_party/pi-mono/packages/agent/test/` → agent.test.ts + agent-loop.test.ts + proxy/e2e untouched suites 78 passed (pin behavior unbroken) + minimax-seams.test.ts 14 passed; product side `packages/agent-core` typecheck: the six seam blockers (events.ts shouldStopAfterTurn×2 + steerBatch, tools.ts onToolExecutionStart + terminateAgent×2, hooks.ts CustomMessage, llm.ts PiBeforeLlmCallAppendMessage×8, agent.ts prompt overload) all resolved, 0 new errors (4 pre-existing W01-baseline errors remain, owned by W01-C/W06/W02-part-B rows); `pnpm -C packages/agent-core test` → 9 files, 195 passed (184 pre-existing + 11 new `w04-turn-loop.test.ts`).
- Removal condition: per registry §preamble — upstream takes an equivalent seam, or the registry row is superseded with a target-tree test; cross-review by the opposite network at execution time (this entry is the execution record; R-gate MiniMax review of W04 follows the wave cycle). Row 32 closes without a vendored delta (host-side migration is its removal condition met).

### 2026-10-24 — reapply №7–10 system-role hosts onto the pin (W02 round 3; capability-gate red on `local-model-resolver.test.ts`)

- Reason: the capability gate (372-file suite) surfaced the 20 "keeps the system role for a thinking model" failures recorded as known-red in the round-2 entry below. Root cause per registry PR-04 (families №7–10, verdict **take**): the pin's `detectCompat` (`ai/src/api/openai-completions.ts:1601–1698` at the pin) has no mistral/siliconflow/dashscope/kimi host entries, so a reasoning model on those custom-provider baseURLs resolved `supportsDeveloperRole: true` and sent `developer`.
- Change (minimal reapply, registry: «реапплай меньше оригинала»): `packages/ai/src/api/openai-completions.ts` `detectCompat` — four exact-host regexes (`isKimiCoding`, `isDashScope` incl. the regional `*.maas.aliyuncs.com` pattern, `isSiliconFlow`, `isMistralApi`) and the `supportsDeveloperRole` conjuncts, byte-shape taken from the pre-rebaseline patch (`providers/openai-completions.ts:1071–1076, 1101–1104` at `624746c`). Only the developer-role conjuncts are reapplied — the old hosts do not join `isNonStandard`/`useMaxTokens`/`thinkingFormat` (0.79 did not put them there either). Explicit `model.compat.supportsDeveloperRole` still wins (native pin precedence `getCompat` `model.compat.supportsDeveloperRole ?? detected`). Mirrored into the untracked `dist/api/openai-completions.js` build artifact (wildcard-subpath consumers, e.g. `local-runtime` tokenizers, resolve dist).
- Lookalike hosts stay on `developer` (anchored `^https?://…(?:\/|$)` regexes, regional maas allow-list): verified by the existing negative cases in `local-model-resolver.test.ts` (`gateway.example/…`, `…example/v1`, `unknown-region.maas…`, `cn-beijing.aliyuncs.com` without `maas`).
- Validation (all run in this round): `npx vitest run --config vitest.oss.config.mjs packages/local-runtime-v2/src/service/model-system/resolution/local-model-resolver.test.ts` → 109/109 passed (was 20 failed); vendored pin tests against the patch via `vitest.port.config.mjs` — `openai-completions-tool-choice` (incl. its `developer`-role assertions), `openai-completions-cache-control-format`, `openai-completions-raw-stop-reason`, `openai-completions-thinking-as-text`, `max-thinking`, `cache-retention` → 98 passed | 4 skipped; `fetch-option`, `mistral-reasoning-mode`, `anthropic-federation`, `compat-env` → 35 passed.
- Removal condition: same as PR-04 — upstream takes the host list, or the registry row is superseded with a target-tree test; cross-review per registry §preamble at execution time (this entry is the execution record for W02's gate scope; the registry's W01-C slot keeps the remaining families).

### 2026-10-24 — restore build-blocked consumer imports after the rebaseline (W02 round 2; review finding: `dist/cli.js` missing)

- Reason: the reviewer's `node dist/cli.js` failed with MODULE_NOT_FOUND because `scripts/build.mjs` wipes `dist/` before bundling (`scripts/build.mjs:35`) and the bundle had been failing since the 2026-10-23 rebaseline — the pin's export surface no longer covers what product consumers import. Four distinct gaps, all packaging/import-site only, no vendored `src/**` bytes touched:
  1. `./auth-storage` subpath export re-added to `packages/coding-agent/package.json` (mapping to the byte-identical vendored `src/core/auth-storage.ts`). Pre-rebaseline vendor exposed it (0.79-era adaptation); consumers: `local-runtime` `hosted-agent-capabilities.ts:3`, `host-turn-service-factories.ts:2`, `local-runtime-v2` `codex-oauth.ts:4`. The pin's root `index.ts` cannot substitute — it re-exports only `readStoredCredential` (`src/index.ts:26`), consumers need the `AuthStorage` class (`src/core/auth-storage.ts:328`). This manifest is the single source for `packageExportEntries` (`scripts/lib/package-exports.mjs:44`) → TS paths, Vitest alias, and the build plugin all healed at once.
  2. pi-ai simple-call and static-catalog helpers moved to the `./compat` entry at the pin (root index explicitly carries "no compat", `ai/src/index.ts:5-8`; `streamSimple`/`completeSimple` in `compat.ts:278/295`, `getModel`/`getModels`/`getProviders` deprecated aliases `:65-71`). 13 consumer import sites re-pointed root→`/compat` (`agent-core` llm/llm-stream-timeout, `local-runtime` + `local-runtime-v2` byok-error-attribution ×2, dynamic-max-tokens ×2, context-usage-turn-tracker, model-catalog, local-model-resolver, provider-api, production-composition, goal-evaluator-verifier, test-connection) plus 3 test files. Mirror of the pin's own consumer pattern (`coding-agent/src/core/sdk.ts:4`).
  3. `convertResponsesMessages`/`convertResponsesTools` re-pointed to `@earendil-works/pi-ai/api/openai-responses-shared` (registry row №34 "replaced-by-upstream … consumers change import path only"): `local-runtime/src/context/responses-input-tokens-body.ts:3`.
  4. `generateSummary` moved from pi-agent-core's 0.79 harness into the pi-coding-agent root (`coding-agent/src/index.ts:45`) with a widened signature and a changed contract — returns `Promise<string>`, no `Result` wrapper. `agent-modules/context-manager/src/manager.ts` re-pointed and its fallback call adapted to try/catch, preserving the `context_manager_summary_failed:` log prefix (the `result.error.code` segment is dropped: pin failures carry no code).
- Related product-side copy: `local-runtime-v2/src/service/model-system/resolution/default-thinking-models.ts` (NEW) temporarily carries `DEFAULT_THINKING_MODEL_IDS`/`isDefaultThinkingModelId` — a 0.79-era local pi-ai patch (`providers/anthropic.ts:160-177` at `624746c`) absent at the pin; same pattern and time-boxing as the bash-execution contract copy above. Consumers: `model-ref.ts`, `local-turn-payload-transform.ts` (+ their tests). Removal condition: W06 reapply (adaptive/default-thinking family №12/№37).
- Validation: `node scripts/build.mjs` green (was failing `Unmapped workspace export: @earendil-works/pi-coding-agent/auth-storage` and then `No matching export … streamSimple/getModels/getProviders/isDefaultThinkingModelId`); `node dist/cli.js --version` → `0.6.5` exit 0; `dist/{mcode-tools,mcoded,history-import}.js` smoke ok; `test:smoke` 0 fail; W02 suites 11 files / 87 tests green; affected unit batch 10/11 files green; `pnpm check:source` (after `--write` recorded `default-thinking-models.ts`), G-PORT `--inventory-only` (no drift), `check:tsconfig` (183 paths), `check:standalone` all pass. Typecheck: 159 → 100 errors (tsc, `tsconfig.standalone.json`, HEAD baseline via temp worktree); no file left newly broken — `codex-oauth.ts` errors replace its HEAD-time TS2307 module-not-found with the visible AuthStorage API drift.
- Known red carried forward (pre-existing, ledger-owned, NOT this round): `local-model-resolver.test.ts` (20) — pin `detectCompat` lacks our system-role-host handling (№7–10 take-family, W01-C reapply); `codex-oauth.test.ts` (5) + residual AuthStorage consumer type errors — pin AuthStorage surface drift (W04 host migration). Both files did not even load at HEAD.

### 2026-10-23 — rebaseline to pi `48c8f322` (PORT-PI-1.3, W01 part A): full-tree vendor replacement

- Reason: PORT-PI-1.3 W01 replaces the upstream base of the four vendored packages wholesale instead of maintaining a backport chain (port plan §5: «заменить upstream-базу четырёх старых пакетов целиком», no 1.3/0.79 runtime mixture). `packages/{agent,ai,coding-agent,tui}` were replaced with the full trees of `48c8f322844087ff6cd80885f093ad44557647d1` (`v1.3.0`+51). Upstream package versions at the pin are already `1.3.0` with unchanged `@earendil-works/*` names.
- Mechanical (non-behavioral) adaptations applied on top of the pin trees, following the vendor conventions already present on this branch:
  - `package.json` (each of the four): the `scripts` key is omitted, as in the previous vendored state; upstream test suites return exclusively through the W01 port-conformance gate (port plan §5.5: «Тесты, исключённые из стандартной source distribution, вернуть как отдельный port-conformance gate»). Intra-vendored `@earendil-works/*` dependency specs were changed from exact `1.3.0` to `workspace:*` (agent → pi-ai; ai → pi-telemetry; coding-agent → pi-agent-core/pi-ai/pi-codemode/pi-mcp/pi-tui), matching the prior pi-mono vendor convention and failing loudly instead of silently resolving `@earendil-works/pi-telemetry|pi-codemode|pi-mcp` from npm while those vendor roots do not exist yet (port plan W01 risk «скрытая npm копия ai»; §5.5 «нельзя случайно получить 1.3 из npm рядом с 0.79 из workspace»).
  - Vendor-root `tsconfig.base.json`: replaced with the pin's repo-root `tsconfig.base.json` verbatim (ES2024, `verbatimModuleSyntax`; drops the 0.79-era `experimentalDecorators` / `emitDecoratorMetadata` / `useDefineForClassFields` / ES2022 local adaptations). The repo-root `src/tsconfig.base.json` (W00 copy of the same upstream config) is already identical to it.
- Fate of the previous ledger (45 entries below) at this rebaseline — decisions come from port plan §5.1, wave ownership from the plan's wave table:
  - **Agent-loop seams — not reapplied to the vendored tree; migration is owned by W04** («six seam behaviors §5.1», «migrate shouldStop hooks», pinpoint vendored driver seam is a W04 file item). Verified at the pin: native `finishTurn` / `prepareRequest` hooks exist (`packages/agent/src/types.ts`, `src/agent.ts`), while `steerBatch`, `terminateAgent`, the post-admission `onToolExecutionStart` callback, `unexpectedToolCallFallback`, `shouldStopAfterTurn`, and the post-steering admission seam are all absent upstream. Affected entries: 2026-09-08 `steerBatch`; 2026-08-22 whole-agent termination from tool hooks (`terminateAgent`); 2026-08-22 admitted tool execution boundary (`onToolExecutionStart`); 2026-10-06 opt-in fallback for unexpected provider tool calls (`unexpectedToolCallFallback`); 2026-07-15 turn-boundary stop hook on `Agent` (`shouldStopAfterTurn` → `finishTurn`, product `true` → end, `false` → undefined, not continue); 2026-08-22 graceful stop after steering admission (→ structured admission veto). Their exact 0.79.1 hunks are inventoried in `hybrid-plans/upstream/port-pi-1.3/inventories/snapshot.md` §4.1 and remain retrievable from git history (tree at `624746c66584bd64ba48f652b1e4735d3a9f798f`).
  - **Independent packaging/provider/tool patches — reapply onto the pin is W01-C work** («переапплаить независимые packaging/provider/tool patches из §5.1») and is intentionally not part of this rebaseline: provider `fetch` / OAuth fetch+refresh+initial Codex exchange / stream-event observer; `onProviderError` raw observation; Anthropic classifier refusal + signature-only thinking + adaptive/default thinking + Fable matcher; OpenAI-compatible system-role hosts (Mistral/SiliconFlow/DashScope/Kimi); empty-tools omission + Codex SSE header deadline + exported Responses conversion helpers; GPT-5.6/Max catalog + deterministic model build; edit bounded diff / `patchOmitted` + fuzzy matched-span normalization + fidelity guard; Bash/Read exact execution facts + split streams + bounded output + optional process-fact observation; Windows lifecycle rows (ConstrainedLanguage, taskkill hardening, graceful SIGTERM→grace→SIGKILL, parent-death guardian, PowerShell 5.1 exit codes); Photon image fallback / asset packaging / native path; `CancellableLoader` constructor types; BEL OSC 8; packaging/deps/test-only rows (asset copy without nested shell binaries, network/glob dependency pins, test-robustness rows) — each keeps its separate fate per §5.1/§5.7.
  - «Принято upstream» supersede claims require a test on the target tree (port plan §5 item 7); no such claim is made in this rebaseline even where a family looks upstream-equivalent (e.g. the 2026-07-31 signature-only thinking entry originated from merged upstream PR #6457).
- Product consumers (agent-core / local-runtime / TUI / lockfile) are deliberately not adapted in this part — that is W01's consumer-adaptation step and waves W02+ (this branch's open host-migration blockers are expected until the W04 integration train exits).
- Validation: placed trees diffed against `git archive 48c8f322…:packages/<pkg>` — identical except the documented `package.json` adaptations (no other file differs); all four vendored versions verified `1.3.0`. `pnpm install` and scoped G-TYPE/G-BUILD of the new closure are intentionally not run here: the closure is incomplete until the `telemetry`/`codemode`/`mcp`/`env`/`evals` vendor roots land (W01), and an install must not fall back to npm for the missing pi packages.

### 2026-10-23 — offline model-catalog hydration source (PORT-PI-1.3, W01 part B) — deviation resolved in review round 1

- Reason: W01-T requires catalog hydration/pin tests offline. The pin does not carry `packages/ai/src/providers/data` bytes: upstream generates them through the network pipeline (`generate-models`, pi.dev) pinned by the repo-root `nix/model-catalog.json` → revision `sha256-ffa3e98626230f378f80200debb736c4a2238b5f2ba246a92cfc7d8e19604678`.
- Round-1 deviation (review `w01-review-round1.md` item 5): the data dir was initially hydrated from the published npm release `@earendil-works/pi-ai@1.3.0` dist bytes instead of the pin's fresher nix-pinned catalog revision. **Resolved**: the data dir has been re-hydrated from the pin revision itself — bytes fetched from `https://pi.dev/api/models/revisions/sha256-ffa3e98626230f378f80200debb736c4a2238b5f2ba246a92cfc7d8e19604678?types=chat,image,classifier`, sha256 of the body verified equal to the revision id (the same check `scripts/update-model-catalog-pin.mjs` performs), then fed through the vendored `packages/ai/scripts/hydrate-model-catalog.ts` (byte-identical to the pin), which stamps the manifest deterministically (`generatedAt` 1970-01-01, `structureHash` 0269b76c…).
- The pin revision is materially fresher than the npm 1.3.0 dist (built 2026-10-15): provider-level delta release→pin — `nvidia` −1 (`nemotron-3.5-super-vl-120b-a12b`), `opencode-go` +2 (`minimax-m2.7`, `grok-4.6`), `opencode` −1 (`nemotron-3.5-super-vl-free`), `openrouter` +1/−4/12 updated, `vercel-ai-gateway` −6. All 42 other providers byte-identical; group keys (`provider/type/api`) unchanged everywhere, so the pin's `src/models.generated.ts` types still match.
- Validation: `node scripts/check-model-data.ts` → «Generated model data is valid.» (manifest sha256, structureHash, provider/model groups) and the G-PORT `ai` suites (`model-catalog-types`, `models-runtime`, `models-entry`) green through `scripts/run-port-conformance.mjs`.
- Reproduction: `curl '<revisions URL above>'` (sha256 must equal `ffa3e986…678`), then `node --experimental-strip-types scripts/hydrate-model-catalog.ts models.all.json` from `third_party/pi-mono/packages/ai`.

### 2026-10-23 — temporary product-side copy of the bash-execution contract (W01 rounds 2–3)

- The §5.1 families `bash-execution-outcome` / `parent-death-guard` / `bash-facts` are **not reapplied** to this vendored tree (see the rebaseline entry above; reapply is W01-C). To keep product consumers compiling against the pin (:683 «адаптируются минимально для compile»), `packages/agent-tools/src/desktop/local-bash-result.ts` carries a **temporary, explicitly-marked copy** of the contract surface (`BashExecutionError`, `BashExecutionOutcome`, `BashToolDetails.execution|timing|output`, shape copied 1:1 from the pre-rebaseline `bash.ts:38-84`).
- This duplicate is deliberate and time-boxed: at W01-C reapply the vendored implementation returns and the product module must switch back to importing it (single source of truth). Removal condition: W01-C reapply lands; then delete the local declarations and re-point the import. Until then the copy is the only definition — the vendored tree at the pin has none — so no double-definition source exists today.
- Regression guard while the copy lives: `readBashExecutionOutcome` runtime validation plus the local-runtime/background-bash suites; the vendored side has nothing to drift against until reapply.

### 2026-10-23 — §5.1 per-row patch registry: pin-verified verdicts for the 14 absent families (PORT-PI-1.3, W01 round 4; review finding 1)

Closes the round-1 review gap («per-row вердиктов нет ни по одной строке»). Every family listed in the rebaseline entry above now has a verified verdict against the pin itself (`git -C …/pi show/grep 48c8f322… -- <path>`); the full registry with quotes, per-ledger-entry decisions, recoverable test names (`@624746c`) and removal conditions lives in `hybrid-plans/upstream/port-pi-1.3/state/w01-patch-registry.md` (reviewer of fates: GLM-wave1). Family-level summary:

| Family (ledger entries) | Verdict vs pin `48c8f322` |
|---|---|
| Provider fetch egress (№31) | **replaced-by-upstream** — `ProviderRequestOptions.fetch?: FetchFunction` (ai `src/types.ts:163–167`), consumed by openai-completions:354, anthropic-messages:633, Codex SSE :406 |
| Codex SSE preference when fetch injected (№30) | **take** — pin `auto` still tries WebSocket first (`openai-codex-responses.ts:300–307`) |
| OAuth fetch refresh + initial Codex exchange (№29, №20) | **take (adapt)** — every pin OAuth flow uses global fetch (`auth/oauth/*.ts`, no injection param) |
| Parsed stream-event observer (№19) | **replaced-by-upstream** — `StreamOptions.onProviderStreamEvent` (ai `src/types.ts:214–223`) in all adapters; host wraps its own callback (no duplicate wrapper) |
| `onProviderError` (№18) | **take** — zero hits in the pin |
| Anthropic refusal details (№2) | **take** — pin `mapStopReason` keeps `stopReason:"error"` but drops `stop_details.category` and any refusal marker (`anthropic-messages.ts:1675–1679`) |
| Signature-only thinking blocks (№27) | **replaced-by-upstream** — `transform-messages.ts:133–136` «Keep redacted and signed blocks even if the thinking text is empty» (upstream #6457 itself) |
| Adaptive/default thinking + Fable (№12, №37) | **adapt** — pin has native adaptive thinking (`anthropic-messages.ts:237–275, 940–984, 1283–1297`); mcode `[1m]`-matcher/effort preservation re-expressed on that path (W06) |
| OpenAI-compat system-role hosts (№7–10) | **take** — pin `detectCompat` (`openai-completions.ts:1601–1663`) has no mistral/siliconflow/dashscope/kimi hosts; override precedence already native (`:1710`) |
| Empty-tools omission (№6) | **take** — pin still emits `tools: []` for tool history (`openai-completions.ts:860–867`); issue #194 stands |
| Codex SSE header deadline (№13) | **replaced-by-upstream** — hard 10 s abort removed; opt-in `timeoutMs` (`openai-codex-responses.ts:298, 402–414`) |
| Responses conversion helpers (№34) | **replaced-by-upstream** — exported from `api/openai-responses-shared.ts:191/438` + `"./api/*"` subpath export; consumers change import path only |
| GPT-5.6/Max catalog (№35) | **replaced-by-upstream** — pin-revision catalog has `gpt-5.6-{luna,sol,terra}` with `thinkingLevelMap.max:"max"`; host-side max-thinking intent stays product (W06) |
| Deterministic pi-ai build (№36) | **adapt** — pin `build:offline` (`check:model-data && tsc && cp data`) is the offline path; vendored tree carries no scripts |
| Edit bounded diff/patchOmitted + fuzzy span + fidelity guard (№4, №5, №39, №40) | **take** — pin edit.ts:202 unconditional patch, no bounds markers; edit-diff.ts:318 still normalizes the whole file on fuzzy fallback |
| Bash/Read exact facts + process observation (№3, №14, №43) | **take** — pin `BashToolDetails`/`ReadToolDetails` carry `truncation?`(+`fullOutputPath?`) only; no `onProcessEvent` |
| Windows lifecycle (№11, №28, №41, №42, №45) | №28 **replaced-by-upstream (core)** — System32 taskkill + async-error listener (`shell.ts:223–241`); №41/№42/№11/№45 **take** (no graceful SIGTERM path, no parent-death guardian, no ConstrainedLanguage probe, no PS 5.1 exit-code idiom in the pin) |
| Photon safe-image passthrough / packaging (№21, №23) | №21 **take** (pin `image-process.ts` still degrades missing processor to text-only omission); №23 **adapt** (WASM path resolution upstream via `photon.ts` fallback paths; mcode bundle packaging residual) |
| `CancellableLoader` types (№22) | **replaced-by-upstream** — pin `loader.ts:28–34` declares the typed constructor the subclass inherits |
| BEL OSC 8 (№24) | **take** — pin `terminal-image.ts:739` hyperlink() is still ST-terminated |
| Packaging/deps/test-only (№25, №26, №33, №38) | №26 **replaced-by-upstream** (pin deps `minimatch 10.2.6`, `undici 8.10.2`); №25 **adapt** (product build step, outside vendor tree); №33 **take** (returns with G-PORT coding-agent); №38 **drop** |

Status: nothing reapplied yet; every «replaced-by-upstream» closes only after a target-tree test (G-PORT/G-UNIT, plan §5 item 7), take/adapt rows reapply per-wave (W01-C/W06/product build) with cross-review at execution time.

### 2026-10-28 — configurable text truncation limits for the read tool

- Reason: a MCode `run_code` (PTC) child call hands its result to the program, not to the model context, so the host needs `read` to return a whole file for that caller, or exactly the `offset`/`limit` window it asked for. Pi hard-codes a 2000-line / 50KB head truncation inside `read`, which even an explicit `limit` cannot exceed, so a script paged the same data across many small calls.
- Affected package: `packages/coding-agent` (`@earendil-works/pi-coding-agent`), `src/core/tools/read.ts`. `ReadToolOptions` gained an optional `truncation: TruncationOptions`, passed to `truncateHead`. The two continuation notices and the oversized-first-line message now report the effective limits instead of the constants `DEFAULT_MAX_LINES` / `DEFAULT_MAX_BYTES`. Omitting `truncation` keeps the default limits and the existing wording byte for byte.
- Change type: generic, upstreamable host seam. It only exposes limits that were already parameters of `truncateHead`; no path handling, image handling, or default behaviour changes.
- minimax integration: `packages/agent-tools/src/desktop/local-pi-tools.ts` builds a second, uncapped `read` tool for PTC child calls with `maxLines: Infinity` and `maxBytes: PTC_CHILD_FULL_OUTPUT_MAX_BYTES` (8 MiB). A file above that budget falls back to the direct-call page so a huge file cannot exhaust memory or hit V8's string length limit. Direct calls keep the default limits.
- Upstream PR: not opened.
- Validation: `third_party/pi-mono/packages/coding-agent/test/read-truncation-options.test.ts` (4 cases) covers the raised line and byte limits, the continuation wording, and unchanged defaults. Vendored upstream suites remain outside this distribution's verification gates.

### 2026-10-29 — treat an Anthropic stream without a stop_reason as a truncated answer

- Reason: an Anthropic-compatible endpoint can cut a message short mid-thinking and end with `event: message_delta` carrying an empty `stop_reason`, followed by `event: message_stop`. `streamAnthropic` starts from `stopReason: "stop"` and `message_delta` only overwrites it for a truthy value, so the truncated answer looked like a normal finish: the turn stopped silently, reported no error, and did not retry. An unknown non-empty `stop_reason` already throws in `mapStopReason`, and the 2026-09-10 completeness guard covered a missing `message_start` / `message_stop`; only the empty-or-missing case was left.
- Affected package: `packages/ai` (`@earendil-works/pi-ai`), `iterateAnthropicEvents`. After the existing checks, a stream that saw `message_start` and `message_stop` but never a `message_delta` with a non-empty string `stop_reason` throws `Anthropic stream ended without stop_reason (<diagnostics>)`. A null delta earlier in the stream followed by a real value is not an error. `streamAnthropic`'s existing catch turns it into `stopReason: "error"` plus `errorMessage`, keeping the content received so far. `message_delta` handling, `mapStopReason`, and the wording of the other completeness errors are unchanged.
- Change type: generic, upstreamable protocol-completeness check, in the same spirit as the 2026-09-10 entry. It only looks at whether a `stop_reason` ever appeared, never at body text, tool calls, or usage, and applies to every `anthropic-messages` provider including BYOK. The diagnostics carry structural information only (`messageDeltaCount`, `rawEventCount`, `messageEventCount`, `lastEventAtMs`, `eofAtMs`) and never SSE payload bodies, reasoning, prompts, or credentials.
- minimax integration: `packages/shared/src/llm-error-classifier.ts` gained an `incomplete_stream` signal that matches only the new wording. `toLLMProtocolClassification` and the string fallback `classifyLLMErrorToCode` both map it to 50113 (`LLM_UPSTREAM_ERROR`). Once matched, the numeric heuristics are skipped so that counts or millisecond timings in the diagnostics (429, 1008, 2066, …) are not misread as rate limiting, credits, or a timeout. The `without message_start` and `before message_stop` classifications are unchanged.
- Upstream PR: not opened.
- Validation: `third_party/pi-mono/packages/ai/test/anthropic-missing-stop-reason.test.ts` covers the empty, missing, and null-only stop_reason streams plus the non-regression cases (a real stop_reason, an unknown non-empty one, and the two existing completeness guards). Vendored upstream suites remain outside this distribution's verification gates. A real truncated upstream stream was not reproduced locally.

### 2026-10-26 — keep unsafe integers in tool arguments as their source text

- Reason: a model sometimes emits a long number whose schema type is `string` (an 18-digit ID number, a snowflake ID) as an unquoted JSON number. `parseStreamingJson` used plain `JSON.parse`, which rounds any integer past `Number.MAX_SAFE_INTEGER` to the nearest double; schema coercion then stringified the rounded value, so the tool silently received different digits (`440103198004279575` → `"440103198004279550"`) and the wrong number was stored in session history. Upstream issue `earendil-works/pi#8943` reports the same problem and was auto-closed as `no-action` without maintainer comment; upstream `main` (2026-10-25 `d5b3de22d`) still has the original implementation.
- Affected package: `packages/ai` (`@earendil-works/pi-ai`), `utils/json-parse.ts`. `parseStreamingJson` now passes a reviver when parsing complete JSON and uses `JSON.parse` source text access (Node 21+) to keep an integer literal that is not a safe integer as its original string. `parseJsonWithRepair` gained an optional reviver parameter; other callers (such as the outer SSE envelope parse) do not pass one, so their behavior is unchanged.
- Behavior: a `string` parameter receives the exact digits; `integer` / `number` parameters coerce to the same double as before; an untyped or `string | number` field changes from a (rounded) number to the source string. Decimals, exponent notation and safe integers are unchanged. Incomplete or unrepairable JSON still falls back to partial-json, and the Google provider parses arguments through its SDK; both paths are outside this patch.
- Upstream PR: not opened.
- Validation: `packages/ai/test/tool-argument-unsafe-integer.test.ts` streams a tool call whose 18-digit ID arrives unquoted and split across deltas and asserts the exact digits for a string parameter, an unchanged double for numeric parameters, and that only integer literals a double cannot hold exactly are rewritten. All three cases fail on the unpatched baseline. Vendored upstream suites remain outside this distribution's verification gates.

### 2026-10-06 — opt-in fallback for unexpected provider tool calls

- Reason: a conversational host can intentionally advertise no tools, but a provider may still emit a structured tool call. The normal missing-tool result starts another model hop and can leave the host without a final assistant response.
- Affected package: `packages/agent` (`@earendil-works/pi-agent-core`), agent options, loop config, and successful assistant-response finalization.
- Change type: generic, upstreamable opt-in host seam. When `unexpectedToolCallFallback` is present, a successful response that contains tool calls removes those calls, preserves prior text, and appends the fallback exactly once before ending normally. Provider responses with `stopReason: "error"` or `"aborted"` remain untouched so retry and error reporting preserve the real failure. Omitting the option retains upstream behavior.
- Upstream PR: not opened.
- Validation: focused `packages/agent/test/agent-loop.test.ts` regressions cover text-plus-tool guidance, deduplication, and unchanged error/aborted responses; the distribution BYOK mock-provider test proves no unoffered tool executes and no second model request occurs. `pnpm test:release-tools` and `pnpm check:source` validate the vendored patch record and public inventory.

### 2026-10-01 — keep Anthropic classifier refusal details

- Reason: Claude safety-classifier refusals arrive as HTTP 200 with `stop_reason: "refusal"` (see [Refusals and fallback](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback)). They were mapped to `error` and surfaced as `An unknown error occurred`, which dropped `stop_details.category` / `explanation`, hid the refusal from downstream classification, and let BYOK retry it as an unknown failure.
- Affected package: `packages/ai` (`@earendil-works/pi-ai`), Anthropic-compatible stream.
- Change type: generic, upstreamable. `stopReason` stays `error`; `errorMessage` becomes `Model declined the request (stop_reason: refusal[; category: …])[: explanation]` for refusals both before and during output, omitting a null `category` / `explanation`. Hosts detect `stop_reason: refusal` and do not parse the explanation.
- Upstream PR: not opened.
- Validation: host-side non-retry and refusal classification are covered by the `@mavis/shared` classifier and `@mavis/agent-core` retry tests. Vendored upstream suites remain outside this distribution's verification; no live Claude service was called.

### 2026-09-23 — preserve Bash execution facts and bounded output

- Affected package: `packages/coding-agent` (`@earendil-works/pi-coding-agent`), Bash execution, child-process observation, and output accumulation.
- Change: require exit code zero for success; preserve signals, cancellation reasons, timeout deadlines, and partial output in structured success and failure results. Add an optional original head-and-tail preview and host-owned persistence so managed commands use one complete log. Report persistence failures separately from the process outcome.
- The existing exit-code-only helper and default tail preview remain compatible. Process cleanup and command timers retain their existing lifecycle.
- Provenance: shared MiniMax Bash implementation, adapted to the standalone source distribution. Existing upstream notices and licenses apply; no new dependency is introduced. Upstream PR: not opened.
- Regression coverage: the existing child Bash lifecycle, turn executor, and built-in catalog tests cover command deadlines, native output capability gating, and rendered prompt guidance. Vendored upstream suites remain outside this distribution's verification; real-model and Windows acceptance are separate.

### 2026-09-21 — report why the edit unified patch was omitted

- Reason: the unified patch is a second, independently timed Myers run over the same input as the display diff. When only that run ran out of time, `details` held a diff, no patch, and no `diffOmitted` — consumers could not tell an omitted patch apart from a tool that never produces one.
- Affected package: `packages/coding-agent` (`@earendil-works/pi-coding-agent`), edit tool details assembly.
- Change type: generic, upstreamable correctness fix. Add `details.patchOmitted`, set to `diffOmitted` when the display diff was abandoned and to `timeout` when only the patch was, so `details.patch` is absent exactly when `patchOmitted` is set. jsdiff routes `createTwoFilesPatch` through the same bounded `diffLines`, so `maxEditLength` is deterministic across both runs and can never trip for the patch alone; only its separately measured wall clock can. `diffOmitted` keeps its meaning and is unchanged.
- Upstream PR: not opened.
- Validation: `packages/agent-tools/src/desktop/edit-diff-bounds.test.ts` pins the invariant on both reachable paths (an ordinary edit and a bounded-out whole-file rewrite). The patch-only timeout is not unit-testable: it needs the two runs to land on opposite sides of a 5 s wall clock, which no deterministic input can force.

### 2026-09-21 — bound the post-edit diff of the edit tool

- Reason: `edit` computed its display diff and its unified patch with unbounded Myers, which costs O((N+M)·D) in the length D of the edit script. A whole-file rewrite therefore scaled quadratically in the number of changed lines: rewriting every line of a 20 000-line file blocked the tool for over two minutes and produced a multi-megabyte patch that no renderer displays. The sibling `write` path already caps the same work (`packages/agent-tools/src/shared/write-capture.ts`); `edit` had no cap.
- Affected package: `packages/coding-agent` (`@earendil-works/pi-coding-agent`), edit tool diff generation.
- Change type: generic, upstreamable performance fix. Pass jsdiff's `maxEditLength` (2000 edits) and `timeout` (5 s) to `diffLines` and `createTwoFilesPatch`. `maxEditLength` is the primary bound because it is deterministic and therefore testable; `timeout` only backstops slow machines. Replacing a line costs 2 edits, so the bound admits a full rewrite of any file up to 1000 lines and only gives up past that. When a bound trips, `details.diff` carries a one-line notice so every renderer still has something to show, `details.patch` is omitted, and the new `details.diffOmitted` names the reason. The unified patch is skipped once the display diff was abandoned rather than repeating a second Myers run that aborts on the same bound. The file is written before any diff runs, so a dropped diff never changes what lands on disk.
- Upstream PR: not opened.
- Validation: `packages/agent-tools/src/desktop/edit-diff-bounds.test.ts` (registered in the `capability` suite) covers an ordinary edit, a large block replacement that stays under the bound, a full rewrite at the bound that keeps its diff, and a whole-file rewrite that keeps the write while dropping the diff; `pnpm verify --profile platform` on macOS. Measured end to end through `createEditTool`, three runs each on the same machine: a 20 000-line whole-file rewrite took 167 620 / 173 523 / 167 547 ms unbounded and 200 / 192 / 193 ms bounded, with peak heap dropping from 47–60 MB to 14–15 MB; a 501-line rewrite takes 53 / 49 / 47 ms and a 1000-line rewrite 177 / 173 / 177 ms, both keeping their diff.

### 2026-09-19 — omit empty tools for OpenAI-compatible checkpoint requests

- Reason: checkpoint requests retain tool-call history but omit tool definitions. The OpenAI Completions provider unconditionally added `tools: []` for that history, which can cause a backend to reject compaction with HTTP 400 (public issue MiniMax-AI/minimax-code#194).
- Affected package: `packages/ai` (`@earendil-works/pi-ai`), `src/providers/openai-completions.ts` and its existing empty-tools regression fixture.
- Change type: generic, upstreamable compatibility fix. Omit `tools` when no nonempty tool definitions are supplied, regardless of tool-call history or cache compatibility. Nonempty tool definitions are unchanged. Remove the obsolete history-based empty-array workaround; no compatibility settings or recovery requests are added.
- Validation: the distribution-owned `packages/local-runtime-v2/test/integration/compaction-openai-transport.integration.test.ts` exercises `compactContext` through checkpoint generation and the real SDK against a local HTTP fixture that rejects empty tools. Regressions cover absent/empty definitions, tool history, Anthropic cache compatibility, ordinary requests, and preserved nonempty definitions. Run with `pnpm exec vitest run --config vitest.oss.config.mjs packages/local-runtime-v2/test/integration/compaction-openai-transport.integration.test.ts` and the full `pnpm verify` profile. Offline fixtures do not establish live LiteLLM/vLLM, OpenAI, or Anthropic proxy acceptance.
- Upstream PR: not created.

### 2026-09-19 — preserve the system role for Mistral Chat Completions

- Reason: thinking-enabled custom OpenAI-compatible connections to `api.mistral.ai` emitted `developer`, which is absent from the [Mistral Chat Completions message contract](https://docs.mistral.ai/api/endpoint/chat). [OpenClaw's compatibility defaults](https://github.com/openclaw/openclaw/blob/e2bcb1614de060927121bd72de850cee3a08d308/packages/ai/src/transports/openai-completions-compat.ts#L184-L210) also disable this role for the Mistral public endpoint.
- Affected package: `packages/ai` (`@earendil-works/pi-ai`), OpenAI Completions compatibility detection.
- Change: default to `system` only on the exact Mistral API host. Preserve thinking, explicit compatibility overrides, all other request options, and other endpoints. Native Mistral transport is unchanged.
- Upstream PR: not opened.
- Validation: outgoing-payload regressions in `packages/local-runtime-v2/src/service/model-system/resolution/local-model-resolver.test.ts`; the endpoint regression fails before the fix. No live Mistral requests or full CLI acceptance were performed; the decision is based on the official contract and current upstream implementation.

### 2026-09-19 — preserve the system role for SiliconFlow

- Reason: thinking-enabled OpenAI-compatible requests sent the `developer` role, which is absent from SiliconFlow's documented message schema.
- Affected package: `packages/ai` (`@earendil-works/pi-ai`), OpenAI Completions compatibility detection.
- Change: default to the `system` role on the exact `api.siliconflow.cn` and `api.siliconflow.com` hosts. Preserve thinking, explicit compatibility overrides, other request options, and other endpoints.
- References: [official Chat Completions schema](https://docs.siliconflow.com/en/api-reference/chat-completions/chat-completions) and [pi's SiliconFlow provider proposal](https://github.com/earendil-works/pi/pull/8113) (closed without merging).
- Upstream PR: not opened.
- Validation: outgoing-payload regressions in `packages/local-runtime-v2/src/service/model-system/resolution/local-model-resolver.test.ts`, including both official hosts, unrelated hosts, and explicit compatibility overrides.

### 2026-09-19 — preserve the system role for DashScope

- Reason: DashScope endpoints were treated as supporting the `developer` role, causing thinking-enabled OpenAI-compatible conversations to send an unsupported system-prompt role.
- Affected package: `packages/ai` (`@earendil-works/pi-ai`), OpenAI Completions compatibility detection.
- Change: default to the `system` role for official DashScope regional and Coding Plan hosts, plus workspace, trial, and Token Plan hosts under the documented regional `maas.aliyuncs.com` domains. Preserve thinking, other request options, explicit compatibility overrides, and other providers.
- References: [official endpoint list](https://help.aliyun.com/en/model-studio/base-url), [Coding Plan role rejection](https://github.com/openclaw/openclaw/issues/23575), [Token Plan role rejection](https://github.com/earendil-works/pi/issues/7723), and [merged OpenClaw DashScope fix](https://github.com/openclaw/openclaw/pull/24675).
- Upstream PR: not opened.
- Validation: request-payload regressions in `packages/local-runtime-v2/src/service/model-system/resolution/local-model-resolver.test.ts`, including official endpoints, unrelated hosts, and explicit compatibility overrides.

### 2026-09-19 — preserve the system role for Kimi Coding

- Reason: Kimi Coding endpoints were treated as supporting the `developer` role, causing thinking-enabled OpenAI-compatible conversations to send an unsupported system-prompt role.
- Affected package: `packages/ai` (`@earendil-works/pi-ai`), OpenAI Completions compatibility detection.
- Change: default to the `system` role for `api.kimi.com` and `api.kimi.ai`. Preserve thinking, other request options, explicit compatibility overrides, and other providers.
- Upstream PR: not opened.
- Validation: offline request-payload regressions in `packages/local-runtime-v2/src/service/model-system/resolution/local-model-resolver.test.ts`. Live Kimi Coding validation requires a Coding Plan key and remains untested.

### 2026-08-31 — Windows PowerShell ConstrainedLanguage compatibility

- Reason: the Windows PowerShell 5.1 stdin wrapper called `Parser.ParseInput`, `ScriptBlock.Create`, and other restricted .NET APIs before user commands. Under enterprise App Control / AppLocker `ConstrainedLanguage`, the wrapper therefore failed before commands such as Python could run.
- Affected package: local Bash / PowerShell execution backend and focused regressions in `packages/coding-agent` (`@earendil-works/pi-coding-agent`).
- Change type: generic, upstreamable PowerShell compatibility fix. Probe and cache `LanguageMode` on first execution per PowerShell executable. `FullLanguage` retains UTF-8, `#requires`, and the full script-block path. `ConstrainedLanguage` transfers the original command through a one-use Unicode environment variable, removes it from the child environment, then uses `Invoke-Expression` within the same restricted language mode, without restricted .NET APIs.
- Upstream PR: not created.
- Validation in the source monorepo: `cd third_party/pi-mono/packages/coding-agent && node ../../../../node_modules/vitest/dist/cli.js --run test/graceful-terminate.test.ts` covers preserved `FullLanguage` behavior and restricted-API avoidance, long commands, and Chinese command transport in `ConstrainedLanguage`; `pnpm --filter @earendil-works/pi-coding-agent... build` validates the affected vendor build; `node scripts/test/focused-vitest.mjs --package @mavis/local-runtime packages/local-runtime/test/unit/local-background-bash-runner.test.ts packages/local-runtime/test/unit/local-background-bash-executor.test.ts` checks runtime consumers. Real Windows App Control / AppLocker acceptance remains external.

### 2026-08-27 — omit explicit thinking for Claude default-thinking models

- Reason: Claude Opus 5, Sonnet 5, Fable 5, Mythos 5, and Mythos Preview enable thinking by default. Custom Anthropic-compatible models must preserve `output_config.effort` without falling back to legacy `thinking.type=enabled` plus `budget_tokens`.
- Affected package: `packages/ai` (`@earendil-works/pi-ai`).
- Change type: Anthropic request adaptation plus one exported model-family matcher shared by both local runtimes. The matcher ignores only an exact trailing `[1m]` for thinking classification; BYOK context configuration and the wire model ID remain untouched.
- Host boundary: the Anthropic adapter classifies the final model ID itself and suppresses only the active-thinking field. Explicit disabled-thinking behavior remains controlled by the caller and the upstream model's supported configuration.
- Upstream PR: not opened.
- Validation: focused Anthropic provider tests and package build, plus local-runtime v1/v2 resolver, connection, payload, and subagent regression suites.

### 2026-08-26 — allow slower Codex SSE response headers

- Reason: Desktop injects a host fetch implementation for Codex, which selects the SSE transport. The provider aborted requests when response headers took more than 10 seconds, interrupting otherwise healthy long-running tasks during transient upstream latency.
- Affected package: `packages/ai` (`@earendil-works/pi-ai`), Codex Responses SSE transport and focused regression coverage.
- Change type: generic upstreamable transport fix. Increase the response-header deadline to 30 seconds while preserving caller cancellation and the existing body-read timeout behavior.
- Upstream PR: not opened.
- Validation: focused `packages/ai/test/openai-codex-stream.test.ts` (28 passed); downstream shared (178 passed), Agent Core (151 passed), and Cloud Runtime (10 passed) error-classification tests; targeted Biome, pinned-dependency, TypeScript-import, and browser-smoke checks passed. Full vendored `npm run check` remains blocked by the ignored canonical `package-lock.json` input and existing unrelated test type errors; `pnpm check:pi-vendor-resolution` remains blocked by the existing Local Runtime V2 Pi dependency allow-list drift.

### 2026-08-22 — retain exact built-in Bash and Read execution facts

- Reason: post-execution integrations cannot safely reconstruct separate stdout/stderr or an explicit-limit file page from Pi's decorated, model-facing text. Preserve those facts while the built-in tools still own them so downstream consumers can adapt protocols without parsing truncation and continuation notices.
- Affected package: `packages/coding-agent` (`@earendil-works/pi-coding-agent`), built-in Bash and Read result details.
- Change type: generic upstreamable result metadata. Local Bash backends may declare exact split-stream callbacks; Read records its resolved path, undecorated returned page, line range, total lines, and automatic output-cap signal.
- Upstream PR: not opened.
- Validation: focused `packages/coding-agent/test/tools.test.ts`; downstream `@mavis/agent-tools` Desktop Bash/Read and Local Runtime v2 vendor PostToolUse tests.

### 2026-08-22 — agent: graceful stop after steering admission

- Reason: a queued `UserPromptSubmit` Plugin Hook can return `continue: false` after the ordinary `turn_end` stop check. Added a dedicated post-steering admission seam so the active run emits `agent_end` without issuing another provider request or reporting a failed turn.
- Affected package: `packages/agent` (`@earendil-works/pi-agent-core`).
- Change type: MiniMax-specific host glue.
- Upstream PR: not opened.
- Validation: focused agent-loop and local/cloud Plugin Hook tests listed in MR validation.

### 2026-08-22 — expose explicit whole-agent termination from tool hooks

- Reason: host lifecycle hooks need a protocol-level stop to end the active agent after a before/after-tool decision. The existing tool-result `terminate` hint intentionally stops only when every result in a batch opts in, so it cannot represent a global Hook decision in a mixed parallel batch.
- Affected package: `packages/agent` (`@earendil-works/pi-agent-core`), tool-hook result contracts and agent-loop batch termination.
- Change type: generic upstreamable control seam. Add optional `terminateAgent` to before/after-tool results. Sequential execution stops immediately after publishing the current call result; parallel preflight stops admitting later calls. Calls that never execute receive synthetic error ToolResults so provider history remains fully paired. An already-started parallel batch stops after publishing that batch. The existing every-result `terminate` behavior remains unchanged.
- Upstream PR: not opened.
- Validation: focused `packages/agent/test/agent-loop.test.ts`; downstream `@mavis/agent-core` and Local Runtime v2 Hook tests.

### 2026-08-22 — expose the admitted tool execution boundary

- Reason: Claude-compatible `PostToolUse.duration_ms` measures tool execution only and excludes PreToolUse and permission latency. The existing `tool_execution_start` event intentionally fires before admission, so it cannot provide that timestamp.
- Affected package: `packages/agent` (`@earendil-works/pi-agent-core`), loop config and Agent forwarding.
- Change type: generic upstreamable lifecycle seam. Add a synchronous `onToolExecutionStart` observation after argument validation and all before-tool admission succeeds, immediately before `tool.execute`; blocked calls never fire it.
- Upstream PR: not opened.
- Validation: focused `packages/agent/test/agent-loop.test.ts`; downstream Cloud root/child Plugin Hook timing tests.

### 2026-08-18 — expose parsed provider stream events to host observability

- Reason: the development-only LLM Context Inspector needs the final provider-native response shape without cloning/teeing HTTP response bodies or persisting Pi's semantic `AssistantMessage` projection.
- Affected package: `packages/ai` (`@earendil-works/pi-ai`), the shared stream option plus Anthropic Messages, OpenAI Chat Completions, OpenAI Responses, and Codex Responses parsed-event loops.
- Change type: generic upstreamable observability seam. The optional callback is synchronous and exception-isolated; when absent, providers iterate their original stream directly with no added per-event work.
- Upstream PR: not opened.
- Validation: `pnpm --filter @earendil-works/pi-ai build`; focused provider-observer and Local Runtime Inspector tests.

### 2026-08-18 — route initial Codex OAuth exchange through host fetch

- Reason: the existing OAuth fetch injection covered model requests and token refresh, while the browser-login authorization-code exchange still used Node's global fetch. Electron hosts with Chromium proxy, PAC, or enterprise certificate handling could therefore show a successful browser callback and fail before credentials were persisted.
- Affected packages: `packages/ai` (`@earendil-works/pi-ai`), `packages/coding-agent` (`@earendil-works/pi-coding-agent`), `packages/local-runtime` (legacy Codex OAuth owner removed), and `packages/local-runtime-v2` (sole Runtime OAuth owner).
- Change type: generic upstreamable OAuth transport behavior plus Runtime ownership cleanup. Thread the host fetch implementation through login callbacks and use it for Codex browser and device-code login requests; keep the global fetch as the fallback for standalone callers. Remove the legacy V1 Codex OAuth manager and route so Runtime V2 is the only login owner.
- Upstream PR: not opened.
- Validation: `pnpm --filter @earendil-works/pi-ai exec vitest --run test/openai-codex-oauth.test.ts` (10 passed); `pnpm --filter @earendil-works/pi-coding-agent exec vitest --run test/auth-storage-fetch.test.ts` (1 passed); local-runtime-v2 Codex OAuth focused test (17 passed); local-runtime-v2 typecheck; Pi AI, TUI, Agent, and Coding Agent builds.

### 2026-08-15 — return already-safe images when Photon is unavailable

- Reason: Pi had already read the original image bytes before attempting Photon, but a missing image processor always produced a text-only omission. The Local Runtime workaround had to parse that user-visible English text and reread the file, which could misclassify ordinary text and duplicated Pi's image limits.
- Affected package: `packages/coding-agent` (`@earendil-works/pi-coding-agent`), specifically the image resize boundary and its PNG, JPEG, GIF, and WebP header checks.
- Change type: generic upstreamable image-processing behavior. When Photon cannot load, return the original image only if header dimensions and encoded size already satisfy the caller's limits; continue throwing `ImageProcessorUnavailableError` when resizing, recompression, or full decoding is required. This benefits the read tool and CLI image attachment path without host-specific result parsing.
- Upstream PR: not opened.
- Validation: Pi missing-processor regression 8/8; complete coding-agent Vitest 140 files / 1,434 tests with the standalone copy-assets tests 2/2; coding-agent build; downstream agent-tools 70 files / 881 tests plus typecheck/build; Local Runtime read E2E; and a self-contained darwin-arm64 MCode pack smoke that removes both packaged Photon WASM copies before verifying safe-image passthrough and oversized-image rejection.

### 2026-08-14 — declare CancellableLoader constructor callback types at the source

- Reason: the vendored `CancellableLoader` omitted an explicit constructor declaration, so the emitted declaration exposed untyped callback parameters to strict workspace typechecking. `BorderedLoader` passed the two theme callbacks contextually and was rejected for implicit `any` parameters.
- Affected package: `packages/tui` (`@earendil-works/pi-tui`), `CancellableLoader` component.
- Change type: generic upstreamable type-safety fix. Declare `CancellableLoader` constructor parameters explicitly (`TUI`, `(str: string) => string` color callbacks, optional message and indicator options) and forward them to the `Loader` superclass; runtime behavior is unchanged. The caller-side `string` annotations are not needed, keeping the vendored `packages/coding-agent` source at its imported baseline.
- Upstream PR: not opened.
- Validation: `pnpm --filter @earendil-works/pi-tui build`; `pnpm --filter @earendil-works/pi-coding-agent build`; downstream `@mavis/cli` typecheck.

### 2026-08-12 — keep local image reads available in bundled MCode

- Reason: the source workspace could decode and resize local images, but the registry TUI bundle omitted Photon WASM and executed bundled CommonJS compatibility code without `__dirname`. As a result, `@image` could reach the read tool while returning text-only metadata instead of an image block; the loader also collapsed a missing processor into the same result as an image that exceeded the inline size limit.
- Affected package: `packages/coding-agent` (`@earendil-works/pi-coding-agent`), specifically the Photon loader, image-resize boundary, read tool, CLI file processor, and focused caller regressions.
- Change type: generic upstreamable image-processing behavior. Resolve Photon relative to the executing module and expose a typed processor-unavailable failure while preserving the existing null result for genuine resize-limit failures. MiniMax host packaging separately copies the WASM asset and provides the compatibility globals required by the ESM bundle; desktop/TUI adapters separately promote selected `@image` files to structured attachments and label terminal reads as `Read Image`.
- Upstream PR: not opened.
- Validation: coding-agent focused Vitest 4/4 and build; downstream UI focused Vitest 115 passed / 1 skipped and typecheck; downstream TUI focused Vitest 116/116 and typecheck; npm bundle profile tests 16/16; `pnpm release:mcode:test:dry-run`, including isolated tarball install, real read-tool image delivery, missing-processor classification, and uninstall smoke. `pnpm check:pi-vendor-resolution` remains blocked by the unchanged `packages/local-runtime-v2` Pi dependency allow-list drift already present on `origin/preview_train`.

### 2026-08-10 — use BEL-terminated OSC 8 hyperlinks for macOS hit testing

- Reason: macOS Terminal could display a long OSC 8 hyperlink while restricting full `Command-click` hit testing to only part of the wrapped link when the sequence used ST (`ESC \\`) terminators. BEL termination is recognized consistently, and the existing wrapping logic closes/reopens the active hyperlink on every physical line.
- Affected package: `packages/tui` (`@earendil-works/pi-tui`), `hyperlink()` output in `src/terminal-image.ts` plus regression coverage in `test/terminal-image.test.ts` and `test/wrap-ansi.test.ts`.
- Change type: generic upstreamable TUI behavior fix. No MiniMax-specific runtime dependency or adapter workaround is introduced.
- Upstream PR: not opened.
- Validation: `node --test --import tsx third_party/pi-mono/packages/tui/test/terminal-image.test.ts third_party/pi-mono/packages/tui/test/wrap-ansi.test.ts`; `pnpm --filter @earendil-works/pi-tui build`; local `@minimax/code` focused Markdown/foundation tests and build.

MiniMax integration files added in this spike:

- `.minimax-vendor.json` records the upstream source and local ownership metadata.
- `MINIMAX_CHANGES.md` tracks MiniMax-only changes and upstreaming status.
- `../AGENTS.md` defines the MiniMax vendored-code workflow for hotfixes, validation, and upstream sync.

### 2026-08-11 — copy coding-agent runtime assets without nested shell binaries

- Reason: Windows Electron builds run the coding-agent build through pnpm, then enter `npm run copy-assets`. The nested npm script can lose pnpm's package-local `.bin` path, so `shx` is not found even though the preceding `shx chmod` succeeds.
- Affected package: `packages/coding-agent` (`@earendil-works/pi-coding-agent`), build-time asset copying only.
- Change type: generic upstream material. Replace the `shx` glob/copy pipeline with a Node.js script that preserves the same JSON, PNG, HTML, CSS, and JavaScript asset set on every platform.
- Upstream PR: not opened.
- Validation: `node --test scripts/copy-assets.test.mjs`; `pnpm --filter @earendil-works/pi-coding-agent build`; downstream Electron build remains covered by the Windows Jenkins job.

### 2026-08-08 — Raw provider error observation for hosts

- Reason: providers converted original SDK exceptions to `errorMessage` inside `catch`, leaving hosts with generic text such as `Connection error.` and no access to `cause`, DNS codes, HTTP status, or SDK-specific fields.
- Affected package: generic `StreamOptions`, built-in text providers, and the faux provider in `packages/ai` (`@earendil-works/pi-ai`).
- Change type: generic, upstreamable capability. Add synchronous `onProviderError(error, model)` before error formatting. Providers isolate callback exceptions so they cannot replace the original result. Serialization, encryption, and network reporting remain host-owned; third-party code does not depend on the MiniMax runtime.
- Upstream PR: not created.
- Validation: `pnpm --filter @earendil-works/pi-ai exec vitest --run test/openai-completions-retry.test.ts --reporter=dot`; `pnpm --filter @earendil-works/pi-ai build`; focused tests and builds for downstream agent-core and local-runtime.

### 2026-08-04 — update packaged CLI network and glob dependencies

- Reason: the MCode production tarball included `undici 8.3.0` advisories affecting TLS proxying, WebSocket fragmentation, cache parsing, response synchronization, header/cookie handling, and process stability. Its `minimatch 10.2.5` closure also resolved a vulnerable `brace-expansion` release with an unbounded-expansion OOM path.
- Affected package: `packages/coding-agent` (`@earendil-works/pi-coding-agent`), dependency metadata only.
- Change type: generic dependency maintenance. Pin `undici 8.10.0` and `minimatch 10.2.6`; no MiniMax product logic is added to the vendored source.
- Upstream PR: not opened.
- Validation: `pnpm --filter @earendil-works/pi-coding-agent build`; published `npm-shrinkwrap.json` audit 0 vulnerabilities; MCode Unit + coverage 113 files / 1125 tests; compiled CLI 26/26; embedded Runtime 4/4; PTY 16/16; release contracts 73/73; Agent Tools 686/686; MCP module 14/14; fresh MCode tarball `npm audit --omit=dev` 0 vulnerabilities and offline install smoke PASS.

### 2026-07-31 — preserve signature-only Anthropic thinking blocks

- Reason: Anthropic can return a valid thinking signature with an empty thinking string. The v0.79.1 serializer skipped every empty thinking block before checking its signature, so replay dropped the signed block and could make a later Anthropic request fail signature validation or lose the model's protected reasoning continuity.
- Affected package: `packages/ai` (`@earendil-works/pi-ai`), Anthropic Messages history serialization only.
- Change type: selective generic upstream material from `6731a0ba9e499d71916dd69200c05dfcbc0fa3e6` / [upstream PR #6457](https://github.com/earendil-works/pi-mono/pull/6457). Adapt the predicate to the vendored v0.79.1 `src/providers/anthropic.ts` path without migrating later Pi package structure, versions, lockfile, or `.minimax-vendor.json` baseline.
- Upstream PR: already merged as #6457; no additional upstream PR needed.
- Validation: `pnpm --filter @earendil-works/pi-ai test` (349 passed, 727 skipped); `pnpm --filter @mavis/agent-core exec vitest run --config vitest.config.ts test/unit/pi-ai-thinking-tiered.test.ts --reporter verbose` (18 passed); `pnpm --filter @earendil-works/pi-ai build`; `pnpm check:pi-vendor-resolution`.

### 2026-07-29 — harden Windows taskkill resolution and spawn failures

- Reason: A foreground Bash timeout in the Windows Electron UtilityRuntime called `spawn("taskkill", ...)`. When the utility process could not resolve the bare command, Node emitted an asynchronous `error` event that was not handled by the surrounding synchronous `try/catch`, crashing and reforking the runtime and leaving the active turn `interrupted`.
- Affected package: `packages/coding-agent` (`@earendil-works/pi-coding-agent`), `src/utils/shell.ts` process-tree termination paths.
- Change type: generic upstream material. Resolve `taskkill.exe` from `SystemRoot` / `windir`, attach an `error` listener to every graceful, forced, and emergency taskkill spawn, and fall back to killing the root shell so the Bash timeout/abort can settle even if the native tree killer is unavailable.
- Upstream PR: not opened.
- Validation: `node ../../../../node_modules/vitest/vitest.mjs --run test/windows-taskkill.test.ts test/graceful-terminate.test.ts test/bash-close-hang-windows.test.ts`; `pnpm --filter @earendil-works/pi-coding-agent build`; downstream `pnpm --filter @mavis/agent-tools exec vitest run test/desktop/local-bash-timeout.test.ts`.

### 2026-07-28 — allow hosts to inject fetch for OAuth token refresh

- Reason: MiniMax Electron can rely on Chromium `net.fetch` for enterprise CA, PAC, packet-capture proxy, and system proxy behavior, but expired OAuth credentials were refreshed from pi-coding-agent through provider defaults that could fall back to Node/global fetch. This left Codex/Anthropic/GitHub Copilot refresh requests vulnerable to the same runtime proxy failure after the user had already logged in successfully.
- Affected packages: `packages/ai` (`@earendil-works/pi-ai`) and `packages/coding-agent` (`@earendil-works/pi-coding-agent`).
- Change type: generic upstream material. Add optional `OAuthRequestOptions.fetch`, pass it through `refreshOAuthToken` / `getOAuthApiKey`, and thread it through `AuthStorage.getApiKey` into OpenAI Codex, Anthropic, and GitHub Copilot refresh providers.
- Upstream PR: not opened.
- Validation: `pnpm --filter @earendil-works/pi-ai exec vitest --run test/openai-codex-oauth.test.ts test/openai-codex-stream.test.ts`; `pnpm --filter @earendil-works/pi-coding-agent exec vitest --run test/auth-storage-fetch.test.ts`; `pnpm --filter @earendil-works/pi-ai build`; `pnpm --filter @earendil-works/pi-coding-agent build`.

### 2026-07-26 — prefer Codex SSE when host fetch is injected

- Reason: the 2026-07-22 fetch-injection patch covered the Codex SSE request, but the provider's default `auto` transport still tried WebSocket first. WebSocket construction cannot use the host's injected `fetch`, so enterprise proxy / CA handling was bypassed in the default Codex path.
- Affected package: `packages/ai` (`@earendil-works/pi-ai`).
- Change type: generic upstream material. When `OpenAICodexResponsesOptions.fetch` is provided and transport is left at `auto`, route Codex through SSE so the host-owned fetch implementation handles egress. Explicit `transport: "websocket"` / `"websocket-cached"` remains unchanged for callers that intentionally choose WebSocket.
- Upstream PR: not opened.
- Validation: `pnpm --filter @earendil-works/pi-ai exec vitest --run test/openai-codex-stream.test.ts`; `pnpm --filter @earendil-works/pi-ai build`; downstream `pnpm --filter @mavis/local-runtime exec vitest run --config vitest.config.ts test/e2e/provider-headers.e2e.test.ts`.

### 2026-07-22 — allow hosts to inject fetch for model provider egress

- Reason: MiniMax Electron hosts can resolve enterprise/system proxy behavior in the utility process, but several model provider requests were still created with SDK/global default transports. In company LANs where Chromium can use a proxy but Node/undici direct connections cannot reach `agent.minimaxi.com` or BYOK-compatible endpoints, local turns fail before an upstream trace/request id is issued.
- Affected package: `packages/ai` (`@earendil-works/pi-ai`).
- Change type: generic upstream material. Add optional `fetch` to stream/image options, copy it through simple provider options, pass it to internally constructed Anthropic/OpenAI SDK clients, and use it for the OpenAI Codex Responses SSE fallback request.
- Upstream PR: not opened.
- Validation: `corepack pnpm --filter @earendil-works/pi-ai exec vitest --run test/fireworks-models.test.ts test/openai-completions-retry.test.ts test/openai-codex-stream.test.ts test/openrouter-images.test.ts`; `corepack pnpm --filter @earendil-works/pi-ai build`.

### 2026-07-15 — expose the existing turn-boundary stop hook on `Agent`

- Reason: `AgentLoopConfig.shouldStopAfterTurn` already stops before polling steering and follow-up queues, but the stateful `Agent` wrapper did not expose or forward it. Hosts therefore could not terminate a rejected response at the same step boundary and a queued message could start another provider call first.
- Affected package: `packages/agent` (`@earendil-works/pi-agent-core`).
- Change type: generic upstream material. Add `shouldStopAfterTurn` to `AgentOptions` and the mutable wrapper callback surface, then forward it into the existing low-level loop config.
- Upstream PR: not opened.
- Validation: `pnpm --filter @earendil-works/pi-agent-core test -- agent.test.ts -t 'should stop after a turn'`; `pnpm --filter @earendil-works/pi-agent-core build`; downstream `pnpm --filter @mavis/agent-core test -- pi-turn-runner.test.ts -t 'stops before consuming'`.

### 2026-07-31 — make coding-agent tests robust to composition and scheduler changes

- Reason: the compact resource assertion required an unwrapped absolute path, so it failed in the mandatory long feature-worktree path even though the TUI rendered the complete path across lines. The spawn-error mock also used a one-shot shell response that the newer constructor-time description probe consumed before execution. The different-file mutation queue test used a fixed 30 ms overlap window, so unrelated root-suite I/O scheduling could end the first callback before the second `realpath` completed even though the keys were independent. The reftable watcher tests waited for the transient state `execFile.mock.calls.length === 1`, which could be skipped under root-suite load and turn a real duplicate into a timeout instead of reaching the exact-count assertion.
- Affected package: `packages/coding-agent` (`@earendil-works/pi-coding-agent`), tests only.
- Change type: generic upstreamable test robustness. Normalize whitespace only for the compact-label assertion, keep the mocked invalid shell active through both shell probes, prove different-file concurrency with an explicit two-callback barrier instead of a timing window, and wait for at least one reftable refresh before retaining the existing exact-one debounce assertion.
- Upstream PR: not opened.
- Validation: `node ../../node_modules/vitest/dist/cli.js --run test/tool-execution-component.test.ts test/tools.test.ts test/file-mutation-queue.test.ts test/footer-data-provider.test.ts`; five consecutive isolated `footer-data-provider.test.ts` runs; complete `@earendil-works/pi-coding-agent` package test.

### 2026-07-08 — export OpenAI Responses conversion helpers

- Reason: MiniMax local-runtime needs to build Responses `/input_tokens` count bodies from the same Pi message/tool conversion helpers used by the OpenAI Responses generator, without importing unexported source paths from outside the package boundary.
- Affected package: `packages/ai` (`@earendil-works/pi-ai`).
- Change type: generic upstream material. Re-export `convertResponsesMessages` / `convertResponsesTools` and their option types from the package root.
- Upstream PR: not opened.
- Validation: `pnpm --filter @mavis/local-runtime typecheck`; `pnpm --filter @mavis/local-runtime exec vitest run test/unit/local-remote-token-counter.test.ts test/unit/local-context-auto-compaction-remote-token-gate.test.ts test/unit/local-context-auto-compaction-token-gate.test.ts test/unit/local-dynamic-max-tokens.test.ts`; `pnpm --filter @mavis/local-runtime exec vitest run test/e2e/local-context-auto-compaction-gate.e2e.test.ts`.

### 2026-07-15 — backport GPT-5.6 catalog and Max thinking

- Reason: v0.79.1 lacks the three suffixed GPT-5.6 models, so local-runtime can fall back to `anthropic-messages`; the product also needs GPT-5.6's independent `max` effort without importing a later Pi release wholesale.
- Affected packages: `packages/ai`, `packages/agent`, and the minimum `packages/coding-agent` type/build adapters. MiniMax resolver and token-budget glue remains in `packages/local-runtime`.
- Change type: selective generic upstream material from `7df2a94e0fb1606aace92e662a176d668b93d20d` (GPT-5.6 metadata), `fbdd46389c3a0c03b62f5e9eabe31a85044ef8ce` (first-class Max), `6c735db0605a9f453ecea793d2ff9524c6416448` (remove the nonexistent bare alias), and `a9ecf301fb56c688570e0db0299926ce9009dbb8` (final limits and pricing metadata). Baseline, package versions, lockfile, and `.minimax-vendor.json` remain v0.79.1.
- Upstream context: issue `earendil-works/pi#6097` was closed as completed after maintainer confirmation that Max had landed. The v0.79.1 `Cost` type has no pricing tiers, so this backport keeps base costs and omits the later tiered pricing shape.
- Host boundary: local-runtime treats the IDL thinking toggle as the master switch, reads the typed canonical `thinking.effort`, and copies only the catalog's string `thinkingLevelMap.max` for an explicitly Max-capable model. Provider dispatch remains keyed by provider/API/model metadata rather than request payload presence.
- Upstream PR: not opened; the generic behavior is already upstream.
- Validation: `pnpm --filter @earendil-works/pi-ai exec vitest --run test/gpt-5-6-max-thinking.test.ts`; `pnpm --filter @earendil-works/pi-coding-agent... build`; focused local-runtime resolver, token-budget, remote-counter, and GPT-5.6 wire E2E suites. `pnpm check:pi-vendor-resolution` remains blocked by the baseline `packages/agent-runtime` dependency guard, outside this patch.

### 2026-06-16 — deterministic `@earendil-works/pi-ai` build

- Reason: MiniMax CI and Docker builds run without reliable access to external model metadata endpoints (`models.dev`, OpenRouter, Vercel AI Gateway). The upstream `build` script regenerated model files before compiling, which made routine workspace builds non-deterministic and could leave generated files in a TypeScript-incompatible fallback shape when DNS failed.
- Affected package: `packages/ai` (`@earendil-works/pi-ai`).
- Change type: generic upstream material. Keep model metadata refresh available as an explicit `refresh-models` script, but make `build` compile the committed generated baselines only.
- Upstream PR: not opened during the spike.
- Validation: `pnpm --filter @earendil-works/pi-ai build`; `pnpm --filter @mavis/local-runtime... build`; `pnpm test:archon-guards`.

### 2026-06-19 — accept Claude Fable 5 adaptive thinking metadata

- Reason: Claude Fable 5 is expected to use Anthropic adaptive thinking metadata. The local metadata regression test still rejected `claude-fable-5` entries because its allow-list only covered Opus 4.6/4.7/4.8 and Sonnet 4.6.
- Affected package: `packages/ai` (`@earendil-works/pi-ai`).
- Change type: generic upstream material. Update the adaptive-thinking model assertion to include Fable 5 provider variants.
- Upstream PR: not opened.
- Validation: `pnpm --filter @earendil-works/pi-ai exec vitest --run test/anthropic-adaptive-thinking-models.test.ts --reporter verbose`; `pnpm --filter @earendil-works/pi-ai build`.

### 2026-06-19 — remove unstable fork target session-id assertion

- Reason: The `--session-id` read-only regression file had one fork-target collision assertion that failed before reaching collision handling when the local test environment has no selected-model API key. Keep the metadata/read-only coverage in the same file and remove this unstable assertion.
- Affected package: `packages/coding-agent` (`@earendil-works/pi-coding-agent`).
- Change type: generic upstream material. Test-only adjustment.
- Upstream PR: not opened.
- Validation: `pnpm --filter @earendil-works/pi-coding-agent exec vitest --run test/session-id-readonly.test.ts --reporter verbose`; `pnpm --filter @earendil-works/pi-coding-agent build`.

### 2026-07-04 — edit tool: scope fuzzy-match normalization to the matched span

- Reason: In `applyEditsToNormalizedContent`, when any edit fell back to fuzzy matching, the whole file was rewritten with `normalizeForFuzzyMatch` before saving. A single fuzzy edit silently ASCII-folded every smart quote, Unicode dash, special space (including U+3000) and stripped all trailing whitespace across the entire file — a data-fidelity bug that is especially harmful for CJK / full-width content. Fuzzy matching now only locates the target: the normalized-space hit is mapped back to a span of the original content (per-line NFKC column mapping with monotonic prefix binary search) and the replacement splices that span only; bytes outside matched spans are never rewritten. Also adds a disproportionate-match guard for fuzzy hits (opencode thresholds) and improves self-correction hints in error messages (not-found suggests re-reading the file; duplicate errors list the first match line numbers).
- Affected package: `packages/coding-agent` (`@earendil-works/pi-coding-agent`), `src/core/tools/edit-diff.ts` only; public `fuzzyFindText` result now always reports original-content coordinates and no longer exposes `contentForReplacement` (no other in-repo consumers).
- Change type: generic upstream material. Behavior fix + regression tests in `test/edit-diff-fuzzy-span.test.ts`.
- Upstream PR: not opened.
- Validation: `pnpm --filter @earendil-works/pi-coding-agent exec vitest --run test/edit-diff-fuzzy-span.test.ts test/edit-tool-legacy-input.test.ts test/edit-tool-no-full-redraw.test.ts test/file-mutation-queue.test.ts`; `pnpm --filter @earendil-works/pi-coding-agent build`.

### 2026-07-07 — bash: graceful SIGTERM→grace→SIGKILL on stop/timeout so cleanup traps run

- Reason: Background bash `task_stop` (and the per-command timeout) aborted through `createLocalBashOperations`'s `onAbort` → `killProcessTree`, which sent an immediate `SIGKILL` (signal 9, uncatchable) to the process group. A script's `trap ... TERM/INT` cleanup handler therefore never ran — cleanup logic was silently skipped and its artifacts (marker/temp files) leaked. Confirmed by the mcode-test E2E harness (case L7) driving the real CLI TUI LOG runtime. This is the `abort()`-one-stage limitation deferred in `.harness/docs/design/tools-optimize/bash-tool-optimization.md` §5.
- Affected package: `packages/coding-agent` (`@earendil-works/pi-coding-agent`), `src/utils/shell.ts` (new `terminateProcessTreeGracefully` + `PROCESS_TREE_TERM_GRACE_MS`) and `src/core/tools/bash.ts` (abort + timeout paths call the graceful variant). The pending SIGKILL escalation is cancelled only once the process GROUP is empty (`kill(-pid, 0)` throws ESRCH); if a command backgrounded a SIGTERM-ignoring descendant that outlives the shell, the escalation stays armed so the grace-window SIGKILL still reaps it (`waitForChildProcess` resolving on shell exit is not proof the group is gone). The emergency node-exit cleanup (`killTrackedDetachedChildren` → `killProcessTree`) intentionally keeps immediate SIGKILL.
- Change type: generic upstream material. Behavior fix + regression tests in `test/graceful-terminate.test.ts` (Unix-guarded: SIGTERM lets a TERM trap run; ignored-SIGTERM escalates to SIGKILL; canceller disarms escalation; abort with a SIGTERM-ignoring backgrounded descendant still SIGKILLs it — no early cancel).
- Upstream PR: not opened.
- Validation: `pnpm --filter @earendil-works/pi-coding-agent exec vitest --run test/graceful-terminate.test.ts`; `pnpm --filter @earendil-works/pi-coding-agent build`; downstream `pnpm --filter @mavis/local-runtime exec vitest run --config vitest.config.ts test/unit/local-background-bash-runner.test.ts` (L7 regression) + mcode-test `node bin/run-case.mjs L7`.

### 2026-07-09 — edit tool: fidelity guard rejecting a widened fuzzy span that swallows a compat character

- Reason: The span back-map in `fuzzyFindText` widens outward (start rounds down, end rounds up) so a replacement never splits an original code point. That widening could otherwise SWALLOW a whole compatibility character the model only partly named — e.g. `oldText` `"ix"` against a line `"ﬁx"` (NFKC `ﬁ`→`fi`) matches in normalized space starting inside the ligature, then the back-map maps onto the entire `"ﬁx"` and the replacement silently destroys the `ﬁ`. Added a fidelity guard: after mapping, `normalizeForFuzzyMatch(content.slice(start, end))` must reproduce exactly the located `fuzzyOldText`; if widening pulled in extra characters it won't, so the match fails closed (returns not-found) and the model retries with an unambiguous `oldText` instead of clobbering bytes it never named. Legitimate fuzzy matches (whose mapped span re-normalizes to exactly the located text) are unaffected.
- Affected package: `packages/coding-agent` (`@earendil-works/pi-coding-agent`), `src/core/tools/edit-diff.ts` only (`fuzzyFindText`). Extends the 2026-07-04 span-mapping change.
- Change type: generic upstream material. Behavior fix + regression tests in `test/edit-diff-fuzzy-span.test.ts` (ligature-partial-name fails closed; a full-width run named cleanly still applies — guard not over-strict).
- Upstream PR: not opened.
- Validation: `pnpm --filter @earendil-works/pi-coding-agent exec vitest --run test/edit-diff-fuzzy-span.test.ts test/edit-tool-legacy-input.test.ts test/edit-tool-no-full-redraw.test.ts test/file-mutation-queue.test.ts`; `pnpm --filter @earendil-works/pi-coding-agent build`.

### 2026-08-20 — bash: opt-in parent-death guardian for detached command trees

- Reason: `SIGKILL` is uncatchable, so an embedded CLI/TUI host could die before its JS abort and shutdown handlers reclaimed Pi's detached Bash process group. The B-A4 mcode-test left the long-running script alive after the CLI host was killed, allowing continued file, network, CPU, port, and lock side effects.
- Affected package: `packages/coding-agent` (`@earendil-works/pi-coding-agent`), `src/utils/shell.ts` (one shared detached IPC guardian per host process) and `src/core/tools/bash.ts` (opt-in `createLocalBashOperations({ parentDeathGuard: true })`). The default remains off; `packages/local-runtime` enables it only for managed local Bash, so cloud-runtime sandbox lifecycle is unchanged.
- Change type: generic upstreamable primitive plus MiniMax host opt-in. Every registration has a unique lease ID, so a stale disarm cannot remove a PID-reused target. Unix uses an absolute system `sh` gate independent of the command `PATH`, then `exec`s the real shell after ACK, preserving shell PID=PGID; Windows uses a minimal-environment Node launcher and sends the real shell environment with the post-ACK payload, so host `NODE_OPTIONS` cannot poison the launcher. PowerShell 5.1 encoding setup uses a short inline launcher and sends the untouched command over stdin into an in-memory ScriptBlock, preserving first-statement syntax without Base64 argv expansion, `.ps1` policy checks, or crash-persistent command files; it validates the parsed top-level `ScriptRequirements` before execution. Stdout/stderr use independent streaming decoders, including the truncated full-output file, so interleaved split UTF-8 bytes remain valid text. If the host IPC lease disappears, the guardian terminates every armed process group with `SIGTERM → 3s grace → SIGKILL`; Windows uses native `taskkill /T` then `/F /T`.
- Upstream PR: not opened.
- Validation: `pnpm --filter @earendil-works/pi-coding-agent exec vitest --run test/graceful-terminate.test.ts test/windows-taskkill.test.ts test/bash-close-hang-windows.test.ts test/tools.test.ts`; `pnpm --filter @earendil-works/pi-coding-agent build`; `node scripts/test/focused-vitest.mjs --package @mavis/local-runtime packages/local-runtime/test/unit/local-background-bash-runner.test.ts packages/local-runtime/test/unit/local-background-bash-executor.test.ts packages/local-runtime/test/unit/local-background-task.test.ts`.

### 2026-09-05 — Optional Bash process-fact observation

- Reason: sandboxing must distinguish execution preparation, actual child spawn, guardian command delivery, and timer timeout. Preflight callbacks cannot prove startup, and error-string parsing cannot reliably identify timeouts.
- Affected package: optional `onProcessEvent` in `BashOperations.exec` of `@earendil-works/pi-coding-agent`. Default behavior is unchanged and observer exceptions are isolated. Guardian launchers and ordinary shells are explicitly distinguished.
- Type: generic, upstreamable execution interface without Archon configuration or reporting logic. Dependency checks also register the three existing direct Pi dependencies of `local-runtime-v2` and verify `workspace:*` and source resolution.
- Validation: `pnpm --filter @earendil-works/pi-coding-agent build`; `pnpm --filter @earendil-works/pi-coding-agent exec vitest --run test/bash-process-observation.test.ts test/bash-close-hang-windows.test.ts`; affected local-runtime-v2 sandbox focused tests. Windows-only tests were skipped on macOS; no real Windows validation is claimed.

For future changes, add one entry per MiniMax patch with:

- reason and affected package
- whether the change is generic upstream material or MiniMax-specific glue
- validation commands and results

## 2026-09-08: Explicit steering batches

- Reason: immediately submitted local user batches must be consumed in one provider hop while retaining each message identity.
- Affected package: `Agent.steerBatch` added to `@earendil-works/pi-agent-core`; individual `steer` / `followUp` and default modes remain compatible.
- Validation: `pnpm --filter @earendil-works/pi-agent-core build`; `node scripts/test/focused-vitest.mjs --package @earendil-works/pi-agent-core --skip-workspace-build third_party/pi-mono/packages/agent/test/agent.test.ts` (19 tests); agent-core focused `pi-turn-runner.test.ts` covers local batches and machine-only individual consumption.

## 2026-09-21: Propagate native exit codes through Windows PowerShell 5.1 wrappers

- Reason: `wrapWindowsPowerShellStdinCommand` ends with `& ([ScriptBlock]::Create($source))` and `wrapConstrainedWindowsPowerShellCommand` ends with `Invoke-Expression $source`. On Windows PowerShell 5.1, a `-Command` session whose final statement is a scriptblock invocation exits 0 regardless of `$LASTEXITCODE` set by native commands inside it, so every failing native command was reported as success (foreground tool result and background task status) on hosts without pwsh 7. Reproduced before the fix: a `node -e "…;process.exit(7)"` command produced its stderr yet the shell process exited 0.
- Affected package: `@earendil-works/pi-coding-agent` local bash operations, PowerShell 5.1 transport only (`src/core/tools/bash.ts`). pwsh 7 (native `-Command` path) and POSIX shells are untouched. PowerShell-internal terminating errors still exit non-zero via `throw` before the appended statement.
- Type: generic, upstreamable Windows fix using the same `exit $LASTEXITCODE` idiom already used by the first-party `packages/tui/src/update/versioned-prefix.ts` launchers.
- Change: append `exit $LASTEXITCODE` after the scriptblock invocation (stdin transport) and after `Invoke-Expression` (ConstrainedLanguage transport).
- Upstream PR: not opened.
- Validation (Windows 11 x64 build 26200, PowerShell 5.1 default, Node 24.18.0): `packages/local-runtime/test/unit/child-bash-lifecycle.test.ts` 'failure' mode fails before the fix (`expected 'succeeded' to be 'failed'`) and passes after; 'timeout' and 'cancel' modes unaffected. Focused re-run of the affected suites and full `pnpm test:capabilities` show no new failures. Not run: pwsh 7 host validation, ConstrainedLanguage host validation (launcher covered by structure assertions only), macOS/Linux regression runs.

## 2026-10-25 — reapply PR-09 onto the pin: Bash/Read exact facts + split streams + bounded output + process observation (W07 part A; registry PR-09, verdict take, ledger №14/№3/№43)

- Reason: the pin's `BashToolDetails` carried only `{ truncation?, fullOutputPath? }` and `ReadToolDetails` only `{ truncation? }` — no execution outcome, no command-timer facts, no raw-byte/output-persistence accounting, no split-stream process facts, and no undecorated text-file facts. Product consumers (desktop Compatible PostToolUse bridge, background bash task settlement, task_output status rendering) structured their contracts around the 0.79-era patch surface and degraded silently: a nonzero exit settled background tasks as `succeeded`, timed-out commands lost their deadline facts, Compatible BashOutput handlers were skipped for every bash call, and Compatible FileReadOutput handlers never fired.
- Affected package: `packages/coding-agent` (`@earendil-works/pi-coding-agent`): `src/utils/child-process.ts`, `src/core/tools/{output-accumulator,bash,read}.ts` (+ `powershell.ts` forwarding `separatesOutputStreams`), export surface in `src/core/tools/index.ts` / `src/index.ts`.
- Change (merged onto the pin's newer base, keeping pin improvements): `waitForChildProcessExit` resolves `{ exitCode, signal }` while keeping the pin's idle-rearm grace (#5303 fix); `waitForChildProcess` delegates. `OutputAccumulator` gains `strategy: "tail" | "head_tail"` (45/55 head/tail around an omission marker), `persistOutput: false` (host already owns the complete log), `rawBytes` on the snapshot, per-stream decoders, a write-stream error captured into `tempFileError` (the full-output reference degrades instead of crashing the command), and always-reported `fullOutputPath` unless persistence failed. `BashOperations` grows `separatesOutputStreams`, split `onData(data, stream)`, `onProcessEvent` (`spawned`/`spawn_failed`/`timeout`/`command_dispatched`/`timer_started`, observer exceptions isolated), and resolves `{ exitCode, signal }`; the local shell backend emits all of them. `BashToolDetails` grows `execution` (typed `BashExecutionOutcome`), `timing` (`commandTimerStartedAt`/`commandDeadlineAt` from the observed timer), `output` (`rawBytes`/`persistence`/`persistenceError`), and `processOutput` (exact bounded `stdout`/`stderr` + `interrupted` + truncation flags + `rawOutputPath`); `BashExecutionError` carries the same facts through failures. Deliberate merge decisions: a nonzero exit stays a RETURNED `isError: true` result (pin behavior, so codemode callers keep `structuredContent.exit_code`) with execution facts attached, while timeout/abort/spawn failures THROW the typed `BashExecutionError` (0.79 behavior, so the product path keeps full details via `instanceof`); with the host `output.strategy: "head_tail"` policy the tool emits no Pi footer (the host owns the model-facing notices). `ReadToolDetails` grows `textFile` (path/content/numLines/startLine/totalLines/truncatedByOutputLimit/wholeFileAutoTruncated) retained before continuation notices decorate the text. New exports: `BashExecutionError`, `BashExecutionOutcome`, `BashProcessOutput`, `OutputAccumulator`(+Options), `ReadTextFileResult`. Out of scope here (registry PR-10): parent-death guardian, ConstrainedLanguage, SIGTERM-grace kill escalation.
- Product side (same round): the temporary contract copy `packages/agent-tools/src/desktop/local-bash-result.ts` no longer re-declares the vendored types — it imports `BashExecutionError`/`BashExecutionOutcome`/`BashToolDetails` from `@earendil-works/pi-coding-agent` and re-exports them (single class identity for `instanceof`), keeping only the product helpers (`localBashResultFromPi`/`localBashResultFromError`/`readBashExecutionOutcome`/`formatBashExecutionOutcome`). The host-side consumers (`local-runtime-v2/service/background-bash/executor.ts`, `local-runtime/background-task/bash-runner.ts`, desktop `local-pi-tools.ts`) already spoke this surface and needed no semantic changes.
- Shell discriminator restored in the same reapply: the pin's `ShellConfig` dropped the 0.79 fork's `type: "bash" | "sh" | "pwsh" | "powershell"` field; product shell-capability reporting (`packages/agent-tools/src/desktop/{local-bash-contract,local-pi-tools}.ts`) and the child-bash test quoting logic classify shells by it. `getShellConfig`/`getPowerShellConfig` now set it at every return site (bash/sh/pwsh/powershell); the vendored `test/powershell-config.test.ts` exact-equality expectations are updated to carry `type` (same convention as the W06 empty-tools upstream-test restoration).
- Validation (run in this round, cwd=src): `pnpm exec tsc --noEmit -p third_party/pi-mono/packages/coding-agent/tsconfig.build.json` → 0 errors; `pnpm exec vitest run --config vitest.oss.config.mjs packages/agent-tools/test/desktop/local-bash-output.test.ts packages/agent-tools/src/desktop/local-pi-tools-spill.test.ts packages/local-runtime/test/unit/child-bash-lifecycle.test.ts` → 28 passed (13 red of which these carried 10 are green, incl. the real 61.5 s soft-yield deadline and real shell failure→`failed` status); agent-tools capability suites re-run below (W07 part A state file).

## 2026-10-25 — reapply PR-08 onto the pin: edit bounded diff/patchOmitted (W07 part A; registry PR-08, ledger №5/№4; №39/№40 NOT reapplied — see below)

- Reason: the pin computes the edit receipt diffs unconditionally (`generateUnifiedPatch` without bounds; grep confirms no `maxEditLength/timeout/patchOmitted/diffOmitted` surface). A whole-file rewrite of ~20 000 lines spent 167–173 s in Myers (twice) and produced a multi-MB patch nothing renders; the Compatible file-edit hook lost `structuredPatch` semantics on oversized edits.
- Affected package: `packages/coding-agent` `src/core/tools/edit-diff.ts` + `edit.ts`; `src/index.ts` exports `DIFF_MAX_EDIT_LENGTH`/`DIFF_TIMEOUT_MS`/`DiffOmittedReason`.
- Change: `generateUnifiedPatch` returns `string | undefined` and `generateDiffString` returns `EditDiffResult` with `omitted?: DiffOmittedReason`, both bounded by jsdiff `maxEditLength: 2000 / timeout: 5000` (the 0.79 shape: 2000 edit-script length ≈ full rewrite up to 1000 lines keeps its diff; deterministic abort). The renderer body is extracted into `generateDiffStringFromParts` so the bounded wrapper shares it; preview (`computeEditsDiff`) inherits the same bounds and renders the one-line notice. `EditToolDetails.patch` becomes optional; `execute` skips the patch Myers run when the display diff was abandoned (same bounds would abort it) and reports `diffOmitted`/`patchOmitted` (`too_many_changes`, or `timeout` for the patch's own wall clock). The file write itself is unaffected — the diffs are receipts computed after the write.
- NOT reapplied: ledger №39 (fuzzy span back-map) / №40 (fidelity guard) — the pin's fuzzy pipeline has been rewritten upstream since the 0.79 fork (span-preserving `applyReplacementsPreservingUnchangedLines` replaces the whole-file normalize-on-fuzzy-hit path the №39 patch originally fixed); porting the 0.79 span rework over it is its own G-PORT-tested change and is deferred honestly rather than half-merged. No failing product test depends on it (edit-diff-bounds pins only the bounded-diff behavior).
- Validation (run in this round, cwd=src): `pnpm exec tsc --noEmit -p third_party/pi-mono/packages/coding-agent/tsconfig.build.json` → 0 errors; `pnpm exec vitest run --config vitest.oss.config.mjs packages/agent-tools/src/desktop/edit-diff-bounds.test.ts` → 6 passed (whole-file rewrite omitted with `too_many_changes` while the file still lands; Compatible hook receives `structuredPatch: []` bounded under 1 MiB; bounded 400/1000-line rewrites keep hunks). Node check of jsdiff 8.0.4 `createTwoFilesPatch`/`diffLines` with `maxEditLength` returning `undefined` ran in this session.

## Foreground loop injection

Agent accepts an optional host loop implementation and retains lifecycle, events and steering queues. The durable CLI host supplies its GenerationTask adapter. The adapter shares the tool declaration, unexpected tool call normalization and truncated tool call result helpers with the standard Agent loop.

## Pi v1.5.2 conformance in the Niwa Labs fork

The model and provider entries resolve workspace source in the Node child
process used by conformance tests. The Anthropic fixtures use the v1.5.2
stream API and beta client. Missing stop reasons remain upstream errors.
The final tool argument parser uses the same integer-source reviver as the
streaming parser, so schema coercion receives the original digits.

The v1.5.2 streaming and buffered read paths both honor the existing host
truncation option. Default caps and offset handling stay in effect. The
port conformance gate selects these provider and read regression suites.
