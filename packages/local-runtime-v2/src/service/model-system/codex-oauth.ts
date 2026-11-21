import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import {
  AuthStorage,
  readStoredCredential,
} from '@earendil-works/pi-coding-agent/auth-storage';
import {
  createModels,
  ModelsError,
  type AuthEvent,
  type AuthInteraction,
  type AuthPrompt,
  type CredentialStore,
  type MutableModels,
} from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';

import type {
  LocalByokConfigDraft,
  LocalCustomProviderConfig,
  LocalCustomProvidersConfig,
  LocalModelConfig,
  LocalRuntimeConfig,
} from './contracts.js';
import {
  CodexModelDiscoveryClient,
  type CodexModelCredentials,
} from './connectivity/codex-model-discovery.js';
import { OPENAI_CODEX_PROVIDER_ID } from './identity.js';

export { OPENAI_CODEX_PROVIDER_ID } from './identity.js';

export type CodexOAuthState = 'hidden' | 'disconnected' | 'pending' | 'connected' | 'failed';

export type CodexOAuthLoginMethod = 'browser' | 'device_code';

export interface CodexOAuthLoginOptions {
  method?: CodexOAuthLoginMethod;
}

export interface CodexOAuthDeviceCode {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
}

export interface CodexOAuthStatus {
  state: CodexOAuthState;
  providerId: typeof OPENAI_CODEX_PROVIDER_ID;
  error?: string;
  loginId?: string;
  method?: CodexOAuthLoginMethod;
  authUrl?: string;
  deviceCode?: CodexOAuthDeviceCode;
}

export type CodexOAuthStartResult = CodexOAuthStatus;

type LoginAttempt = {
  id: string;
  method: CodexOAuthLoginMethod;
  controller: AbortController;
  start: Promise<CodexOAuthStartResult>;
  resolve: (result: CodexOAuthStartResult) => void;
  reject: (error: Error) => void;
  result?: CodexOAuthStartResult;
  timeout?: ReturnType<typeof setTimeout>;
};

/**
 * Login interaction the manager builds for an attempt. The default storage
 * adapter maps this onto the pin's `AuthInteraction` (`notify`/`prompt`);
 * injected test storages keep receiving the same shape as before the W04
 * AuthStorage migration.
 */
export interface CodexLoginCallbacks {
  onAuth(info: { url: string }): void;
  onDeviceCode?(info: {
    userCode: string;
    verificationUri: string;
    intervalSeconds?: number;
    expiresInSeconds?: number;
  }): void;
  onPrompt?(prompt: { message: string }): Promise<string>;
  onSelect?(prompt: {
    message: string;
    options: readonly { id: string; label: string }[];
  }): Promise<string>;
  onManualCodeInput?(): Promise<string>;
  signal: AbortSignal;
  fetch?: typeof fetch;
}

interface CodexAuthStorage {
  getCredentials(): Promise<CodexModelCredentials | undefined>;
  hasOAuth(provider: typeof OPENAI_CODEX_PROVIDER_ID): boolean;
  removeOAuth(provider: typeof OPENAI_CODEX_PROVIDER_ID): void | Promise<void>;
  login(provider: typeof OPENAI_CODEX_PROVIDER_ID, callbacks: CodexLoginCallbacks): Promise<void>;
}

export interface CodexOAuthManagerDeps {
  configGetter: () => LocalRuntimeConfig;
  fetchImpl?: typeof fetch;
  updateByokConfig?: (
    mutate: (
      draft: LocalByokConfigDraft,
      currentConfig: LocalRuntimeConfig,
    ) => void | Promise<void>,
  ) => Promise<unknown>;
  removeLegacyProvider?: (providerId: typeof OPENAI_CODEX_PROVIDER_ID) => Promise<unknown>;
  authStorageFactory?: (authPath: string) => CodexAuthStorage;
  catalogGetter?: () => Promise<LocalCustomProviderConfig>;
}

export class CodexOAuthError extends Error {
  override name = 'CodexOAuthError';

  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** Owns provider login, pending authorization details and credential persistence. */
export class CodexOAuthManager {
  private readonly authStorageFactory: (authPath: string) => CodexAuthStorage;
  private readonly catalogGetter: () => Promise<LocalCustomProviderConfig>;
  private pendingCatalog: Promise<void> | undefined;
  private credentialGeneration = 0;
  private login: LoginAttempt | undefined;
  private lastError: string | undefined;

