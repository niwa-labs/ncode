/**
 * The W4 daemon-connection bridge (§4.6): carries the thin-client's honest
 * connection state from the lifecycle (`CreatedTuiRuntime.connection`) into
 * the shell state (`TuiShellState.daemonConnection`) so the status line can
 * render `reconnecting`/offline as plain text.
 *
 * The runtime resolves AFTER the app starts composing, so the surface is a
 * small holder: it starts empty (no line — nothing is known yet), adopts the
 * first state when the runtime arrives, and re-fires its listeners on every
 * `onChange` so the chrome re-projects. Absent entirely in server mode `off`
 * (the default): the launcher never constructs the surface.
 *
 * @module
 */

import type { CreatedTuiRuntime } from '../runtime/lifecycle.js';

/** The honest connection states (mirrors `McodedClientState`). */
export type TuiDaemonConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'ready'
  | 'reconnecting'
  | 'closed';

/** What the app options carry; `getState()` is `undefined` until known. */
export interface TuiDaemonConnectionSurface {
  getState(): TuiDaemonConnectionState | undefined;
  /** Fires on every state change (and once when the surface adopts the runtime). */
  subscribe(listener: () => void): () => void;
  /** Detach from the runtime (app teardown). */
  dispose(): void;
}

export function createTuiDaemonConnectionSurface(
  runtime: Promise<CreatedTuiRuntime>,
): TuiDaemonConnectionSurface {
  let state: TuiDaemonConnectionState | undefined;
  let unsubscribe: (() => void) | undefined;
  const listeners: Array<() => void> = [];
  const fire = (): void => {
    for (const listener of [...listeners]) listener();
  };
  void runtime
    .then((created) => {
      const connection = created.connection;
      if (!connection) return; // server mode off: no daemon state exists
      state = connection.state();
      unsubscribe = connection.onChange((next) => {
        state = next;
        fire();
      });
      fire(); // adopt the initial state (the app may already be rendering)
    })
    .catch(() => undefined); // a failed runtime never fabricates a state
  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    dispose: () => {
      unsubscribe?.();
      listeners.length = 0;
    },
  };
}
