import type * as acp from '@agentclientprotocol/sdk';

import {
  buildTuiMessageParts,
  type TuiStreamEvent,
  type TuiToolCall,
} from '../runtime/stream-events.js';
import type { TuiStructuredPreviewBlock } from '../types/runtime-models.js';
import { isTuiAcpAbsolutePath } from './paths.js';

export class TuiAcpUpdateProjector {
  private readonly toolIds = new Map<string, string>();
  private readonly completedToolIds = new Set<string>();
  private readonly streamedMessageIds = new Set<string>();
  private nextAnonymousToolId = 1;

  project(event: TuiStreamEvent): acp.SessionUpdate[] {
    if (event.type === 'message') return this.projectMessage(event.message);
    if (event.type === 'messages-replaced') {
      return event.messages.flatMap((message) => this.projectMessage(message));
    }
    if (event.type !== 'delta') return [];
    const updates: acp.SessionUpdate[] = [];
    if (event.messageId && (event.thinking || event.content)) {
      this.streamedMessageIds.add(event.messageId);
    }
    if (event.thinking) {
      updates.push({
        sessionUpdate: 'agent_thought_chunk',
        ...(event.messageId ? { messageId: event.messageId } : {}),
        content: { type: 'text', text: event.thinking },
      });
    }
    if (event.content) {
      updates.push({
        sessionUpdate: 'agent_message_chunk',
        ...(event.messageId ? { messageId: event.messageId } : {}),
        content: { type: 'text', text: event.content },
      });
    }
    for (const tool of event.toolCalls ?? []) {
      const update = this.projectTool(tool);
      if (update) updates.push(update);
    }
    return updates;
  }

  private projectMessage(
    message: Extract<TuiStreamEvent, { type: 'message' }>['message'],
  ): acp.SessionUpdate[] {
    if (message.role !== 'assistant') return [];
    if (message.id && this.streamedMessageIds.has(message.id)) return [];
    if (message.id) this.streamedMessageIds.add(message.id);
    return buildTuiMessageParts(message).flatMap((part): acp.SessionUpdate[] => {
      if (part.type === 'thinking') {
        return [
          {
            sessionUpdate: 'agent_thought_chunk',
            ...(message.id ? { messageId: message.id } : {}),
            content: { type: 'text', text: part.content },
          },
        ];
      }
      if (part.type === 'text') {
        return [
          {
            sessionUpdate: 'agent_message_chunk',
            ...(message.id ? { messageId: message.id } : {}),
            content: { type: 'text', text: part.content },
          },
        ];
      }
      const update = this.projectTool(part.toolCall);
      return update ? [update] : [];
    });
  }

  private projectTool(tool: TuiToolCall): acp.SessionUpdate | undefined {
    if (tool.id && this.completedToolIds.has(tool.id)) return undefined;
    // A streaming delta arrives BEFORE the tool's arguments are assembled: it
    // carries the id but no input, so emitting it would register the call
    // bare on the wire and the context would ride a later tool_call_update
    // that ring-style UIs never read (incident 2026-11-15: kagero's run ring
    // showed `bash` with no command for the whole live run). Wait for the
    // execution start/end emissions, which always carry the assembled input;
    // terminal outcomes without input still surface (they cannot be superseded).
    if (
      tool.input === undefined &&
      tool.id !== undefined &&
      tool.status !== 'completed' &&
      tool.status !== 'failed'
    ) {
      return undefined;
    }
    const key = tool.id ? `id:${tool.id}` : `name:${tool.name}`;
    const existingId = this.toolIds.get(key);
    const toolCallId = existingId ?? tool.id ?? `minimax-code-tool-${this.nextAnonymousToolId++}`;
    const status = toolStatus(tool.status);
    const content = toolContent(tool);
    const locations = toolLocations(tool);
    const rawOutput = tool.output ?? (tool.error === undefined ? undefined : { error: tool.error });
    const meta = toolMeta(tool);

    if (!existingId) {
      if (status === 'completed' || status === 'failed') {
        if (tool.id) this.completedToolIds.add(tool.id);
      } else {
        this.toolIds.set(key, toolCallId);
      }
      return compact({
        sessionUpdate: 'tool_call' as const,
        toolCallId,
        title: tool.name,
        name: tool.name,
        kind: tuiAcpToolKind(tool.name),
        status,
        rawInput: tool.input,
        rawOutput,
        content,
        locations,
        ...(meta.size > 0 ? { _meta: Object.fromEntries(meta) } : {}),
      });
    }

    if (status === 'completed' || status === 'failed') {
      this.toolIds.delete(key);
      if (tool.id) this.completedToolIds.add(tool.id);
    }
    return compact({
      sessionUpdate: 'tool_call_update' as const,
      toolCallId,
      status,
      rawInput: tool.input,
      rawOutput,
      content,
      locations,
      ...(meta.size > 0 ? { _meta: Object.fromEntries(meta) } : {}),
    });
  }
}