  constructor(private readonly deps: CodexOAuthManagerDeps) {
    this.authStorageFactory = deps.authStorageFactory ?? defaultCodexAuthStorageFactory(deps);
    this.catalogGetter =
      deps.catalogGetter ??
      (async () => {
        const credentials = await this.authStorage().getCredentials();
        if (!credentials)
          throw new CodexOAuthError(
            401,
            'Codex OAuth credentials are unavailable. Reconnect to retry.',
            'OAUTH_CREDENTIALS_UNAVAILABLE',
          );
        return new CodexModelDiscoveryClient(deps.fetchImpl).discover(credentials);
      });
  }

  getStatus(): CodexOAuthStatus {
    if (!this.enabled()) return this.status('hidden');
    if (this.login) return this.loginStatus(this.login);

    const authStorage = this.authStorage();
    if (authStorage.hasOAuth(OPENAI_CODEX_PROVIDER_ID) && this.hasConfiguredProvider()) {
      return this.status('connected', this.lastError);
    }
    if (this.lastError) return this.status('failed', this.lastError);
    return this.status('disconnected');
  }

  async refreshModels(): Promise<CodexOAuthStatus> {
    if (!this.enabled()) {
      throw new CodexOAuthError(404, 'Codex OAuth is not enabled.', 'FEATURE_DISABLED');
    }
    if (
      this.login ||
      !this.authStorage().hasOAuth(OPENAI_CODEX_PROVIDER_ID) ||
      !this.hasConfiguredProvider()
    ) {
      throw new CodexOAuthError(
        409,
        'Connect Codex OAuth before fetching models.',
        'OAUTH_NOT_CONNECTED',
      );
    }
    const generation = this.credentialGeneration;
    try {
      await this.ensureProviderConfigured(false);
      if (generation === this.credentialGeneration) this.lastError = undefined;
      return this.getStatus();
    } catch (error) {
      const message = codexOAuthErrorMessage(error);
      if (generation === this.credentialGeneration) this.lastError = message;
      if (error instanceof CodexOAuthError) throw error;
      throw new CodexOAuthError(502, message, 'MODEL_DISCOVERY_FAILED');
    }
  }

  async startLogin(options: CodexOAuthLoginOptions = {}): Promise<CodexOAuthStartResult> {
    if (!this.enabled()) {
      throw new CodexOAuthError(404, 'Codex OAuth is not enabled.', 'FEATURE_DISABLED');
    }
    const method = options.method ?? 'browser';
    if (method !== 'browser' && method !== 'device_code') {
      throw new CodexOAuthError(400, 'Unknown Codex login method.', 'OAUTH_INVALID_METHOD');
    }
    if (this.login) {
      if (this.login.method !== method) {
        throw new CodexOAuthError(
          409,
          'Cancel the current Codex login before changing methods.',
          'OAUTH_LOGIN_PENDING',
        );
      }
      return this.login.start;
    }
    const authStorage = this.authStorage();
    if (authStorage.hasOAuth(OPENAI_CODEX_PROVIDER_ID)) {
      if (!this.hasConfiguredProvider()) await this.ensureProviderConfigured();
      this.lastError = undefined;
      return this.getStatus();
    }
    this.lastError = undefined;
    const attempt = this.createLoginAttempt(method);
    this.login = attempt;
    this.setLoginTimeout(attempt, 15 * 60 * 1000);
    const completion = this.finishLogin(authStorage, attempt);
    return Promise.race([attempt.start, completion]);
  }

  cancelLogin(loginId: string): CodexOAuthStatus {
    const attempt = this.login;
    if (!attempt || attempt.id !== loginId) return this.getStatus();
    this.login = undefined;
    this.credentialGeneration += 1;
    this.pendingCatalog = undefined;
    this.lastError = undefined;
    clearTimeout(attempt.timeout);
    const error = new CodexOAuthError(
      409,
      'Codex OAuth login was cancelled.',
      'OAUTH_LOGIN_CANCELLED',
    );
    attempt.controller.abort(error);
    attempt.reject(error);
    return this.getStatus();
  }

  private createLoginAttempt(method: CodexOAuthLoginMethod): LoginAttempt {
    let resolve!: LoginAttempt['resolve'];
    let reject!: LoginAttempt['reject'];
    const start = new Promise<CodexOAuthStartResult>((resolveStart, rejectStart) => {
      resolve = resolveStart;
      reject = rejectStart;
    });
    return { id: randomUUID(), method, controller: new AbortController(), start, resolve, reject };
  }

