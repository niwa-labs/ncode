import type { TuiPendingPermission } from '../../runtime/port.js';
import { sanitizeTerminalText } from '../rendering/terminal-text.js';

export function formatPermissionRequest(request: TuiPendingPermission): string {
  const summary = request.reason ?? request.toolDescription ?? request.toolInput;
  return summary ? sanitizeTerminalText(summary).trim() : 'Review this tool action.';
}

export function formatPermissionResolution(
  request: TuiPendingPermission,
  decision: 'allowOnce' | 'allowAlways' | 'deny' | 'denyAlways',
): string {
  const tool = sanitizeTerminalText(request.toolName ?? 'unknown');
  if (decision === 'allowAlways') return `Saved permission rule · ${tool}`;
  if (decision === 'denyAlways') return `Saved deny rule · ${tool}`;
  if (decision === 'deny') return `Denied · ${tool}`;
  return `Allowed once · ${tool}`;
}
