// W06 (PORT-PI-1.3, patch registry PR-03 №12/№37 — adapt): the default /
// adaptive-thinking model family is classified by the pinned pi-ai catalog's
// own metadata instead of the 0.79-era hardcoded `DEFAULT_THINKING_MODEL_IDS`
// list (temporarily carried by `default-thinking-models.ts` since W02 round 2;
// that copy is deleted with this module's introduction).
//
// A model id belongs to the family iff the pin's builtin anthropic catalog
// entry carries `compat.forceAdaptiveThinking === true` — the same metadata
// the pin's native anthropic-messages path branches on
// (`api/anthropic-messages.ts` streamSimple/`stream`: effort-based adaptive
// thinking instead of budget-based). This keeps the family matcher
// data-driven: catalog additions (e.g. `claude-opus-5-5`, `claude-haiku-5-5`)
// are picked up without a product-side list, and models absent from the pin
// catalog (e.g. the removed `claude-mythos-*` ids) follow the generic
// adaptive path rather than a stale exception.
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all';

const FAMILY_CATALOG_PROVIDER = 'anthropic';

let adaptiveDefaultThinkingIds: ReadonlySet<string> | undefined;

/** Catalog ids of the anthropic models whose default protocol turns thinking on. */
function adaptiveDefaultThinkingIdSet(): ReadonlySet<string> {
  return (adaptiveDefaultThinkingIds ??= new Set(
    getBuiltinModels(FAMILY_CATALOG_PROVIDER)
      .filter((model) => model.compat?.forceAdaptiveThinking === true)
      .map((model) => model.id.trim().toLowerCase()),
  ));
}

/**
 * True when the model id names a Claude default-thinking family member
 * according to the pinned catalog metadata (`compat.forceAdaptiveThinking`).
 *
 * BYOK owns the model's context configuration, so only the exact trailing
 * `[1m]` decoration is ignored for classification; the wire model id is
 * preserved by callers.
 */
export function isAdaptiveDefaultThinkingModelId(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const baseId = value.trim().toLowerCase().replace(/\[1m\]$/u, '');
  if (!baseId) return false;
  return adaptiveDefaultThinkingIdSet().has(baseId);
}