  private loginStatus(attempt: LoginAttempt): CodexOAuthStartResult {
    return (
      attempt.result ?? {
        ...this.status('pending'),
        loginId: attempt.id,
        method: attempt.method,
      }
    );
  }

  private setLoginTimeout(attempt: LoginAttempt, timeoutMs: number): void {
    clearTimeout(attempt.timeout);
    attempt.timeout = setTimeout(() => {
      const error = new CodexOAuthError(
        408,
        'Codex sign-in timed out. Start login again.',
        'OAUTH_LOGIN_EXPIRED',
      );
      if (this.login !== attempt) return;
      this.login = undefined;
      this.credentialGeneration += 1;
      this.pendingCatalog = undefined;
      this.lastError = error.message;
      attempt.controller.abort(error);
      attempt.reject(error);
    }, timeoutMs);
    attempt.timeout.unref?.();
  }

  private loginCallbacks(attempt: LoginAttempt): CodexLoginCallbacks {
    const { signal } = attempt.controller;
    const settle = (details: Partial<CodexOAuthStartResult>) => {
      signal.throwIfAborted();
      if (attempt.result) return;
      attempt.result = { ...this.loginStatus(attempt), ...details };
      attempt.resolve(attempt.result);
    };
    return {
      onAuth: ({ url }) => {
        if (!url.trim())
          throw new CodexOAuthError(502, 'Codex OAuth returned no URL.', 'OAUTH_START_FAILED');
        settle({ authUrl: url.trim() });
      },
      onDeviceCode: ({ userCode, verificationUri, expiresInSeconds = 900 }) => {
        if (
          !userCode ||
          !verificationUri ||
          !Number.isFinite(expiresInSeconds) ||
          expiresInSeconds <= 0
        ) {
          throw new CodexOAuthError(
            502,
            'Codex OAuth returned invalid device-code details.',
            'OAUTH_START_FAILED',
          );
        }
        this.setLoginTimeout(attempt, expiresInSeconds * 1000);
        settle({
          deviceCode: {
            userCode,
            verificationUri,
            expiresAt: Date.now() + expiresInSeconds * 1000,
          },
        });
      },
      onPrompt: async () => {
        throw new Error('Codex OAuth browser callback expired. Start login again.');
      },
      onSelect: async () => attempt.method,
      ...(attempt.method === 'browser'
        ? {
            onManualCodeInput: () =>
              new Promise<string>((_resolve, reject) => {
                if (signal.aborted) reject(signal.reason);
                else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
              }),
          }
        : {}),
      signal,
      fetch: async (input, init) => {
        const requestSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(30_000),
          ...(init?.signal ? [init.signal] : []),
        ]);
        return (this.deps.fetchImpl ?? globalThis.fetch)(input, { ...init, signal: requestSignal });
      },
    };
  }

  async removeCredentials(providerId: string): Promise<void> {
    if (providerId !== OPENAI_CODEX_PROVIDER_ID) {
      throw new CodexOAuthError(
        404,
        `OAuth credential storage does not support provider ${providerId}.`,
        'PROVIDER_AUTH_UNAVAILABLE',
      );
    }
    if (this.login) this.cancelLogin(this.login.id);
    await this.authStorage().removeOAuth(OPENAI_CODEX_PROVIDER_ID);
    this.credentialGeneration += 1;
    this.pendingCatalog = undefined;
    this.lastError = undefined;
  }

  private async finishLogin(
    authStorage: CodexAuthStorage,
    attempt: LoginAttempt,
  ): Promise<CodexOAuthStartResult> {
    try {
      await authStorage.login(OPENAI_CODEX_PROVIDER_ID, this.loginCallbacks(attempt));
      attempt.controller.signal.throwIfAborted();
      await this.ensureProviderConfigured();
      attempt.controller.signal.throwIfAborted();
      if (this.login !== attempt) return this.getStatus();
      this.lastError = undefined;
      this.login = undefined;
      const connected = this.getStatus();
      attempt.resolve(connected);
      return connected;
    } catch (error) {
      if (this.login !== attempt) return this.getStatus();
      const cause: unknown = attempt.controller.signal.reason ?? error;
      this.lastError = codexOAuthErrorMessage(cause);
      this.login = undefined;
      const failure =
        cause instanceof CodexOAuthError
          ? cause
          : new CodexOAuthError(502, this.lastError, 'OAUTH_LOGIN_FAILED');
      attempt.reject(failure);
      throw failure;
    } finally {
      clearTimeout(attempt.timeout);
    }
  }

  private enabled(): boolean {
    return this.deps.configGetter().beta?.codexOAuth === true;
  }

  private authStorage(): CodexAuthStorage {
    return this.authStorageFactory(join(this.deps.configGetter().dataDir, 'codex-auth.json'));
  }

  private hasConfiguredProvider(): boolean {
    return (
      Object.keys(
        this.deps.configGetter().custom_provider?.[OPENAI_CODEX_PROVIDER_ID]?.models ??
          this.deps.configGetter().provider?.[OPENAI_CODEX_PROVIDER_ID]?.models ??
          {},
      ).length > 0
    );
  }

  private async ensureProviderConfigured(createIfMissing = true): Promise<void> {
    if (this.pendingCatalog) return this.pendingCatalog;
    const operation = this.refreshProviderCatalog(createIfMissing);
    this.pendingCatalog = operation;
    try {
      await operation;
    } finally {
      if (this.pendingCatalog === operation) this.pendingCatalog = undefined;
    }
  }

  private async refreshProviderCatalog(createIfMissing: boolean): Promise<void> {
    const updater = this.deps.updateByokConfig;
    if (!updater) {
      throw new CodexOAuthError(
        503,
        'Codex OAuth provider configuration is unavailable.',
        'PROVIDER_CONFIG_UNAVAILABLE',
      );
    }
    const initialConfig = this.deps.configGetter();
    const hasLegacyProvider = Boolean(initialConfig.provider?.[OPENAI_CODEX_PROVIDER_ID]);
    const canCreate =
      createIfMissing &&
      !hasLegacyProvider &&
      !initialConfig.custom_provider?.[OPENAI_CODEX_PROVIDER_ID];
    if (hasLegacyProvider && !this.deps.removeLegacyProvider) {
      throw new CodexOAuthError(
        503,
        'Codex OAuth legacy provider removal is unavailable.',
        'PROVIDER_CONFIG_UNAVAILABLE',
      );
    }
    const generation = this.credentialGeneration;
    let catalog: LocalCustomProviderConfig;
    try {
      catalog = await this.catalogGetter();
    } catch (error) {
      if (error instanceof CodexOAuthError) throw error;
      throw new CodexOAuthError(
        502,
        'Codex model discovery failed. Retry fetching models from model settings.',
        'MODEL_DISCOVERY_FAILED',
      );
    }
    let configured = false;
    await updater((draft, currentConfig) => {
      if (generation !== this.credentialGeneration) return;
      const exists =
        currentConfig.custom_provider?.[OPENAI_CODEX_PROVIDER_ID] ??
        currentConfig.provider?.[OPENAI_CODEX_PROVIDER_ID];
      if (!exists && !canCreate) return;
      configureCodexOAuthProvider(draft, currentConfig, catalog);
      configured = true;
    });
    if (configured && hasLegacyProvider) {
      await this.deps.removeLegacyProvider?.(OPENAI_CODEX_PROVIDER_ID);
    }
  }

  private status(state: CodexOAuthState, error?: string): CodexOAuthStatus {
    return {
      state,
      providerId: OPENAI_CODEX_PROVIDER_ID,
      ...(error ? { error } : {}),
    };
  }
}

