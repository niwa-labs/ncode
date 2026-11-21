/**
 * Conversation serialization and summarizer prompts.
 *
 * Ported behaviors from pi v1.3: tool results are truncated to 2000
 * characters (the summary does not need full payloads), thinking blocks are
 * excluded entirely (visible text, tool calls, and tool results record what
 * happened), and the conversation is flattened to text inside
 * `<conversation>` tags so the model summarizes instead of continuing.
 *
 * @module
 */

import type { CompactionMessage, ToolCallBlock } from './types.js';

/** Maximum characters of one tool result in the serialized conversation. */
export const TOOL_RESULT_MAX_CHARS = 2000;

/** Truncate long text keeping the head, with an explicit marker of the loss. */
function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const truncatedChars = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

function textOf(
	content: string | readonly { type: string; text?: string }[] | undefined,
	separator = '',
): string {
	if (content === undefined) return '';
	if (typeof content === 'string') return content;
	return content
		.filter((block) => block.type === 'text')
		.map((block) => block.text ?? '')
		.join(separator);
}

/**
 * One OFFLOADED image block of a message content list (wave 2, canon 05
 * §2.5): the durable log stores the artifact reference instead of base64, and
 * this is the block shape that reaches the projection. Only the fields the
 * stub rendering needs are read; anything else is ignored.
 */
export interface ImageArtifactStubFields {
	readonly type: string;
	readonly artifact?: unknown;
	readonly mimeType?: unknown;
	readonly bytes?: unknown;
}

/**
 * The read-again stub of an offloaded image (pi codemode `execute.ts` shape):
 * `[Image saved to /…/artifacts/ab12….png (image/png, 1.0 MB) — use read to
 * view again]`. Shared by the summarizer serialization (the summary can
 * reference the path) and by the wire rendering of an evicted image.
 */
export function imageArtifactPlaceholder(ref: {
	readonly artifact: string;
	readonly mimeType: string;
	readonly bytes?: number;
}): string {
	return `[Image saved to ${ref.artifact} (${ref.mimeType}, ${formatImageBytes(ref.bytes)}) — use read to view again]`;
}

/** Human-readable byte size for the stub (`1.0 MB`, `640 KB`, `512 bytes`). */
function formatImageBytes(bytes: number | undefined): string {
	if (!Number.isFinite(bytes) || bytes === undefined || bytes <= 0) return 'unknown size';
	if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
	if (bytes >= 1_024) return `${Math.round(bytes / 1_024)} KB`;
	return `${bytes} bytes`;
}

/** Image stub lines of one message's content blocks, in block order. */
function imageStubLines(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const lines: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== 'object') continue;
		const candidate = block as ImageArtifactStubFields;
		if (candidate.type !== 'image' || typeof candidate.artifact !== 'string' || !candidate.artifact) {
			continue;
		}
		lines.push(
			imageArtifactPlaceholder({
				artifact: candidate.artifact,
				mimeType: typeof candidate.mimeType === 'string' && candidate.mimeType ? candidate.mimeType : 'application/octet-stream',
				bytes: typeof candidate.bytes === 'number' ? candidate.bytes : undefined,
			}),
		);
	}
	return lines;
}

function formatToolCall(block: ToolCallBlock): string {
  const args = block.arguments && typeof block.arguments === 'object' ? (block.arguments as Record<string, unknown>) : {};
  const argsStr = Object.entries(args)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(', ');
  return `${block.name}(${argsStr})`;
}

/**
 * Serialize messages to plain text for the summarizer.
 *
 * - user text -> `[User]: ...`
 * - assistant text -> `[Assistant]: ...`, tool calls -> `[Assistant tool calls]: name(...)`
 * - tool results -> `[Tool result]: ...` truncated to {@link TOOL_RESULT_MAX_CHARS}
 * - offloaded images -> the read-again stub naming the artifact path (wave 2,
 *   canon 05 §2.5: the summary can reference the path; base64 never reaches
 *   the summarizer)
 * - thinking blocks are omitted everywhere
 * - empty messages contribute nothing
 */
