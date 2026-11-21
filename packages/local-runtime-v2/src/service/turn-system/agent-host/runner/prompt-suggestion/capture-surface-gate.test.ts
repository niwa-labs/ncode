import { describe, expect, it, vi } from 'vitest';

import { createTurnPromptSuggestionCapture } from './capture.js';

/**
 * OUR surface gate on top of the upstream capture (the upstream
 * `promptSuggestionSurface` cannot distinguish clients on a shared daemon
 * runtime): only a TURN carrying the interactive marker from its TUI sender
 * (`provenance.sourceContext.surface === 'interactive'`) collects context.
 * ACP/exec/queue turns never carry it, so headless clients pay zero extra
 * model requests even when the feature is enabled for the daemon.
 */
function baseInput(sourceContext?: Record<string, unknown>) {
  return {
    session: {},
    lease: { sessionId: 's1', turnId: 't1', signal: new AbortController().signal },
    request: {
      provenance: {
        source: 'api',
        routingFingerprint: 'fp',
        ...(sourceContext ? { sourceContext } : {}),
      },
      genuineUserQueryText: 'fix the failing test',
    },
    assemblyContext: {},
    preparation: { agentConfig: {}, llm: {} },
  };
}

function prepared() {
  return { llm: {}, caller: 'chat' } as never;
}

function port(enabled = true) {
  return { enabled: () => enabled, turnStarted: vi.fn(), committed: vi.fn() } as never;
}

const options = (p: unknown) => p as never;

describe('prompt suggestion capture — interactive surface gate', () => {
  it('captures for a TUI turn carrying the interactive marker', () => {
    const result = createTurnPromptSuggestionCapture(
      baseInput({ surface: 'interactive' }) as never,
      prepared(),
      options({ promptSuggestion: port() }),
    );
    expect(result?.capture.read).toBeTypeOf('function');
  });

  it('captures nothing for a headless turn without the marker', () => {
    const result = createTurnPromptSuggestionCapture(
      baseInput() as never,
      prepared(),
      options({ promptSuggestion: port() }),
    );
    expect(result).toBeUndefined();
  });

  it('captures nothing for a turn with an unrelated source context', () => {
    const result = createTurnPromptSuggestionCapture(
      baseInput({ executionDiagnostics: true }) as never,
      prepared(),
      options({ promptSuggestion: port() }),
    );
    expect(result).toBeUndefined();
  });

  it('captures nothing when the port is absent or disabled', () => {
    expect(
      createTurnPromptSuggestionCapture(
        baseInput({ surface: 'interactive' }) as never,
        prepared(),
        options({}),
      ),
    ).toBeUndefined();
    expect(
      createTurnPromptSuggestionCapture(
        baseInput({ surface: 'interactive' }) as never,
        prepared(),
        options({ promptSuggestion: port(false) }),
      ),
    ).toBeUndefined();
  });
});
