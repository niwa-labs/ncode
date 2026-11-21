import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { spawn } from "child_process";
import { type Static, Type } from "typebox";
import { waitForChildProcessExit } from "../../utils/child-process.ts";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	type ShellConfig,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { OutputAccumulator, type OutputAccumulatorOptions } from "./output-accumulator.ts";
import { BASH_UPDATE_THROTTLE_MS, createShellRenderers } from "./renderers/bash.ts";
import { type TypeBoxAgentTool, wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "./truncate.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
/** Output limit of `structuredContent.output`, which programmatic callers such as codemode scripts receive. */
const STRUCTURED_OUTPUT_MAX_BYTES = 1024 * 1024;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}

	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	return timeoutMs;
}

const bashSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export const bashToolSystemPromptContribution = {
	snippet: "Execute bash commands (ls, grep, find, etc.)",
	guidelines: ["You can inspect PI_* environment variables for current model and session details."],
} as const;

export type BashToolInput = Static<typeof bashSchema>;

/**
 * Result for programmatic callers such as codemode scripts. A non-zero exit code is an error result for the model, but scripts still resolve to this value.
 * `output` is not limited like the model-facing output: callers decide how much of it reaches the model.
 */
const bashOutputSchema = Type.Object({
	output: Type.String({ description: "Combined stdout and stderr, possibly truncated" }),
	truncated: Type.Boolean(),
	full_output_path: Type.Optional(Type.String({ description: "Full output, when truncated" })),
	exit_code: Type.Number(),
	wall_time_seconds: Type.Number(),
});

export type BashToolOutput = Static<typeof bashOutputSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
	/** MiniMax reapply (W01-C PR-09, ledger №14): typed execution outcome facts. */
	execution?: BashExecutionOutcome;
	/** MiniMax reapply (W01-C PR-09): wall-clock command timer facts, when a timeout applies. */
	timing?: { commandTimerStartedAt: number; commandDeadlineAt: number };
	/** MiniMax reapply (W01-C PR-09, ledger №43): bounded-output accounting for the preview. */
	output?: {
		rawBytes: number;
		persistence: "inline" | "complete" | "incomplete" | "host";
		persistenceError?: string;
	};
	/** MiniMax reapply (W01-C PR-09, ledger №3): exact process facts retained for consumers that need split streams. */
	processOutput?: BashProcessOutput;
}

export interface BashExecutionOutcome {
	status: "succeeded" | "failed" | "canceled";
	reason: "exited" | "signaled" | "command_timeout" | "canceled" | "spawn_failed" | "unknown";
	exitCode: number | null;
	signal?: NodeJS.Signals;
	errorCode?: string;
	/** The shell finished, but descendants kept its output pipes active until timeout. */
	shellExit?: { exitCode: number; afterSeconds: number };
	cancellationReason?: string;
	/** Failure explanation without duplicating captured command output. */
	message?: string;
}

/** Carries the same output and execution facts as a successful Bash result. */
export class BashExecutionError extends Error {
	readonly details: BashToolDetails & { execution: BashExecutionOutcome };
	readonly code?: string;

	constructor(message: string, details: BashToolDetails & { execution: BashExecutionOutcome }, options?: ErrorOptions) {
		super(message, options);
		this.name = "BashExecutionError";
		this.details = details;
		this.code = details.execution.errorCode;
	}
}

export interface BashProcessOutput {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	interrupted: boolean;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	rawOutputPath?: string;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/** MiniMax reapply (W01-C PR-09, ledger №3): whether exec invokes the split stdout/stderr callbacks exactly. */
	readonly separatesOutputStreams?: boolean;
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to the exit code and, when available, terminating signal.
	 * Report signal terminations as 128 + signal number; a null exit code is treated as a failed command.
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			/** MiniMax reapply (W01-C PR-09): second argument names the stream when `separatesOutputStreams` is set. */
			onData: (data: Buffer, stream?: "stdout" | "stderr") => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
			/** MiniMax reapply (W01-C PR-09, ledger №43): best-effort process facts. A launcher spawn does not prove the user command started. */
			onProcessEvent?: (event: {
				type: "spawned" | "spawn_failed" | "timeout" | "command_dispatched" | "timer_started";
				atMs?: number;
				processRole: "shell" | "guardian_launcher";
			}) => void;
		},
	) => Promise<{ exitCode: number | null; signal?: NodeJS.Signals | null }>;
}

/**
 * Timeout of the local shell backend. Its message keeps the `timeout:<seconds>` form custom operations throw.
 * `shellExit` is set when the shell itself exited before the deadline, so the tool was only still waiting
 * because background processes kept writing to the inherited stdout/stderr pipes (#11613).
 */