function configureCodexOAuthProvider(
  draft: LocalByokConfigDraft,
  currentConfig: LocalRuntimeConfig,
  catalog: LocalCustomProviderConfig,
): void {
  const tree = (draft.custom_provider ?? {}) as LocalCustomProvidersConfig;
  const current =
    currentConfig.custom_provider?.[OPENAI_CODEX_PROVIDER_ID] ??
    currentConfig.provider?.[OPENAI_CODEX_PROVIDER_ID];
  tree[OPENAI_CODEX_PROVIDER_ID] = mergeCodexOAuthProvider(current, catalog);
  draft.custom_provider = tree as Record<string, unknown>;
  if (draft.defaultModel?.startsWith(`${OPENAI_CODEX_PROVIDER_ID}/`)) {
    draft.defaultModel = `custom_provider:${draft.defaultModel}`;
  }
}

function mergeCodexOAuthProvider(
  current: LocalCustomProviderConfig | undefined,
  catalog: LocalCustomProviderConfig,
): LocalCustomProviderConfig {
  const currentOptions = { ...(current?.options ?? {}) };
  delete currentOptions.apiKey;
  const currentModels = current?.models ?? {};
  return {
    ...current,
    api: current?.api ?? catalog.api,
    name: current?.name ?? catalog.name,
    kind: 'oauth',
    enabled: current?.enabled ?? true,
    options: {
      ...currentOptions,
      baseURL: current?.options?.baseURL ?? catalog.options?.baseURL,
      authMode: 'oauth',
    },
    models: mergeCodexModels(currentModels, catalog.models ?? {}),
  };
}