export function serializeConversation(messages: readonly CompactionMessage[]): string {
	const parts: string[] = [];

	for (const message of messages) {
		switch (message.role) {
			case 'user': {
				const text = textOf(message.content);
				if (text) parts.push(`[User]: ${text}`);
				for (const line of imageStubLines(message.content)) parts.push(`[User image]: ${line}`);
				break;
			}
			case 'assistant': {
				// pi's serializeConversation renders assistant text with
				// `contentText(content)` — the DEFAULT "\n" separator — while user and
				// tool results use `contentText(content, "")`. Two text blocks of one
				// assistant message are two paragraphs, not one glued string.
				const text = textOf(message.content, '\n');
				if (text) parts.push(`[Assistant]: ${text}`);
				const toolCalls = message.content.filter((block): block is ToolCallBlock => block.type === 'toolCall');
				if (toolCalls.length > 0) {
					parts.push(`[Assistant tool calls]: ${toolCalls.map(formatToolCall).join('; ')}`);
				}
				break;
			}
			case 'toolResult': {
				const text = textOf(message.content);
				if (text) parts.push(`[Tool result]: ${truncateForSummary(text, TOOL_RESULT_MAX_CHARS)}`);
				for (const line of imageStubLines(message.content)) parts.push(`[Tool result image]: ${line}`);
				break;
			}
			case 'custom': {
				if (message.text) parts.push(`[${message.customType}]: ${message.text}`);
				break;
			}
		}
	}

	return parts.join('\n\n');
}

// ============================================================================
// Prompts
// ============================================================================

/** Role instruction prepended to every summarizer prompt. */
export const SUMMARIZATION_SYSTEM_PROMPT =
  'You are a context summarization assistant. Read the conversation between a user and an AI assistant ' +
  'and produce a structured summary following the exact format specified. Do NOT continue the conversation. ' +
  'Do NOT answer questions from the conversation. ONLY output the structured summary.';

/** Structured checkpoint format of the history summary. */
export const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? One item per task the session covers.]

## Constraints & Preferences
- [Constraints, preferences, or requirements mentioned by the user, or "(none)"]

## Progress
### Done
- [x] [Completed work]

### In Progress
- [ ] [Current work]

### Blocked
- [Blockers, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered next actions]

## Critical Context
- [Data, file paths, names, and error messages needed to continue, or "(none)"]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** Update rules when a previous summary already exists (iterative compaction). */
export const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to merge into the existing summary in <previous-summary>.

RULES:
- PRESERVE all still-relevant information from the previous summary.
- ADD new progress, decisions, and context from the new messages.
- MOVE completed items from "In Progress" to "Done"; refresh "Next Steps".
- PRESERVE exact file paths, function names, and error messages.
- Drop anything that is no longer relevant.

Use the same EXACT format as the previous summary (Goal / Constraints & Preferences / Progress / Key Decisions / Next Steps / Critical Context). Keep each section concise.`;

/** Prompt for the prefix of a turn the cut had to split. */
export const TURN_PREFIX_SUMMARIZATION_PROMPT = `The messages above are the earlier part of ONE user turn. The later part of the turn is kept separately and must NOT be reconstructed.

Create a concise checkpoint of the request and of the progress visible above. It will be placed before the later messages so the conversation can continue seamlessly.

## Original Request
[What did the user ask for?]

## Progress So Far
- [Key decisions and work completed in these messages]

## Context Needed to Continue
- [Information from these messages needed to understand the later work]

Only summarize information explicitly present above. Do not infer later messages.`;

/** Build the full history-summary prompt around the serialized conversation. */
export function buildSummaryPrompt(
  conversationText: string,
  previousSummary?: string,
  customInstructions?: string,
): string {
  let base = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  if (customInstructions) base = `${base}\n\nAdditional focus: ${customInstructions}`;

  let prompt = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (previousSummary) prompt += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  return prompt + base;
}

/** Build the turn-prefix summary prompt for a split turn. */
export function buildTurnPrefixPrompt(conversationText: string, customInstructions?: string): string {
  const focus = customInstructions ? `\n\nAdditional focus: ${customInstructions}` : '';
  return `<conversation>\n${conversationText}\n</conversation>\n\n# Instructions\n${TURN_PREFIX_SUMMARIZATION_PROMPT}${focus}`;
}

/** The glue of a split-turn summary: history first, then the turn context. */
export const SPLIT_TURN_SEPARATOR = '\n\n---\n\n**Turn Context (split turn):**\n\n';

/** Merge the history summary and the turn-prefix summary of a split turn. */
export function mergeSplitTurnSummary(historySummary: string, turnPrefixSummary: string): string {
  // A summarizer that returned an empty string must not leave a dangling
  // separator at the end of the merged summary: a delimiter with no content
  // behind it reads as a corrupt checkpoint, not as an empty turn context.
  if (turnPrefixSummary.length === 0) return historySummary;
  return `${historySummary}${SPLIT_TURN_SEPARATOR}${turnPrefixSummary}`;
}

/** Fallback history text when a split turn has nothing before it to summarize. */
export const NO_PRIOR_HISTORY_TEXT = 'No prior history.';

/** Wrap system instructions + task into the single prompt string the Summarizer receives. */
export function withSystemInstructions(prompt: string): string {
  return `${SUMMARIZATION_SYSTEM_PROMPT}\n\n${prompt}`;
}