class ShellTimeoutError extends Error {
	readonly shellExit: { exitCode: number; afterSeconds: number } | undefined;

	constructor(timeout: number | undefined, shellExit: { exitCode: number; afterSeconds: number } | undefined) {
		super(`timeout:${timeout}`);
		this.shellExit = shellExit;
	}
}

/** Shared process execution used by the built-in shell tools. */
export function createLocalShellOperations(shellName: string, resolveShellConfig: () => ShellConfig): BashOperations {
	return {
		// MiniMax reapply (W01-C PR-09, ledger №3): the local shell backend streams
		// stdout and stderr separately.
		separatesOutputStreams: true,
		exec: async (command, cwd, { onData, signal, timeout, env, onProcessEvent }) => {
			// MiniMax reapply (W01-C PR-09, ledger №43): observers never control execution.
			const observe = (
				type: "spawned" | "spawn_failed" | "timeout" | "command_dispatched" | "timer_started",
				atMs?: number,
			): void => {
				try {
					onProcessEvent?.({ type, processRole: "shell", ...(atMs === undefined ? {} : { atMs }) });
				} catch {
					// Observers never control execution.
				}
			};
			const timeoutMs = resolveTimeoutMs(timeout);
			if (signal?.aborted) {
				throw new Error("aborted");
			}
			const shellConfig = resolveShellConfig();
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute ${shellName} commands.`);
			}

			const commandFromStdin = shellConfig.commandTransport === "stdin";
			const child = spawn(shellConfig.shell, commandFromStdin ? shellConfig.args : [...shellConfig.args, command], {
				cwd,
				detached: process.platform !== "win32",
				env: env ?? getShellEnv(),
				stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			// MiniMax reapply (W01-C PR-09, ledger №43): a failed `spawn` emits "error"
			// asynchronously; observe it without letting it crash the host.
			child.once("spawn", () => observe("spawned"));
			child.once("error", () => observe("spawn_failed"));
			if (commandFromStdin) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(command);
			}
			if (child.pid) trackDetachedChildPid(child.pid);
			const startedAt = performance.now();
			let shellExitedAfterMs: number | undefined;
			child.once("exit", () => {
				shellExitedAfterMs = performance.now() - startedAt;
			});
			let timedOut = false;
			let exitedBeforeDeadlineAfterMs: number | undefined;
			let timeoutHandle: NodeJS.Timeout | undefined;
			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};

			try {
				// Set timeout if provided.
				if (timeoutMs !== undefined) {
					const timerStartedAt = Date.now();
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						observe("timeout");
						exitedBeforeDeadlineAfterMs = shellExitedAfterMs;
						// Also when the shell already exited: on Unix the group kill still reaches background
						// processes holding the pipes. Windows cannot find them once the shell pid is gone.
						if (child.pid) killProcessTree(child.pid);
					}, timeoutMs);
					observe("timer_started", timerStartedAt);
				}
				// Stream stdout and stderr separately (MiniMax reapply, W01-C PR-09 ledger №3).
				child.stdout?.on("data", (data: Buffer) => onData(data, "stdout"));
				child.stderr?.on("data", (data: Buffer) => onData(data, "stderr"));
				// Handle abort signal by killing the entire process tree.
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// Handle shell spawn errors and wait for the process to terminate without hanging
				// on inherited stdio handles held by detached descendants.
				const termination = await waitForChildProcessExit(child);
				if (signal?.aborted) {
					throw new BashExecutionError("aborted", {
						execution: {
							status: "canceled",
							reason: "canceled",
							exitCode: null,
							...(termination.signal ? { signal: termination.signal } : {}),
							cancellationReason: formatCancellationReason(signal),
							message: "Command aborted",
						},
					});
				}
				if (timedOut) {
                    const shellExit = exitedBeforeDeadlineAfterMs !== undefined
                        ? { exitCode: termination.exitCode ?? (termination.signal ? 128 + (osConstants.signals[termination.signal] ?? 0) : 1),
                            afterSeconds: Math.round(exitedBeforeDeadlineAfterMs / 100) / 10 }
                        : undefined;
                    const cause = new ShellTimeoutError(timeout, shellExit);
                    const message = `Command timed out after ${timeout} seconds` + (shellExit
                        ? `. The shell exited with code ${shellExit.exitCode} after ${shellExit.afterSeconds} seconds, but background processes it started kept writing output until the timeout.`
                        : '');
                    throw new BashExecutionError(cause.message, {
                        execution: { status: "failed", reason: "command_timeout", exitCode: null,
                            ...(termination.signal ? { signal: termination.signal } : {}),
                            ...(shellExit ? { shellExit } : {}), message },
                    }, { cause });
                }
				// A signal-killed shell has no exit code. Use the standard shell convention so
				// callers do not mistake the termination for a successful command.
				const exitCode =
					termination.exitCode ??
					(termination.signal ? 128 + (osConstants.signals[termination.signal] ?? 0) : 1);
				return { exitCode, signal: termination.signal };
			} finally {
				if (child.pid) untrackDetachedChildPid(child.pid);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
			}
		},
	};
}

/** MiniMax reapply (W01-C PR-09): carry the abort reason into typed execution facts. */
function formatCancellationReason(signal?: AbortSignal): string | undefined {
	if (!signal?.aborted) return undefined;
	return signal.reason instanceof Error
		? signal.reason.message
		: typeof signal.reason === "string"
			? signal.reason
			: undefined;
}

/**
 * Create bash operations using pi's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want pi's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	return createLocalShellOperations("bash", () => getShellConfig(options?.shellPath));
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(
	command: string,
	cwd: string,
	spawnHook: BashSpawnHook | undefined,
	exposeSessionEnvironment: boolean,
	ctx: ExtensionContext | undefined,
): BashSpawnContext {
	const env = { ...getShellEnv() };
	delete env.PI_SESSION_ID;
	delete env.PI_SESSION_FILE;
	delete env.PI_PROVIDER;
	delete env.PI_MODEL;
	delete env.PI_REASONING_LEVEL;
	if (exposeSessionEnvironment && ctx) {
		const model = ctx.model;
		env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile) env.PI_SESSION_FILE = sessionFile;
		if (model) {
			env.PI_PROVIDER = model.provider;
			env.PI_MODEL = model.id;
		}
		if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
	}
	const baseContext: BashSpawnContext = { command, cwd, env };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	/** MiniMax reapply (W01-C PR-09): host-specific preview and persistence policy; defaults retain Pi's tail preview. */
	output?: OutputAccumulatorOptions;
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Expose current Pi session metadata as PI_* environment variables. Default: true */
	exposeSessionEnvironment?: boolean;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
}

/**
 * MiniMax reapply (W01-C PR-09, ledger №3): keep a split stream only while it
 * remains small enough to return exactly.
 */
const BASH_SPLIT_STREAM_MAX_BYTES = DEFAULT_MAX_BYTES;
const BASH_SPLIT_STREAM_MAX_LINES = DEFAULT_MAX_LINES;

class BashProcessStreamCapture {
	private chunks: Buffer[] = [];
	private bytes = 0;
	private completedLines = 0;
	private hasOpenLine = false;
	private truncated = false;

	append(data: Buffer): void {
		if (this.truncated) return;
		this.bytes += data.length;
		for (const byte of data) {
			if (byte === 0x0a) {
				this.completedLines++;
				this.hasOpenLine = false;
			} else {
				this.hasOpenLine = true;
			}
		}
		if (
			this.bytes > BASH_SPLIT_STREAM_MAX_BYTES ||
			this.completedLines + (this.hasOpenLine ? 1 : 0) > BASH_SPLIT_STREAM_MAX_LINES
		) {
			this.truncated = true;
			this.chunks = [];
			return;
		}
		this.chunks.push(Buffer.from(data));
	}

	snapshot(): { content: string; truncated: boolean } {
		return {
			content: this.truncated ? "" : Buffer.concat(this.chunks).toString("utf-8"),
			truncated: this.truncated,
		};
	}
}

export type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

export interface ShellToolConfig {
	name: string;
	label: string;
	shellName: string;
	prompt: string;
	promptSnippet: string;
	promptGuidelines?: readonly string[];
	tempFilePrefix: string;
}

export function createShellToolDefinition(
	cwd: string,
	config: ShellToolConfig,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
	const commandPrefix = options?.commandPrefix;
	const exposeSessionEnvironment = options?.exposeSessionEnvironment ?? true;
	const spawnHook = options?.spawnHook;
	const outputOptions = options?.output;
	return {
		name: config.name,
		label: config.label,
		description: `Execute a ${config.shellName} command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		promptSnippet: config.promptSnippet,
		promptGuidelines: exposeSessionEnvironment && config.promptGuidelines ? [...config.promptGuidelines] : undefined,
		parameters: bashSchema,
		outputSchema: bashOutputSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ command, timeout }: { command: string; timeout?: number },
			signal?: AbortSignal,
			onUpdate?,
			ctx?: ExtensionContext,
		) {
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(
				resolvedCommand,
				ctx?.cwd || cwd,
				spawnHook,
				exposeSessionEnvironment,
				ctx,
			);
			const output = new OutputAccumulator({ tempFilePrefix: config.tempFilePrefix, ...outputOptions });
			// MiniMax reapply (W01-C PR-09, ledger №3): exact split-stream captures for
			// Compatible PostToolUse consumers.
			const stdout = new BashProcessStreamCapture();
			const stderr = new BashProcessStreamCapture();
			let acceptingOutput = true;
			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;
			// MiniMax reapply (W01-C PR-09, ledger №14): command timer facts from the
			// operations layer, when it observes the timer arming.
			let timing: BashToolDetails["timing"];

			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				onUpdate({
					content: [{ type: "text", text: snapshot.content || "" }],
					details: {
						truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
						fullOutputPath: snapshot.fullOutputPath,
					},
				});
			};

			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};

			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}

			const handleData = (data: Buffer, stream?: "stdout" | "stderr") => {
				if (!acceptingOutput) return;
				// MiniMax reapply (W01-C PR-09, ledger №43): split streams feed both the
				// combined preview and the exact per-stream captures.
				output.append(data, stream);
				if (stream === "stdout") stdout.append(data);
				if (stream === "stderr") stderr.append(data);
				scheduleOutputUpdate();
			};

			const finishOutput = async () => {
				acceptingOutput = false;
				output.finish();
				clearUpdateTimer();
				emitOutputUpdate();
				const stdoutSnapshot = stdout.snapshot();
				const stderrSnapshot = stderr.snapshot();
				// MiniMax reapply (W01-C PR-09, ledger №43): a persistence failure degrades
				// the full-output reference instead of failing a command that already ran.
				let persistenceError: string | undefined;
				try {
					await output.closeTempFile();
				} catch (error) {
					if (!outputOptions) throw error;
					persistenceError = error instanceof Error ? error.message : String(error);
				}
				const snapshot = output.snapshot({ persistIfTruncated: true });
				return { snapshot, stdoutSnapshot, stderrSnapshot, persistenceError };
			};

			const formatOutput = (finished: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
				const { snapshot } = finished;
				const truncation = snapshot.truncation;
				let text = snapshot.content || emptyText;
				let details: BashToolDetails | undefined;
				// MiniMax reapply (W01-C PR-09, ledger №43): the host owning the preview
				// policy also owns the model-facing notices — no Pi footer here.
				if (outputOptions?.strategy === "head_tail") {
					return {
						text,
						details: {
							...(truncation.truncated ? { truncation } : {}),
							fullOutputPath: snapshot.fullOutputPath,
						},
					};
				}
				if (truncation.truncated) {
					details = { truncation, fullOutputPath: snapshot.fullOutputPath };
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					if (truncation.lastLinePartial) {
						const lastLineSize = formatSize(output.getLastLineBytes());
						text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
					} else if (truncation.truncatedBy === "lines") {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
					} else {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
					}
				}
				return { text, details };
			};

			const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;
			// MiniMax reapply (W01-C PR-09): every result carries the same output and
			// execution facts — success and failure alike.
			const resultDetails = (
				finished: Awaited<ReturnType<typeof finishOutput>>,
				execution: BashExecutionOutcome,
			): BashToolDetails & { execution: BashExecutionOutcome } => ({
				...formatOutput(finished).details,
				execution,
				...(timing ? { timing } : {}),
				...(outputOptions
					? {
							output: {
								rawBytes: finished.snapshot.rawBytes,
								persistence: finished.persistenceError
									? ("incomplete" as const)
									: outputOptions.persistOutput === false
										? ("host" as const)
										: finished.snapshot.fullOutputPath
											? ("complete" as const)
											: ("inline" as const),
								...(finished.persistenceError ? { persistenceError: finished.persistenceError } : {}),
							},
						}
					: {}),
				...(ops.separatesOutputStreams
					? {
							processOutput: {
								stdout: finished.stdoutSnapshot.content,
								stderr: finished.stderrSnapshot.content,
								exitCode: execution.exitCode,
								interrupted: execution.reason === "canceled" || execution.reason === "command_timeout",
								stdoutTruncated: finished.stdoutSnapshot.truncated,
								stderrTruncated: finished.stderrSnapshot.truncated,
								rawOutputPath: finished.snapshot.fullOutputPath,
							},
						}
					: {}),
			});
			const startedAt = performance.now();

			try {
				let exitCode: number | null;
				let exitSignal: NodeJS.Signals | null | undefined;
				let spawnFailed = false;
				try {
					const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
						onData: handleData,
						signal,
						timeout,
						env: spawnContext.env,
						// MiniMax reapply (W01-C PR-09, ledger №43): timer and spawn facts flow
						// to the result details; observers never control execution.
						onProcessEvent: (event) => {
							if (event.type === "spawn_failed") spawnFailed = true;
							if (event.type === "timer_started" && event.atMs !== undefined && timeout !== undefined) {
								timing = { commandTimerStartedAt: event.atMs, commandDeadlineAt: event.atMs + timeout * 1000 };
							}
						},
					});
					exitCode = result.exitCode;
					exitSignal = result.signal;
				} catch (err) {
					const finished = await finishOutput();
					const { text } = formatOutput(finished, "");
					// MiniMax reapply (W01-C PR-09, ledger №14): typed execution facts from
					// the operations layer; plain errors keep the legacy protocol.
					let execution: BashExecutionOutcome;
					if (err instanceof BashExecutionError) {
						execution = err.details.execution;
					} else {
						const message = err instanceof Error ? err.message : String(err);
						const errorCode =
							err instanceof Error && "code" in err && typeof (err as { code?: unknown }).code === "string"
								? ((err as { code: string }).code)
								: undefined;
						const canceled = signal?.aborted || message === "aborted";
						const legacyTimeout = message.startsWith("timeout:") ? message.slice("timeout:".length) : undefined;
						execution = {
							status: canceled ? "canceled" : "failed",
							reason: canceled
								? "canceled"
								: legacyTimeout !== undefined
									? "command_timeout"
									: spawnFailed
										? "spawn_failed"
										: "unknown",
							exitCode: null,
							...(canceled ? { cancellationReason: formatCancellationReason(signal) } : {}),
							...(errorCode ? { errorCode } : {}),
							message: canceled
								? "Command aborted"
								: legacyTimeout !== undefined
									? `Command timed out after ${legacyTimeout} seconds`
									: message,
						};
					}
					throw new BashExecutionError(appendStatus(text, execution.message ?? "Command failed"), resultDetails(finished, execution), {
						cause: err,
					});
				}

				const finished = await finishOutput();
				const { text: outputText } = formatOutput(finished);
				// MiniMax reapply (W01-C PR-09, ledger №14): typed outcome facts on the
				// success path too; a nonzero exit stays a returned error result so
				// programmatic callers keep their structured output.
				const execution: BashExecutionOutcome = {
					status: !exitSignal && exitCode === 0 ? "succeeded" : "failed",
					reason: exitSignal ? "signaled" : exitCode === null ? "unknown" : "exited",
					exitCode,
					...(exitSignal ? { signal: exitSignal } : {}),
				};
				if (exitCode === null) {
					execution.message = "Command terminated without an exit code";
					throw new BashExecutionError(appendStatus(outputText, execution.message), resultDetails(finished, execution));
				}
				const wallTimeSeconds = Math.round((performance.now() - startedAt) / 100) / 10;
				const fullOutput = await output.readFullOutput(STRUCTURED_OUTPUT_MAX_BYTES);
				const structuredContent: BashToolOutput = {
					output: fullOutput.content,
					truncated: fullOutput.truncated,
					...(fullOutput.truncated && finished.snapshot.fullOutputPath
						? { full_output_path: finished.snapshot.fullOutputPath }
						: {}),
					exit_code: exitCode,
					wall_time_seconds: wallTimeSeconds,
				};
				if (execution.status !== "succeeded") {
					execution.message = exitSignal
						? `Command terminated by signal ${exitSignal}`
						: `Command exited with code ${exitCode}`;
					return {
						content: [{ type: "text", text: appendStatus(outputText, execution.message) }],
						details: resultDetails(finished, execution),
						structuredContent,
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: outputText }],
					details: resultDetails(finished, execution),
					structuredContent,
				};
			} finally {
				clearUpdateTimer();
			}
		},
		...createShellRenderers(config.prompt),
	};
}

const bashToolConfig: ShellToolConfig = {
	name: "bash",
	label: "bash",
	shellName: "bash",
	prompt: "$",
	promptSnippet: bashToolSystemPromptContribution.snippet,
	promptGuidelines: bashToolSystemPromptContribution.guidelines,
	tempFilePrefix: "pi-bash",
};

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	return createShellToolDefinition(cwd, bashToolConfig, options);
}

export function createBashTool(cwd: string, options?: BashToolOptions): TypeBoxAgentTool<typeof bashSchema> {
	const definition = createBashToolDefinition(cwd, options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}
