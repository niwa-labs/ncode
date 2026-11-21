/**
 * The `/session` warmer-status render (W10 part B): the usage inspection
 * surfaces the prompt-cache warming status of the session — the
 * `formatCacheWarmingStatus` consumption the plan pins — in both the
 * visualization panel and the text form, and renders nothing when the
 * runtime keeps no warmer state.
 */

import { describe, expect, it } from 'vitest';

import type { TranscriptUsageVisualization } from '../../../../src/tui/transcript/model.js';
import { UsageVisualization } from '../../../../src/tui/transcript/usage-visualization.js';

function visualization(cacheWarming?: string): TranscriptUsageVisualization {
  return {
    kind: 'usage',
    model: 'minimax/MiniMax-M3.1-Flash',
    sessionRecorded: true,
    inputTokens: 1_200,
    outputTokens: 340,
    totalTokens: 1_540,
    context: null,
    ...(cacheWarming !== undefined ? { cacheWarming } : {}),
  };
}

describe('UsageVisualization /session warmer status', () => {
  it('renders the warming status section when the runtime reports one', () => {
    const lines = new UsageVisualization(visualization('scheduled (next refresh in 30s)'))
      .render(100)
      .map((line) => line.replace(/\u001b\[[0-9;]*m/gu, ''));
    const joined = lines.join('\n');
    expect(joined).toContain('Cache warming');
    expect(joined).toContain('scheduled (next refresh in 30s)');
  });

  it('renders nothing warming-specific without a status', () => {
    const lines = new UsageVisualization(visualization(undefined))
      .render(100)
      .map((line) => line.replace(/\u001b\[[0-9;]*m/gu, ''));
    expect(lines.join('\n')).not.toContain('Cache warming');
  });
});