function mergeCodexModels(
  current: Record<string, LocalModelConfig>,
  discovered: Record<string, LocalModelConfig>,
): Record<string, LocalModelConfig> {
  // Stored fields are authoritative, including old catalog values whose edit history is unknown.
  const models = new Map(Object.entries(current));
  for (const [id, model] of Object.entries(discovered)) {
    const existing = models.get(id);
    models.set(id, {
      ...model,
      ...existing,
      ...(model.limit || existing?.limit ? { limit: { ...model.limit, ...existing?.limit } } : {}),
      ...(model.modalities || existing?.modalities
        ? { modalities: { ...model.modalities, ...existing?.modalities } }
        : {}),
      ...(model.thinking || existing?.thinking
        ? { thinking: { ...model.thinking, ...existing?.thinking } }
        : {}),
    });
  }
  return Object.fromEntries(models);
}

/**
 * Default storage adapter over the PIN AuthStorage surface (W04 migration).
 *
 * Memoized per `authPath`: `hasOAuth` stays synchronous for the status UI by
 * keeping a snapshot seeded from auth.json and updated by the mutations this
 * adapter itself performs — every call returns the SAME adapter, so a login
 * completion is visible to the next `getStatus()` tick.
 */
function defaultCodexAuthStorageFactory(
  deps: CodexOAuthManagerDeps,
): (authPath: string) => CodexAuthStorage {
  const cache = new Map<string, CodexAuthStorage>();
  return (authPath) => {
    const cached = cache.get(authPath);
    if (cached !== undefined) return cached;
    const storage = AuthStorage.create(authPath);
    let hasOAuthSnapshot =
      readStoredCredential(OPENAI_CODEX_PROVIDER_ID, authPath)?.type === 'oauth';
    const adapter: CodexAuthStorage = {
      getCredentials: async () => {
        const stored = await storage.read(OPENAI_CODEX_PROVIDER_ID);
        if (stored?.type !== 'oauth') return undefined;
        try {
          // Locked refresh through the provider registry (pin Models
          // semantics: a refresh failure rejects ModelsError "oauth" and
          // preserves the stored credential for a later retry). The
          // refreshed credential persists in the same store.
          await withHostFetch(deps.fetchImpl, async () => {
            await codexModels(storage).getAuth(OPENAI_CODEX_PROVIDER_ID);
          });
        } catch (error) {
          if (error instanceof ModelsError && error.code === 'oauth') return undefined;
          throw error;
        }
        const credential = await storage.read(OPENAI_CODEX_PROVIDER_ID);
        if (credential?.type !== 'oauth') return undefined;
        const { access, accountId } = credential;
        return access && typeof accountId === 'string' && accountId
          ? { access, accountId }
          : undefined;
      },
      hasOAuth: () => hasOAuthSnapshot,
      removeOAuth: async (provider) => {
        await storage.delete(provider);
        hasOAuthSnapshot = false;
      },
      login: async (provider: typeof OPENAI_CODEX_PROVIDER_ID, callbacks: CodexLoginCallbacks) => {
        // Two-phase login keeps late token responses from a cancelled
        // attempt out of profile storage: the provider flow writes to a
        // pending in-memory store; only an unaborted completion is copied
        // to the profile store.
        const pending = AuthStorage.inMemory();
        const interaction: AuthInteraction = {
          signal: callbacks.signal,
          notify: (event) => notifyCallback(event, callbacks),
          prompt: (prompt) => promptCallback(prompt, callbacks),
        };
        await withHostFetch(callbacks.fetch, () =>
          codexModels(pending).login(provider, 'oauth', interaction),
        );
        callbacks.signal.throwIfAborted();
        const credential = await pending.read(provider);
        if (credential === undefined) {
          throw new Error('Codex OAuth credentials are unavailable.');
        }
        await storage.modify(provider, async () => credential);
        hasOAuthSnapshot = true;
      },
    };
    cache.set(authPath, adapter);
    return adapter;
  };
}

