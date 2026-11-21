import type { AgentExtension } from '@mavis/agent-runtime';
import {
  encodeRequestImageBlocks,
  type RequestImageEncoding,
} from '@mavis/context-manager';

export interface RequestMediaEncodingExtensionOptions {
  readonly id?: string;
  readonly description?: string;
  /** Read per tool result; the parsed `requestMedia` image limits when absent. */
  readonly getImageEncoding?: () => RequestImageEncoding | undefined;
}

/**
 * М1 (our seam, not their executor generation): keeps request media within
 * provider limits by re-encoding every tool-result image to the configured
 * per-image limits once, right after the tool ran. Oversized images shrink
 * (with the size note), undecodable ones become an explicit note, and images
 * that already fit pass through unchanged. The request-size RECOVERY half of
 * upstream's extension is М2, deliberately not here.
 */
export function createRequestMediaEncodingExtension(
  options: RequestMediaEncodingExtensionOptions = {},
): AgentExtension {
  return {
    id: options.id ?? 'request-media-encoding',
    description:
      options.description ??
      'Re-encode tool result images to the requestMedia limits after each tool call.',
    init(pi) {
      pi.on('after_tool_call', async (toolContext) => {
        const content = await encodeRequestImageBlocks(
          toolContext.result.content,
          options.getImageEncoding?.(),
        );
        return content ? { content } : undefined;
      });
    },
  };
}
