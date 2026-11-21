import { createLogger } from '@mavis/logging';

import type { DurableSystemStores } from '../../../session-system/messages/history/durable-session-stores.js';
import {
  createDelegationSteeringComposition,
  type DelegationSteeringComposition,
} from './delegation-release-composition.js';

const log = createLogger('mcode:turn');

/**
 * Runtime delegation-steering composition (integration plan Ш6).
 *
 * Wires the wave-3 steering stack over the runtime's durable storage: the
 * seam's records are RUNTIME-level (keyed by delegation ids, not sessions),
 * so the composition lives on the daemon-owned SYSTEM log — the one shared
 * substrate beside the orchestration bridges (owner decision 2026-11-18,
 * per-session durable history). Durable daemon mode only — embedded
 * per-session runtimes and the jsonl default never call this, so the steer
 * service keeps exactly today's behavior there.
 *
 * The backend is handed to the composition DIRECTLY (no batching writer in
 * between: history appends go through the per-session routing worker,
 * steering commits single-flight), so the composition's structural
 * urgent-flush default applies.
 */
export async function createRuntimeDelegationSteeringComposition(options: {
  readonly system: DurableSystemStores;
}): Promise<DelegationSteeringComposition> {
  const startedMs = Date.now();
  const composition = await createDelegationSteeringComposition({
    backend: options.system.backend,
  });
  log.info('delegation steering composition opened', {
    directory: options.system.directory,
    head: options.system.backend.head,
    durationMs: Date.now() - startedMs,
  });
  const closeComposition = composition.close.bind(composition);
  return {
    ...composition,
    close: async () => {
      try {
        await closeComposition();
      } finally {
        log.info('delegation steering composition closed', {
          directory: options.system.directory,
        });
      }
    },
  };
}
