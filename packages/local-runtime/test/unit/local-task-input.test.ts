import { describe, expect, it } from 'vitest';

import { normalizeLocalTaskInput, taskModelSelectionFor } from '../../src/api/local-task-input.js';
import type { LocalTaskToolInput } from '@mavis/agent-tools/desktop';

const baseInput: LocalTaskToolInput = {
  description: 'Child session title',
  prompt: 'Self-contained child prompt.',
  agent_name: 'worker',
};

describe('local task input model override', () => {
  it('splits a provider/model#variant key on the last # into model and variant', () => {
    const normalized = normalizeLocalTaskInput({
      ...baseInput,
      model: 'minimax/MiniMax-M3.1-Flash#thinking',
    });
    expect(normalized.model).toBe('minimax/MiniMax-M3.1-Flash#thinking');
    expect(taskModelSelectionFor(normalized)).toEqual({
      model: 'minimax/MiniMax-M3.1-Flash',
      variant: 'thinking',
    });
  });

  it('rejects a variant key with an empty variant', () => {
    expect(() => normalizeLocalTaskInput({ ...baseInput, model: 'minimax/MiniMax-M3.1-Flash#' }))
      .toThrow('Task model must be provider/model or provider/model#variant.');
    expect(() => normalizeLocalTaskInput({ ...baseInput, model: '#thinking' })).toThrow(
      'Task model must be provider/model or provider/model#variant.',
    );
    expect(() => normalizeLocalTaskInput({ ...baseInput, model: 'minimax/#thinking' })).toThrow(
      'Task model must be provider/model or provider/model#variant.',
    );
  });

  it('keeps a plain provider/model override unchanged', () => {
    const normalized = normalizeLocalTaskInput({
      ...baseInput,
      model: 'minimax/MiniMax-M3.1-Flash',
      effort: 'max',
    });
    expect(normalized.model).toBe('minimax/MiniMax-M3.1-Flash');
    expect(taskModelSelectionFor(normalized)).toEqual({
      model: 'minimax/MiniMax-M3.1-Flash',
      effort: 'max',
    });
    expect(taskModelSelectionFor(normalizeLocalTaskInput({ ...baseInput }))).toBeUndefined();
  });
});
