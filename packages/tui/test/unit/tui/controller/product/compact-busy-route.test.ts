import { describe, expect, it, vi } from "vitest";
import { TuiCommandFlow } from "../../../../../src/tui/controller/product/command-flow.js";

/**
 * Wave-3 item 3.4 regression (owner bug 2026-11-07): `/compact` typed while a
 * Turn is live must reach the runtime as a queue-deferred inbox control
 * element — the catalog claims it at every availability state, so it never
 * falls into the e1cf119e unrecognized-slash park guards and is never refused
 * with "Stop the running turn".
 */

function createFeatureFlowMock() {
  return {
    skillCommands: () => [],
    waitForWelcomeModelSelection: vi.fn(async () => undefined),
    applyPendingModelSelection: vi.fn(async () => undefined),
    showChangelog: vi.fn(async () => undefined),
    compactSession: vi.fn(async () => undefined),
  };
}

const busySeed = {
  sessionId: "session-1",
  editor: {
    schemaVersion: 1 as const,
    text: "/compact",
    cursor: 8,
    pasteCounter: 0,
    pastes: [],
  },
  resources: { attachments: [] },
};

function createBusyFlow(overrides?: {
  append?: (text: string, kind?: string) => void;
  featureFlow?: Record<string, unknown>;
}) {
  const controller = {
    snapshot: vi.fn(() => ({
      status: "running" as const,
      sessions: [],
      session: { sessionId: "session-1" },
      activeTurnId: "turn-active",
    })),
    hasInProcessRun: vi.fn(() => true),
    requireLoginForAgentAction: vi.fn(async () => undefined),
    projectOptimisticUserMessage: vi.fn(),
    removeOptimisticUserMessage: vi.fn(),
  };
  const composerDraft = {
    hasContent: vi.fn(() => false),
    capture: vi.fn(() => ({ attachments: [] })),
    reserveSubmission: vi.fn(() => ({ attachments: [] })),
    restoreSubmission: vi.fn(),
    completeSubmission: vi.fn(async () => undefined),
  };
  const queueFlow = {
    beginAdmission: vi.fn(),
    cancelAdmission: vi.fn(),
    enqueue: vi.fn(async () => undefined),
  };
  const append = overrides?.append ?? vi.fn();
  const setHint = vi.fn();
  const flow = new TuiCommandFlow({
    workspaceDir: "/workspace",
    controller: controller as never,
    activeRunFlow: { steer: vi.fn(async () => true) } as never,
    featureFlow: (overrides?.featureFlow ?? createFeatureFlowMock()) as never,
    feedbackFlow: {} as never,
    updateFlow: {} as never,
    interactionFlow: {
      handleCommand: vi.fn(async () => false),
      hasPending: vi.fn(() => false),
      showPending: vi.fn(),
    } as never,
    sessionFlow: {} as never,
    queueFlow: queueFlow as never,
    composerDraft: composerDraft as never,
    workspaceRoots: { additionalDirectories: () => [] } as never,
    runProjection: { snapshot: () => ({ queuedCount: 2 }) } as never,
    editor: { setText: vi.fn() } as never,
    surface: {} as never,
    surfaceHost: { setChatFocus: vi.fn() } as never,
    queueEnabled: true,
    liveRunId: () => "run-active",
    runtimeStopping: () => false,
    abortLiveTurn: vi.fn(async () => false),
    leaveUi: vi.fn(async () => undefined),
    whenReady: vi.fn(async () => undefined),
    append,
    setHint,
    onChanged: vi.fn(),
  });
  return { flow, queueFlow, append, setHint, composerDraft };
}

describe("TuiCommandFlow: /compact while busy is a queue-deferred inbox control", () => {
  it("dispatches /compact to the runtime with the live-run flag under the Alt+Enter queue intent", async () => {
    const featureFlow = createFeatureFlowMock();
    const { flow, queueFlow } = createBusyFlow({ featureFlow });

    await expect(
      flow.submit("/compact", busySeed, { busyAction: "queue" }),
    ).resolves.toBe("consumed");

    expect(featureFlow.compactSession).toHaveBeenCalledWith("", true);
    expect(queueFlow.enqueue).not.toHaveBeenCalled();
    expect(queueFlow.beginAdmission).not.toHaveBeenCalled();
  });

  it("dispatches /compact during a live run with no explicit busy intent", async () => {
    const featureFlow = createFeatureFlowMock();
    const { flow, queueFlow } = createBusyFlow({ featureFlow });

    await expect(flow.submit("/compact", busySeed)).resolves.toBe("consumed");

    expect(featureFlow.compactSession).toHaveBeenCalledWith("", true);
    expect(queueFlow.enqueue).not.toHaveBeenCalled();
  });

  it("never refuses a busy /compact with the unrecognized-slash park warning", async () => {
    const append = vi.fn();
    const featureFlow = createFeatureFlowMock();
    const { flow } = createBusyFlow({ append, featureFlow });

    await flow.submit("/compact", busySeed, { busyAction: "queue" });

    const appended = append.mock.calls.map(([text]) => text).join("\n");
    expect(appended).not.toContain("not a recognized MCode command");
  });

  it("never refuses a busy /compact with the stop-the-turn availability hint", async () => {
    const setHint = vi.fn();
    const featureFlow = createFeatureFlowMock();
    const { flow } = createBusyFlow({ featureFlow });

    await flow.submit("/compact", busySeed, { busyAction: "queue" });

    const hints = setHint.mock.calls.map(([text]) => text).join("\n");
    expect(hints).not.toContain("Stop the running turn");
    expect(featureFlow.compactSession).toHaveBeenCalled();
  });
});
