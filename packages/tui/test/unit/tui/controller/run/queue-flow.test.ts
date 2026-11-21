import { describe, expect, it, vi } from "vitest";

import { TuiQueueFlow } from "../../../../../src/tui/controller/run/queue-flow.js";
import { TuiRunProjection } from "../../../../../src/tui/state/run-projection.js";
import { TranscriptStore } from "../../../../../src/tui/transcript/store.js";
import type { TuiQueuedMessage } from "../../../../../src/runtime/port.js";

function createHarness(options?: {
  queueItems?: TuiQueuedMessage[];
  queuePaused?: boolean;
  enabled?: boolean;
  isStopped?: () => boolean;
  sessionIdle?: boolean;
}) {
  const sessionId = "session-1";
  const liveTurnId = "turn-live";
  const chat = {
    status: options?.sessionIdle ? ("idle" as const) : ("running" as const),
    sessions: [],
    session: { sessionId },
    activeTurnId: options?.sessionIdle ? undefined : liveTurnId,
    retiringTurnId: undefined,
  };
  const controller = {
    snapshot: vi.fn(() => chat),
    requireLoginForAgentAction: vi.fn(async () => undefined),
  };
  const runProjection = new TuiRunProjection();
  runProjection.replaceQueue(options?.queueItems ?? [], {
    paused: options?.queuePaused ?? false,
    pendingCount: (options?.queueItems ?? []).filter(
      (item) => item.status === "queued" || item.status === "paused",
    ).length,
  });
  const steeredItems: string[] = [];
  // The fake mirrors the Runtime's queue rows: a delivered (steered) item
  // leaves the snapshot, so a post-drain refresh cannot resurrect it.
  const queueRows = [...(options?.queueItems ?? [])];
  const queuePaused = options?.queuePaused ?? false;
  const runtime = {
    getQueueSnapshot: vi.fn(async () => ({
      items: queueRows.filter((item) => !steeredItems.includes(item.itemId)),
      paused: queuePaused,
      pendingCount: queueRows.filter(
        (item) => !steeredItems.includes(item.itemId),
      ).length,
    })),
    steerQueuedMessage: vi.fn(async (_sessionId: string, itemId: string) => {
      steeredItems.push(itemId);
      return { queueItemId: itemId, turnId: `${itemId}-turn` };
    }),
    continueQueue: vi.fn(async () => undefined),
  };
  const onChanged = vi.fn();
  const flow = new TuiQueueFlow({
    runtime: runtime as never,
    controller: controller as never,
    composerDraft: {} as never,
    runProjection,
    transcript: new TranscriptStore(),
    followUp: { setItems: vi.fn(), setQueueSummary: vi.fn() } as never,
    surface: {} as never,
    enabled: options?.enabled ?? true,
    setHint: vi.fn(),
    onChanged,
    requestRender: vi.fn(),
    isStopped: options?.isStopped,
  });
  return { flow, controller, runtime, runProjection, onChanged, steeredItems, sessionId };
}