/**
 * §4 `decidedBy`: the permission mark rides the `_meta` of `tool_call` and
 * of every `tool_call_update` that carries it (in_progress and the final
 * completed/failed). No new session/update messages are introduced.
 */
function toolMeta(tool: TuiToolCall): Map<string, unknown> {
  const meta = new Map<string, unknown>();
  if (tool.parentToolCallId !== undefined) {
    meta.set('minimax-code/parentToolCallId', tool.parentToolCallId);
  }
  if (tool.permission !== undefined) {
    meta.set('minimax-code/permission', tool.permission);
  }
  return meta;
}

export function tuiAcpToolKind(name: string): acp.ToolKind {
  const normalized = name.toLowerCase();
  if (normalized.includes('read') || normalized.includes('view')) return 'read';
  if (normalized.includes('edit') || normalized.includes('write') || normalized.includes('patch')) {
    return 'edit';
  }
  if (normalized.includes('delete') || normalized.includes('remove')) return 'delete';
  if (normalized.includes('move') || normalized.includes('rename')) return 'move';
  if (normalized.includes('search') || normalized.includes('find') || normalized.includes('grep')) {
    return 'search';
  }
  if (normalized.includes('fetch') || normalized.includes('http') || normalized.includes('web')) {
    return 'fetch';
  }
  if (normalized.includes('think') || normalized.includes('plan')) return 'think';
  if (
    normalized.includes('shell') ||
    normalized.includes('bash') ||
    normalized.includes('terminal') ||
    normalized.includes('exec') ||
    normalized.includes('command')
  ) {
    return 'execute';
  }
  return 'other';
}

function toolStatus(status: TuiToolCall['status']): acp.ToolCallStatus | undefined {
  if (status === undefined) return undefined;
  const normalized = String(status).toLowerCase();
  if (normalized === 'pending') return 'pending';
  if (
    normalized === '1' ||
    normalized === 'started' ||
    normalized === 'running' ||
    normalized === 'in_progress'
  ) {
    return 'in_progress';
  }
  if (
    normalized === '2' ||
    normalized === 'completed' ||
    normalized === 'succeeded' ||
    normalized === 'success'
  ) {
    return 'completed';
  }
  if (normalized === '3' || normalized === 'failed' || normalized === 'error') return 'failed';
  return undefined;
}

function toolContent(tool: TuiToolCall): acp.ToolCallContent[] | undefined {
  const blocks = tool.structuredPreview?.blocks.flatMap(projectPreviewBlock) ?? [];
  return blocks.length > 0 ? blocks : undefined;
}

function projectPreviewBlock(block: TuiStructuredPreviewBlock): acp.ToolCallContent[] {
  if (block.kind === 'diff' && block.path) {
    const texts = parseUnifiedDiff(block.diff);
    return [
      compact({
        type: 'diff' as const,
        path: block.path,
        oldText: texts.oldText,
        newText: texts.newText,
      }),
    ];
  }
  if (block.kind === 'file') {
    return [
      {
        type: 'content',
        content: { type: 'text', text: block.content },
      },
    ];
  }
  if (block.kind === 'summary') {
    return [
      {
        type: 'content',
        content: { type: 'text', text: block.message },
      },
    ];
  }
  return [];
}

function toolLocations(tool: TuiToolCall): acp.ToolCallLocation[] | undefined {
  const paths = new Set<string>();
  for (const block of tool.structuredPreview?.blocks ?? []) {
    if (block.path && isTuiAcpAbsolutePath(block.path)) paths.add(block.path);
  }
  for (const inputPath of readInputPaths(tool.input)) {
    if (isTuiAcpAbsolutePath(inputPath)) paths.add(inputPath);
  }
  return paths.size > 0 ? [...paths].map((path) => ({ path })) : undefined;
}

function readInputPaths(input: unknown): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  const record = input as Record<string, unknown>;
  return ['path', 'filePath', 'file_path'].flatMap((key) =>
    typeof record[key] === 'string' ? [record[key]] : [],
  );
}

function parseUnifiedDiff(diff: string): { oldText?: string; newText: string } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@') || line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    if (line.startsWith('-')) oldLines.push(line.slice(1));
    else if (line.startsWith('+')) newLines.push(line.slice(1));
    else {
      const content = line.startsWith(' ') ? line.slice(1) : line;
      oldLines.push(content);
      newLines.push(content);
    }
  }
  return {
    ...(oldLines.length > 0 ? { oldText: oldLines.join('\n') } : {}),
    newText: newLines.join('\n'),
  };
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
