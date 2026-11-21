/**
 * `@mavis/codemode-host` — the codemode sandbox host (W07 part B).
 *
 * `@earendil-works/pi-codemode` is the npm dependency (workspace pin); this
 * package is the host glue: out-of-context nested tool calls through the ONE
 * gateway invoker, bounded call records, partial output on script failure, and
 * deterministic replay with explicit safe/never verdicts.
 */

export {
  ARGS_PREVIEW_CHARS,
  ERROR_PREVIEW_CHARS,
  createNestedCodemodeTools,
  previewArgs,
  toScriptValue,
  toolCatalog,
  truncateText,
  type CallableToolDeclaration,
  type CodemodeNestedCall,
  type CodemodeNestedCallStatus,
  type CreateNestedToolsInput,
  type NestedToolInvoker,
  type NestedToolsResult,
} from './nested-tools.js';
export {
  CODEMODE_MEMORY_LIMIT_BYTES,
  DEFAULT_MAX_OUTPUT_TOKENS,
  executeCodemodeScript,
  truncateScriptOutput,
  type CodemodeExecuteInput,
  type CodemodeSandboxMode,
  type CodemodeToolOutput,
} from './host.js';
export {
  classifyReplay,
  replayRecording,
  startRecordingRun,
  type CodemodeRecording,
  type RecordedCall,
  type RecordingRunOptions,
  type ReplayOutcome,
  type ReplayVerdict,
} from './replay.js';
export { CODEMODE_TOOL_NAME, createCodemodeRuntimeTool, type CodemodeRuntimeToolDeps } from './tool.js';
