import { describe, expect, it } from "vitest";

import type { TuiBackgroundTask } from "../../src/runtime/port.js";
import { TuiTaskPanel } from "../../src/tui/shell/task-panel.js";

/**
 * The composer-adjacent work bar (owner bug 2026-11-06): a subagent promoted
 * foreground→background is a background task of the session and must be
 * counted by the bar's "N background active" line; terminal rows follow the
 * existing summary rules (visible until their notice is delivered).
 */

function task(overrides: Partial<TuiBackgroundTask> = {}): TuiBackgroundTask {
  return {
    taskId: "bg-promoted",
    kind: "subagent",
    status: "running",
    ownerSessionId: "root",
    description: "Long child",
    createdAtMs: 100,
    updatedAtMs: 200,
    startedAtMs: 120,
    ...overrides,
  };
}

function renderBarLine(tasks: readonly TuiBackgroundTask[]): string {
  const panel = new TuiTaskPanel();
  panel.setBackgroundTasks(tasks);
  return panel.render(120).join("\n");
}

describe("TuiTaskPanel work summary with subagent background tasks", () => {
  it("counts a promoted running subagent as background active", () => {
    expect(renderBarLine([task()])).toContain("1 background active");
  });

  it("keeps an undelivered terminal subagent visible as a ready result", () => {
    const line = renderBarLine([
      task({ status: "succeeded", endedAtMs: 300, updatedAtMs: 300 }),
    ]);
    expect(line).toContain("1 result ready");
    expect(line).not.toContain("background active");
  });

  it("drops a delivered terminal subagent per the existing summary rules", () => {
    expect(
      renderBarLine([
        task({
          status: "succeeded",
          endedAtMs: 300,
          updatedAtMs: 300,
          deliveredAtMs: 320,
        }),
      ]),
    ).toBe("");
  });

  it("renders bash rows exactly as before", () => {
    const line = renderBarLine([
      {
        taskId: "bg-bash",
        kind: "bash",
        status: "running",
        ownerSessionId: "root",
        description: "pnpm test",
        command: "pnpm test",
        createdAtMs: 100,
        updatedAtMs: 200,
      },
    ]);
    expect(line).toContain("1 background active");
  });
});