function queuedItem(itemId: string, overrides: Partial<TuiQueuedMessage> = {}): TuiQueuedMessage {
  return {
    itemId,
    sessionId: "session-1",
    status: "queued",
    content: `message ${itemId}`,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("TuiQueueFlow FIFO drain into the active Turn", () => {
  it("delivers queued items to the live Turn in typing order (oldest first)", async () => {
    const { flow, runtime, steeredItems } = createHarness({
      queueItems: [queuedItem("item-1"), queuedItem("item-2"), queuedItem("item-3")],
    });

    await expect(flow.drainIntoActiveTurn()).resolves.toBe(3);

    expect(steeredItems).toEqual(["item-1", "item-2", "item-3"]);
    expect(runtime.steerQueuedMessage).toHaveBeenCalledTimes(3);
    for (const itemId of ["item-1", "item-2", "item-3"]) {
      expect(runtime.steerQueuedMessage).toHaveBeenCalledWith("session-1", itemId);
    }
  });

  it("consumes the drained items from the Queue projection", async () => {
    const { flow, runProjection } = createHarness({
      queueItems: [queuedItem("item-1"), queuedItem("item-2")],
    });

    await flow.drainIntoActiveTurn();

    // The post-drain refresh reflects the Runtime truth: delivered items left
    // the queue, so nothing waits for the live Turn anymore.
    expect(runProjection.snapshot().queuedItems).toEqual([]);
    expect(runProjection.snapshot().queuePendingCount).toBe(0);
  });

  it("stops the drain at a head that carries attachments (they run next)", async () => {
    const { flow, steeredItems } = createHarness({
      queueItems: [
        queuedItem("item-1"),
        queuedItem("item-2", {
          attachments: [
            {
              meta: {
                attachmentType: "image",
                fileName: "shot.png",
                mimeType: "image/png",
                sizeBytes: 3,
              },
            },
          ],
        }),
        queuedItem("item-3"),
      ],
    });

    await expect(flow.drainIntoActiveTurn()).resolves.toBe(1);

    expect(steeredItems).toEqual(["item-1"]);
  });

  it("never skips over a paused head and ignores the queue while paused", async () => {
    const pausedHead = createHarness({
      queueItems: [queuedItem("item-1", { status: "paused" }), queuedItem("item-2")],
    });
    await expect(pausedHead.flow.drainIntoActiveTurn()).resolves.toBe(0);
    expect(pausedHead.steeredItems).toEqual([]);

    const pausedQueue = createHarness({
      queueItems: [queuedItem("item-1")],
      queuePaused: true,
    });
    await expect(pausedQueue.flow.drainIntoActiveTurn()).resolves.toBe(0);
    expect(pausedQueue.steeredItems).toEqual([]);
  });

  it("stops the drain without throwing when the Runtime refuses a steer", async () => {
    const harness = createHarness({
      queueItems: [queuedItem("item-1"), queuedItem("item-2")],
    });
    harness.runtime.steerQueuedMessage.mockRejectedValueOnce(
      new Error("queue item could not start"),
    );

    await expect(harness.flow.drainIntoActiveTurn()).resolves.toBe(0);
    expect(harness.steeredItems).toEqual([]);
  });

  it("drains nothing when the queue feature is disabled or the flow stopped", async () => {
    const disabled = createHarness({ queueItems: [queuedItem("item-1")], enabled: false });
    await expect(disabled.flow.drainIntoActiveTurn()).resolves.toBe(0);
    expect(disabled.steeredItems).toEqual([]);

    const stopped = createHarness({
      queueItems: [queuedItem("item-1")],
      isStopped: () => true,
    });
    await expect(stopped.flow.drainIntoActiveTurn()).resolves.toBe(0);
    expect(stopped.steeredItems).toEqual([]);
  });
});

describe("TuiQueueFlow resume after a Turn terminal", () => {
  it("resumes a queue the terminal left paused with pending messages", async () => {
    const { flow, runtime } = createHarness({
      queueItems: [queuedItem("item-1"), queuedItem("item-2")],
      queuePaused: true,
      // The terminal released the Turn: no active in-process turn remains.
      sessionIdle: true,
    });

    await expect(flow.resumeAfterTurnTerminal()).resolves.toBe(true);
    expect(runtime.continueQueue).toHaveBeenCalledWith("session-1");
  });

  it("leaves an unpaused queue alone (the Runtime released signal owns the wake)", async () => {
    const { flow, runtime } = createHarness({
      queueItems: [queuedItem("item-1")],
      sessionIdle: true,
    });

    await expect(flow.resumeAfterTurnTerminal()).resolves.toBe(false);
    expect(runtime.continueQueue).not.toHaveBeenCalled();
  });

  it("does nothing when the queue is paused but empty", async () => {
    const { flow, runtime } = createHarness({
      queueItems: [],
      queuePaused: true,
      sessionIdle: true,
    });

    await expect(flow.resumeAfterTurnTerminal()).resolves.toBe(false);
    expect(runtime.continueQueue).not.toHaveBeenCalled();
  });

  it("keeps the pause in place when the resume is refused", async () => {
    const { flow, runtime } = createHarness({
      queueItems: [queuedItem("item-1")],
      queuePaused: true,
      sessionIdle: true,
    });
    runtime.continueQueue.mockRejectedValueOnce(new Error("nothing to dispatch"));

    await expect(flow.resumeAfterTurnTerminal()).resolves.toBe(false);
  });

  it("does not resume while an in-process Turn still owns the chat", async () => {
    const { flow, runtime } = createHarness({
      queueItems: [queuedItem("item-1")],
      queuePaused: true,
    });

    await expect(flow.resumeAfterTurnTerminal()).resolves.toBe(false);
    expect(runtime.continueQueue).not.toHaveBeenCalled();
  });
});
