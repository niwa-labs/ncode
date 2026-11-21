import { join } from 'node:path';
import { AuthStorage } from '@earendil-works/pi-coding-agent/auth-storage';
import type { LocalRuntimeConfig } from '../config/types.js';
import {
  LocalModelResolver,
  type LocalModelResolverLike,
  type LocalRuntimeAuthContext,
} from '../runtime/model-resolver.js';
import type { LocalDynamicMaxTokensState } from '../runtime/dynamic-max-tokens.js';
import type { LocalRuntimeRoutingContext } from '../runtime/routing-headers.js';
import type { LocalSessionRecord } from '../sessions/controller.js';
import { LocalGreetingSystemReminderSender } from './host-greeting-sender.js';
import type { RuntimeConversation } from '@mavis/conversation-contract';

/**
 * Factories for host-owned runtime services. Extracted from `host.ts`, which
 * sits at the 2000-line source cap; keeping these construction blocks here
 * leaves the host constructor focused on lifecycle wiring.
 */

export function createLocalModelResolver(input: {
  configGetter: () => LocalRuntimeConfig;
  authContextGetter?: () => LocalRuntimeAuthContext | undefined;
  routingContextGetter?: () => LocalRuntimeRoutingContext | undefined;
  dynamicMaxTokensState: LocalDynamicMaxTokensState;
  fetchImpl?: typeof fetch;
}): LocalModelResolverLike {
  return new LocalModelResolver({
    providerConfigGetter: () => input.configGetter().provider,
    byokConfigGetter: () => {
      const { minimax_api, custom_provider, minimaxModelSource } = input.configGetter();
      return { minimax_api, custom_provider, minimaxModelSource };
    },
    authContextGetter: input.authContextGetter,
    routingContextGetter: input.routingContextGetter,
    providerAuthGetter: async (provider) => {
      // W06: the pin AuthStorage has no `getApiKey` (0.79-era surface);
      // read the stored credential and surface api_key entries only —
      // OAuth credentials do not yield a static provider key.
      const credential = await AuthStorage.create(
        join(input.configGetter().dataDir, 'codex-auth.json'),
      ).read(provider);
      return credential?.type === 'api_key' ? credential.key : undefined;
    },
    dynamicMaxTokensState: input.dynamicMaxTokensState,
    fetchImpl: input.fetchImpl,
  });
}

export interface GreetingServiceHost {
  getSessionById(sessionId: string): Promise<LocalSessionRecord | undefined>;
}

/** Build the `LocalGreetingSystemReminderSender` from host closures. */
export function createLocalGreetingSystemReminderSender(
  host: GreetingServiceHost,
  runtimeConversation: RuntimeConversation | undefined,
): LocalGreetingSystemReminderSender {
  return new LocalGreetingSystemReminderSender({
    getSessionById: (sessionId) => host.getSessionById(sessionId),
    submitConversationTurn: ({ sessionId, content, requestedTurnId }) => {
      if (!runtimeConversation) {
        throw new Error('Runtime Conversation is unavailable for greeting delivery');
      }
      return runtimeConversation.ingress.submit({
        sessionId,
        source: 'greeting',
        allowQueue: true,
        requestedTurnId,
        message: { content, attachments: [], hideUserMessage: true },
      });
    },
  });
}
