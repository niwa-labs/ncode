import { describe, expect, it } from "vitest";

import {
  boundWireStrings,
  fitSessionMessageViewsToWireBudget,
  servedNextCursor,
} from "../../../../src/application/session/content-application.js";
import type { MessageQueryPage } from "../../../../src/service/session-system/messages/query/query-service.js";
import type { SessionMessageView } from "@mavis/protocol";

function view(msgId: string, fill: string, duplicateInResult = true): SessionMessageView {
  return {
    msgId,
    msgContent: fill,
    role: "assistant",
    toolCalls: [
      {
        toolCallId: `call-${msgId}`,
        toolName: "bash",
        toolCallStatus: 2,
        ...(duplicateInResult
          ? { toolCallResultData: JSON.stringify({ output: fill }) }
          : {}),
      },
    ],
  };
}

describe("Session history wire budget (frame-limit safety)", () => {
  it("keeps a small page byte-for-byte unchanged", () => {
    const views = [view("m1", "x".repeat(1_000)), view("m2", "y".repeat(1_000))];
    const { views: kept, droppedCount } = fitSessionMessageViewsToWireBudget(views);
    expect(kept).toEqual(views);
    expect(droppedCount).toBe(0);
  });

  it("drops the OLDEST entries and keeps the newest suffix under the budget", () => {
    // ~700 KiB per view: under the per-entry cap (not bounded), but nine of
    // them cross the 6 MiB page budget — the drop path fires.
    const big = "z".repeat(500 * 1024);
    const views = [
      view("oldest-1", big, false),
      view("oldest-2", big, false),
      view("oldest-3", big, false),
      view("oldest-4", big, false),
      view("oldest-5", big, false),
      view("oldest-6", big, false),
      view("oldest-7", big, false),
      view("oldest-8", big, false),
      view("oldest-9", big, false),
      view("oldest-10", big, false),
      view("oldest-11", big, false),
      view("oldest-12", big, false),
      view("oldest-13", big, false),
      view("oldest-14", big, false),
      view("newest-1", big, false),
      view("newest-2", big, false),
    ];
    const { views: kept, droppedCount } = fitSessionMessageViewsToWireBudget(views);
    // The OLDEST entries were dropped; the newest suffix survived whole.
    expect(droppedCount).toBe(4);
    expect(kept.map((entry) => entry.msgId)).toEqual(views.slice(4).map((entry) => entry.msgId));
    // The kept suffix fits the budget and nothing newer was dropped.
    const keptBytes = kept.reduce(
      (total, entry) => total + Buffer.byteLength(JSON.stringify(entry), "utf8"),
      0,
    );
    expect(keptBytes).toBeLessThanOrEqual(6 * 1024 * 1024);
    // The recomputed cursor anchors at the first KEPT view, so the next
    // `before` request continues from what the client actually received —
    // the repository cursor (anchored at oldest-1) would skip kept entries.
    expect(servedNextCursor({ hasMore: true, nextCursor: "oldest-1", messages: [] }, droppedCount, kept)).toBe(
      "oldest-5",
    );
    expect(servedNextCursor({ hasMore: true, nextCursor: "oldest-1", messages: [] }, 0, views)).toBe("oldest-1");
  });

  it("bounds an oversized single view with explicit markers instead of dropping it", () => {
    // One 3 MiB view: it must survive (pagination must never get stuck), bounded.
    const giant = "q".repeat(3 * 1024 * 1024);
    const views = [view("giant", giant), view("small", "ok")];
    const { views: kept, droppedCount } = fitSessionMessageViewsToWireBudget(views);
    expect(kept.map((entry) => entry.msgId)).toEqual(["giant", "small"]);
    expect(droppedCount).toBe(0);
    const boundedResult = JSON.parse(kept[0]!.toolCalls![0]!.toolCallResultData!) as {
      wire_truncated: boolean;
      bytes: number;
    };
    expect(boundedResult.wire_truncated).toBe(true);
    expect(boundedResult.bytes).toBeGreaterThan(1024 * 1024);
    expect(Buffer.byteLength(JSON.stringify(kept[0]!), "utf8")).toBeLessThan(1024 * 1024);
  });

  it("boundWireStrings marks only oversized strings and preserves the rest", () => {
    const input = { small: "ok", list: ["a", "b".repeat(100_000)], nested: { deep: "c".repeat(70_000) } };
    const bounded = boundWireStrings(input) as {
      small: string;
      list: string[];
      nested: { deep: string };
    };
    expect(bounded.small).toBe("ok");
    expect(bounded.list[0]).toBe("a");
    const listMarker = JSON.parse(bounded.list[1]!) as { wire_truncated: boolean; bytes: number };
    expect(listMarker.wire_truncated).toBe(true);
    expect(listMarker.bytes).toBe(100_000);
    const deepMarker = JSON.parse(bounded.nested.deep) as { wire_truncated: boolean };
    expect(deepMarker.wire_truncated).toBe(true);
  });
});
