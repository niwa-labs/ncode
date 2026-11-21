/**
 * pi coding-agent conversion tags — the custom message roles of the pinned
 * tree's `core/messages.ts` (pin 48c8f32), ported byte-exact as the single
 * owner of these templates in our tree (port-plan §4: the
 * convert-to-llm/outbound-normalizer row «сливается»; the vendored pin copy
 * remains the oracle in the parity tests only).
 *
 * V-C10 (plan §9.1): "Pi custom/bashExecution/!!/summary tags + наши
 * omit/merge/reminder/video/image/orphan rules". The tag TEXTS below are
 * pi-exact; how the records ride in our pipeline (reminder splitting, batch
 * joins, cache keys) stays our per-entry stage's own rules.
 */

/** pi `COMPACTION_SUMMARY_PREFIX` (coding-agent core/messages.ts:11). */
export const COMPACTION_SUMMARY_PREFIX =
	'The conversation history before this point was compacted into the following summary:\n\n<summary>\n';

/** pi `COMPACTION_SUMMARY_SUFFIX` (coding-agent core/messages.ts:16). */
export const COMPACTION_SUMMARY_SUFFIX = '\n</summary>';

/** pi `BRANCH_SUMMARY_PREFIX` (coding-agent core/messages.ts:19). */
export const BRANCH_SUMMARY_PREFIX =
	'The following is a summary of a branch that this conversation came back from:\n\n<summary>\n';

/** pi `BRANCH_SUMMARY_SUFFIX` (coding-agent core/messages.ts:24). */
export const BRANCH_SUMMARY_SUFFIX = '</summary>';

/** A bash-execution message as stored in the log — pi `BashExecutionMessage` (core/messages.ts:29). */
export interface BashExecutionFields {
	readonly command: string;
	readonly output: string;
	readonly exitCode: number | undefined;
	readonly cancelled: boolean;
	readonly truncated: boolean;
	readonly fullOutputPath?: string;
	/** The `!!` prefix: excluded from LLM context (pi `excludeFromContext`). */
	readonly excludeFromContext?: boolean;
}

/** A custom (extension-injected) message — pi `CustomMessage` (core/messages.ts:46). */
export interface CustomMessageFields {
	readonly customType: string;
	/** String or content blocks; a string is a single text block (pi convertToLlm). */
	readonly content: string | readonly unknown[];
	readonly display: boolean;
}

/** Branch-summary fields — pi `BranchSummaryMessage` (core/messages.ts:55). */
export interface BranchSummaryFields {
	readonly summary: string;
}

/** Compaction-summary fields — pi `CompactionSummaryMessage` (core/messages.ts:62). */
export interface CompactionSummaryFields {
	readonly summary: string;
	readonly tokensBefore: number;
}

/**
 * Renders one bash execution as its user-message text — pi
 * `bashExecutionToText` (core/messages.ts:82) byte-exact: output fence,
 * `(no output)`, cancelled / non-zero exit notes, truncation pointer.
 */
export function bashExecutionToText(fields: BashExecutionFields): string {
	let text = `Ran \`${fields.command}\`\n`;
	if (fields.output) {
		text += `\`\`\`\n${fields.output}\n\`\`\``;
	} else {
		text += '(no output)';
	}
	if (fields.cancelled) {
		text += '\n\n(command cancelled)';
	} else if (fields.exitCode !== null && fields.exitCode !== undefined && fields.exitCode !== 0) {
		text += `\n\nCommand exited with code ${fields.exitCode}`;
	}
	if (fields.truncated && fields.fullOutputPath) {
		text += `\n\n[Output truncated. Full output: ${fields.fullOutputPath}]`;
	}
	return text;
}

/** Branch-summary user text: pi prefix + summary + suffix (pi convertToLlm, core/messages.ts:170). */
export function branchSummaryText(fields: BranchSummaryFields): string {
	return BRANCH_SUMMARY_PREFIX + fields.summary + BRANCH_SUMMARY_SUFFIX;
}

/** Compaction-summary user text: pi prefix + summary + suffix (pi convertToLlm, core/messages.ts:176). */
export function compactionSummaryText(fields: CompactionSummaryFields): string {
	return COMPACTION_SUMMARY_PREFIX + fields.summary + COMPACTION_SUMMARY_SUFFIX;
}