/**
 * A one-provider registry over `store`. The pin's `Models` starts empty;
 * registering just the Codex provider keeps login/refresh on the upstream
 * flow (no duplicated OAuth code) without pulling every built-in in.
 */
function codexModels(store: CredentialStore): MutableModels {
  const models = createModels({ credentials: store });
  models.setProvider(openaiCodexProvider());
  return models;
}

function codexOAuthErrorMessage(error: unknown): string {
  if (error instanceof CodexOAuthError) return error.message;
  const message = error instanceof Error ? error.message : '';
  if (message.includes('callback expired')) return message;
  if (message.includes('EADDRINUSE')) {
    return 'Codex OAuth callback port 1455 is already in use.';
  }
  if (message.startsWith('Device flow timed out')) return 'Device code expired. Start login again.';
  if (message.includes('device code login is not enabled')) {
    return 'Enable device code login in ChatGPT security settings or workspace permissions, then retry.';
  }
  if (message === 'Login cancelled') return 'Codex OAuth login was cancelled.';
  return 'Codex OAuth login failed.';
}

/** Map a pin `AuthEvent` onto the manager's login callbacks. */
function notifyCallback(event: AuthEvent, callbacks: CodexLoginCallbacks): void {
  if (event.type === 'auth_url') {
    callbacks.onAuth({ url: event.url });
    return;
  }
  if (event.type === 'device_code') {
    callbacks.onDeviceCode?.({
      userCode: event.userCode,
      verificationUri: event.verificationUri,
      ...(event.intervalSeconds === undefined ? {} : { intervalSeconds: event.intervalSeconds }),
      ...(event.expiresInSeconds === undefined ? {} : { expiresInSeconds: event.expiresInSeconds }),
    });
    return;
  }
  // `progress` / `info` events are informational; the manager surfaces
  // device-code and auth-url state only.
}

/** Map a pin `AuthPrompt` onto the manager's login callbacks. */
async function promptCallback(prompt: AuthPrompt, callbacks: CodexLoginCallbacks): Promise<string> {
  if (prompt.type === 'select') {
    const choice = await callbacks.onSelect?.({
      message: prompt.message,
      options: prompt.options.map((option) => ({ id: option.id, label: option.label })),
    });
    return choice ?? 'browser';
  }
  if (prompt.type === 'manual_code') {
    if (callbacks.onManualCodeInput) return callbacks.onManualCodeInput();
    throw new Error('Codex OAuth browser callback expired. Start login again.');
  }
  if (callbacks.onPrompt) return callbacks.onPrompt({ message: prompt.message });
  throw new Error(prompt.message);
}

/**
 * Run `run` with the host fetch installed as the global for the duration:
 * the pin's OAuth flows call the module-global `fetch` directly, so the
 * product's injected fetch (abort/timeout wrapper) is scoped around them
 * rather than duplicated per endpoint (§5.1 provider-fetch family).
 *
 * Reentrancy: overlapping operations (a cancelled login settling while a
 * newer attempt already swapped the global; a refresh racing a login) each
 * push a frame, and an exit pops only its OWN frame — the global always
 * reflects the most recent still-active frame. A plain save/restore here let
 * the FIRST operation's finally install the real fetch while the second was
 * still in flight, sending its device-code request to the network outside
 * the host wrapper (regression: "stale cancel" test 403-ing on the live
 * auth.openai.com instead of the injected mock).
 */
type HostFetchFrame = { wrapper: typeof fetch };
const hostFetchFrames: HostFetchFrame[] = [];
let hostFetchBase: typeof fetch | undefined;

async function withHostFetch<T>(fetchImpl: typeof fetch | undefined, run: () => Promise<T>): Promise<T> {
  if (fetchImpl === undefined || fetchImpl === globalThis.fetch) return run();
  if (hostFetchFrames.length === 0) hostFetchBase = globalThis.fetch;
  const frame: HostFetchFrame = {
    wrapper: ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      fetchImpl(input, init)) as typeof fetch,
  };
  hostFetchFrames.push(frame);
  globalThis.fetch = frame.wrapper;
  try {
    return await run();
  } finally {
    const index = hostFetchFrames.lastIndexOf(frame);
    if (index !== -1) hostFetchFrames.splice(index, 1);
    globalThis.fetch = hostFetchFrames[hostFetchFrames.length - 1]?.wrapper ?? hostFetchBase!;
  }
}
