import {
  hasConversationTaskModelSelection,
  normalizeConversationSessionTitle,
  type ConversationTaskModelSelection,
} from '@mavis/conversation-contract';
import type { LocalTaskToolInput } from '@mavis/agent-tools/desktop';

/** Shared Task boundary for foreground and background child creation. */
export function normalizeLocalTaskInput(input: LocalTaskToolInput): LocalTaskToolInput {
  if (Object.hasOwn(input, 'model_config_id')) {
    throw new Error('Task model_config_id is not supported. Use model and effort.');
  }
  const description = normalizeConversationSessionTitle(input.description);
  if (!description) {
    throw new Error('Task description must contain 1-50 Unicode characters after normalization.');
  }
  const model = normalizeTaskModel(input.model);
  const effort = normalizeTaskOverride(input.effort, 'effort');
  return {
    ...input,
    description,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

export function taskModelSelectionFor(
  input: Pick<LocalTaskToolInput, 'model' | 'effort'>,
): ConversationTaskModelSelection | undefined {
  const model = splitTaskModelKey(input.model);
  const selection: ConversationTaskModelSelection = {
    ...(model.model ? { model: model.model } : {}),
    ...(model.variant ? { variant: model.variant } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
  };
  return hasConversationTaskModelSelection(selection) ? selection : undefined;
}

function normalizeTaskModel(value: string | undefined): string | undefined {
  const normalized = normalizeTaskOverride(value, 'model');
  if (normalized === undefined) return undefined;
  splitTaskModelKey(normalized);
  return normalized;
}

/**
 * Splits a Task model override on the LAST `#` so the variant travels as its
 * own field instead of polluting the modelId: `minimax/MiniMax-M3#thinking` →
 * `{model: 'minimax/MiniMax-M3', variant: 'thinking'}`. Both parts around a
 * present `#` must be non-empty provider/model / variant keys.
 */
function splitTaskModelKey(
  value: string | undefined,
): { readonly model: string; readonly variant?: string } {
  if (value === undefined) return { model: '' };
  const hash = value.lastIndexOf('#');
  if (hash < 0) return { model: value };
  const model = value.slice(0, hash);
  const variant = value.slice(hash + 1);
  const slash = model.indexOf('/');
  if (!variant || slash <= 0 || slash === model.length - 1) {
    throw new Error('Task model must be provider/model or provider/model#variant.');
  }
  return { model, variant };
}

function normalizeTaskOverride(
  value: string | undefined,
  field: 'model' | 'effort',
): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) throw new Error(`Task ${field} must not be blank.`);
  return normalized;
}
