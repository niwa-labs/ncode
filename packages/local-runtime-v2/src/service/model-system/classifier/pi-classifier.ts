// W06 (PORT-PI-1.3, plan :759 Take "chat/image/classifier Models …
// JEV/Decisions/llama.cpp/images"; V-P01 "classifiers реально вызываемы через
// поддержанные adapters"): product adapter for the pinned pi-ai classifier
// surface. The pin owns the four classifier wire protocols
// (`typesafe-system-one`, `cloudflare-workers-ai-system-one`,
// `openai-decisions`, `llama-cpp-classify`) and the `Models` runtime that
// applies provider auth; this adapter is the product's single supported way
// to call them with host policy (fetch/headers/timeout/abort) — V-P06 keeps
// the host egress seams on classify paths too.
//
// Two model sources are supported, both through the pin's own `Models`
// collection so auth application and error normalization stay upstream:
//  - the builtin catalog (JEV via typesafe/opencode/openrouter/…, Decisions
//    via openai, clef via cloudflare-workers-ai), and
//  - a custom local llama.cpp endpoint registered as its own provider
//    (`llama-cpp-classify`; keyless local servers are the pin's documented
//    ambient-auth case).
import {
  createModels,
  createProvider,
  type ClassifierApi,
  type ClassifierContext,
  type ClassifierModel,
  type ClassifierOptions,
  type ClassifierResult,
  type MutableModels,
} from '@earendil-works/pi-ai';
import { llamaCppClassifyApi } from '@earendil-works/pi-ai/api/llama-cpp-classify.lazy';
import {
  builtinModels,
  getBuiltinClassifierModels,
  getBuiltinProviders,
  type BuiltinProvider as BuiltinProviderId,
} from '@earendil-works/pi-ai/providers/all';

/** Host-owned request policy applied to every classifier call. */
export interface PiClassifierHostPolicy {
  readonly apiKey?: string;
  readonly fetch?: ClassifierOptions['fetch'];
  readonly headers?: Record<string, string>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly maxRetries?: number;
}

export interface CustomLlamaClassifierEndpoint {
  /** Product-side provider id for the registered provider (e.g. a custom_provider id). */
  readonly providerId: string;
  readonly modelId: string;
  readonly baseUrl: string;
  /** Optional bearer key for endpoints that want one; llama-server runs keyless by default. */
  readonly apiKey?: string;
}

const CUSTOM_LLAMA_AUTH_NAME = 'llama.cpp classifier endpoint';

let sharedBuiltinModels: MutableModels | undefined;

/** The pin's builtin provider set (all 40+ providers, catalog data only). */
export function listBuiltinClassifierProviders(): readonly string[] {
  return getBuiltinProviders();
}

/** Catalog view of every builtin classifier model (JEV / Decisions / clef). */
export function listBuiltinClassifierModels(providerId?: string): readonly ClassifierModel<ClassifierApi>[] {
  return providerId === undefined
    ? getBuiltinProviders().flatMap((provider) => getBuiltinClassifierModels(provider))
    : getBuiltinClassifierModels(providerId as BuiltinProviderId);
}

export function getBuiltinClassifierModel(
  providerId: string,
  modelId: string,
): ClassifierModel<ClassifierApi> | undefined {
  return getBuiltinClassifierModels(providerId as BuiltinProviderId).find(
    (model) => model.id === modelId,
  );
}

function builtinClassifierModels(): MutableModels {
  return (sharedBuiltinModels ??= builtinModels());
}

/**
 * Classify through the pinned pi-ai runtime. `model` comes from the builtin
 * catalog (`getBuiltinClassifierModel`) or from a registered custom endpoint
 * (`registerCustomLlamaClassifierEndpoint`). Never throws for provider
 * failures: the pin normalizes them into `ClassifierResult.stopReason`
 * "error"/"aborted" with `errorMessage`, like chat streams.
 */
export function classifyWithPiClassifier(
  model: ClassifierModel<ClassifierApi>,
  context: ClassifierContext,
  host: PiClassifierHostPolicy = {},
): Promise<ClassifierResult> {
  return builtinClassifierModels().classify(model, context, {
    ...(host.apiKey ? { apiKey: host.apiKey } : {}),
    ...(host.fetch ? { fetch: host.fetch } : {}),
    ...(host.headers ? { headers: host.headers } : {}),
    ...(host.timeoutMs !== undefined ? { timeoutMs: host.timeoutMs } : {}),
    ...(host.signal ? { signal: host.signal } : {}),
    ...(host.maxRetries !== undefined ? { maxRetries: host.maxRetries } : {}),
  });
}

/**
 * Registers a local llama.cpp classifier endpoint on the shared builtin
 * collection and returns its model. The endpoint speaks the pin's
 * `llama-cpp-classify` protocol (next-token logprobs over llama-server); the
 * provider is ambient-auth because llama-server is a keyless local server
 * (the pin's documented case for `ProviderAuth`), so an explicit host
 * `apiKey` is still forwarded verbatim when the endpoint wants a bearer.
 */
export function registerCustomLlamaClassifierEndpoint(
  endpoint: CustomLlamaClassifierEndpoint,
): ClassifierModel<'llama-cpp-classify'> {
  const model: ClassifierModel<'llama-cpp-classify'> = {
    type: 'classifier',
    id: endpoint.modelId,
    name: endpoint.modelId,
    api: 'llama-cpp-classify',
    provider: endpoint.providerId,
    baseUrl: endpoint.baseUrl,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
  };
  const provider = createProvider({
    id: endpoint.providerId,
    name: endpoint.providerId,
    baseUrl: endpoint.baseUrl,
    auth: {
      apiKey: {
        name: CUSTOM_LLAMA_AUTH_NAME,
        resolve: async () => ({ auth: {} }),
      },
    },
    models: [model],
    classifiers: { 'llama-cpp-classify': llamaCppClassifyApi() },
  });
  builtinClassifierModels().setProvider(provider);
  return model;
}

/**
 * Private collection for callers that must not observe (or collide with) the
 * shared builtin registry — e.g. tests registering colliding provider ids.
 */
export function createIsolatedPiClassifierRuntime(): MutableModels {
  return createModels();
}
