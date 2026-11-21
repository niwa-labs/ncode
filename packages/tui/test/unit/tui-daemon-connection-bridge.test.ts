/**
 * W4 (§4.6, review round 2 п.1): the daemon-connection bridge is ALIVE —
 * the state reaches the shell state the status line renders.
 *
 * Three seams of the bridge, each with its own assertion:
 * 1. the surface holder adopts `CreatedTuiRuntime.connection` whenever it
 *    resolves (the app starts composing before the runtime exists) and
 *    re-fires on every `onChange`; a runtime WITHOUT `connection`
 *    (`MCODE_SERVER_MODE=off`) stays silent forever;
 * 2. the projection carries `daemonConnection` into `presentation.shell`;
 * 3. `TuiChromeFlow` reads the getter on every update and the composed
 *    shell lands in the STATUS component (the thing that renders).
 *
 * @module
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createTuiDaemonConnectionSurface,
  type TuiDaemonConnectionState,
} from '../../src/tui/daemon-connection-surface.js';
import { TuiChromeFlow } from '../../src/tui/controller/product/chrome-flow.js';
import { resolveTuiVisiblePresentation } from '../../src/tui/controller/projection/visible-presentation.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type ConnectionLike = {
  state(): TuiDaemonConnectionState;
  onChange(listener: (state: TuiDaemonConnectionState) => void): () => void;
};

describe('daemon connection surface (the holder)', () => {
  it('adopts the state when the runtime resolves and re-fires on change', async () => {
    const listeners: Array<(state: TuiDaemonConnectionState) => void> = [];
    const connection: ConnectionLike = {
      state: () => 'connecting',
      onChange: (listener) => {
        listeners.push(listener);
        return () => undefined;
      },
    };
    const runtime = deferred<{ connection?: ConnectionLike }>();
    const surface = createTuiDaemonConnectionSurface(runtime.promise as never);
    expect(surface.getState()).toBeUndefined(); // nothing known yet — no line
    runtime.resolve({ connection });

    await vi.waitFor(() => expect(surface.getState()).toBe('connecting'));

    const updates: Array<TuiDaemonConnectionState | undefined> = [];
    surface.subscribe(() => updates.push(surface.getState()));
    listeners.forEach((listener) => listener('reconnecting'));
    expect(surface.getState()).toBe('reconnecting');
    expect(updates).toEqual(['reconnecting']); // the chrome re-projects promptly
  });

  it('a runtime without connection (server mode off) never fabricates a state', async () => {
    const runtime = deferred<{ connection?: ConnectionLike }>();
    const surface = createTuiDaemonConnectionSurface(runtime.promise as never);
    runtime.resolve({ connection: undefined });
    await vi.waitFor(() => expect(surface.getState()).toBeUndefined());
  });

  it('dispose detaches from the runtime', async () => {
    const listeners: Array<(state: TuiDaemonConnectionState) => void> = [];
    const connection: ConnectionLike = {
      state: () => 'ready',
      onChange: (listener) => {
        listeners.push(listener);
        return () => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        };
      },
    };
    const runtime = deferred<{ connection?: ConnectionLike }>();
    const surface = createTuiDaemonConnectionSurface(runtime.promise as never);
    runtime.resolve({ connection });
    await vi.waitFor(() => expect(listeners).toHaveLength(1));
    surface.dispose();
    listeners.forEach((listener) => listener('closed'));
    expect(surface.getState()).toBe('ready'); // detached: no further adoption
  });
});

const presentationBase = {
  snapshot: {
    status: 'ready',
    sessions: [],
  },
  connection: { phase: 'connected', generation: 0, lastError: undefined },
  surface: 'welcome' as const,
  transcript: {
    snapshot: () => [] as unknown[],
    latestSettledFailure: () => undefined,
  },
  runtimeQueuedCount: 0,
  queueEnabled: false,
  activePermission: false,
  activeQuestionnaire: false,
  compacting: false,
  attachmentCount: 0,
  version: 'test',
  workspace: '/repo',
};

describe('the daemon state reaches the shell (composition)', () => {
  it('the projection carries daemonConnection into the shell state', () => {
    const presentation = resolveTuiVisiblePresentation({
      ...presentationBase,
      daemonConnection: 'reconnecting',
    } as never);
    expect(presentation.shell.daemonConnection).toBe('reconnecting');
  });

  it('the off path (no daemonConnection) leaves the shell silent', () => {
    const presentation = resolveTuiVisiblePresentation(presentationBase as never);
    expect(presentation.shell.daemonConnection).toBeUndefined();
  });

  it('TuiChromeFlow reads the getter on every update and pushes the shell to the STATUS component', () => {
    const shells: Array<Record<string, unknown>> = [];
    const sink = {
      setState: (state: Record<string, unknown>) => {
        shells.push(state);
      },
    };
    let current: TuiDaemonConnectionState | undefined = 'reconnecting';
    const flow = new TuiChromeFlow({
      version: 'test',
      workspace: '/repo',
      queueEnabled: false,
      isStarted: () => true,
      isStopped: () => false,
      setTerminalTitle: () => undefined,
      setProgramStatus: () => undefined,
      connection: () => ({ phase: 'connected', generation: 0 }),
      liveRunId: () => undefined,
      runProjection: () => ({ queuedCount: 0, stoppingRuntimeTurnId: undefined }),
      transcript: {
        length: 0,
        findVisibleError: () => undefined,
        latestSettledFailure: () => undefined,
        hasConcreteTurnActivity: () => false,
      } as never,
      shouldResumeDraftAfterLogin: () => false,
      activePermission: () => false,
      activeQuestionnaire: () => false,
      agentInteraction: () => undefined,
      attachmentCount: () => 0,
      expandedDraft: () => '',
      selectedModel: () => undefined,
      permissionMode: () => undefined,
      // THE BRIDGE: the surface getter, exactly as app.ts passes it.
      daemonConnection: () => current,
      welcome: sink,
      status: sink,
      activity: sink,
      composer: sink,
    } as never);
    flow.update({ status: 'ready', sessions: [] } as never);
    expect(shells.some((shell) => shell.daemonConnection === 'reconnecting')).toBe(true);

    // The state change flows through the same getter on the next update.
    current = 'ready';
    flow.update({ status: 'ready', sessions: [] } as never);
    const last = shells[shells.length - 1];
    expect(last.daemonConnection).toBeUndefined(); // ready → no news, no line
  });
});
