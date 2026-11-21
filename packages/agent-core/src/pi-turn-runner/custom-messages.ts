/**
 * Host-owned custom agent message (W04).
 *
 * The pin's `@earendil-works/pi-agent-core` carries custom messages through the
 * `CustomAgentMessages` declaration-merging interface (0.79 exported a concrete
 * `CustomMessage` from its harness; that harness is gone at the pin). This module
 * restores the host shape — `{ role: "custom", customType, content, display,
 * details?, timestamp }`, byte-compatible with the 0.79
 * `harness/messages.ts:31` contract and with the product's canonical-history
 * validator (`local-runtime-v2 .../canonical-history-validation.ts`) — and
 * merges it into the pin's `AgentMessage` union so appends stay fully typed.
 */

import type { ImageContent, TextContent } from '@earendil-works/pi-ai';

/** Host custom message: hidden host markers and durable context annotations. */
export interface McodeCustomMessage<T = unknown> {
  role: 'custom';
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  details?: T;
  timestamp: number;
}

declare module '@earendil-works/pi-agent-core' {
  interface CustomAgentMessages {
    mcodeCustom: McodeCustomMessage;
  }
}

/** Guard for the host custom message shape (never trusts the wire). */
export function isMcodeCustomMessage(message: unknown): message is McodeCustomMessage {
  if (typeof message !== 'object' || message === null) return false;
  const candidate = message as Partial<McodeCustomMessage>;
  return (
    candidate.role === 'custom' &&
    typeof candidate.customType === 'string' &&
    candidate.customType.length > 0 &&
    typeof candidate.display === 'boolean' &&
    (typeof candidate.content === 'string' || Array.isArray(candidate.content)) &&
    typeof candidate.timestamp === 'number'
  );
}
