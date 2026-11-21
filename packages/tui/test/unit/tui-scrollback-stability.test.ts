/**
 * Ported from fork/main (`packages/tui/test/unit/tui-scrollback-stability.test.ts`,
 * introduced by fix(tui) #390) — revision 11 F5, the only master file missing
 * from this branch.
 *
 * Deliberate adaptation, not a verbatim port. This branch's history:
 * - 1e136bfd (#390, master) added this suite pinning its native-history and
 *   overlay-diff stabilization mechanics;
 * - 3d369f51 (#396, branch-only) REVERTED #390/#389 "to restore the TUI
 *   scrollback baseline" and deleted this suite together with the mechanism;
 * - c08148e6 (#416, branch-only) re-solved regular-mode history stability with
 *   a different design (append-only final rows, takeDiscardedRows rebasing,
 *   live rows kept in-screen) and covered it in tui-app.test.ts ("regular-mode
 *   native history during a live run") and tui-engine-local-deltas.test.ts.
 *
 * This file therefore RETAINS only the #390 scenarios whose contracts this
 * branch still honors today (they pass against the current engine and guard
 * them against regression). The scenarios pinning the reverted #390/#416-
 * superseded mechanics are intentionally absent; porting them would fail and
 * misrepresent the branch's product contract:
 * - rolling-projection retention and bounded turn-window eviction archival
 *   (the branch drops far-above-screen rows and does not archive evicted
 *   turns into native scrollback; covered by tui-app.test.ts live-run suite);
 * - anchor/render-state restoration across mode switches and the overlay
 *   width-reflow / "── Transcript refreshed" boundary mechanics (the marker
 *   does not exist in this branch's engine);
 * - overlay differential output byte-economy and IME cursor moves (#390's
 *   overlay diff stabilization was reverted wholesale; covered by
 *   tui-engine-local-deltas.test.ts frame-delta suites);
 * - welcome-header live status flips (the branch made the welcome banner
 *   static in #416; action notices moved above the Composer);
 * - native-history image retention across resize and live-resize retention
 *   with a started renderer (rebuilt by #416).
 */

import { describe, expect, it, vi } from "vitest";
import {
  CURSOR_MARKER,
  TuiMainScreen,
  type Component,
} from "../../src/tui/engine/public.js";
import { McodeInteractiveRenderer } from "../../src/tui/renderer/interactive-renderer.js";
import { TuiChatLayout } from "../../src/tui/shell/chat-layout.js";
import { TuiTaskPanel } from "../../src/tui/shell/task-panel.js";
import { createTranscriptCell } from "../../src/tui/transcript/model.js";
import { TranscriptStore } from "../../src/tui/transcript/store.js";
import { TranscriptVisibilityProjection } from "../../src/tui/transcript/presentation/visibility.js";
import { TranscriptView } from "../../src/tui/transcript/view.js";
import { VirtualTerminal } from "../pi-084-upstream/virtual-terminal.js";

class RecordingTerminal extends VirtualTerminal {
  private writes: string[] = [];
  override write(data: string): void {
    this.writes.push(data);
    super.write(data);
  }
  override hideCursor(): void {
    this.write("\x1b[?25l");
  }
  override showCursor(): void {
    this.write("\x1b[?25h");
  }
  takeWrites(): string {
    const result = this.writes.join("");
    this.writes = [];
    return result;
  }
}

class ClearToScrollbackTerminal extends RecordingTerminal {
  override write(data: string): void {
    super.write(
      data.replaceAll(
        "\x1b[2J",
        `\x1b[${this.rows};1H${"\r\n".repeat(this.rows)}\x1b[2J`,
      ),
    );
  }
}

class Lines implements Component {
  constructor(public lines: string[] = []) {}
  render(): string[] {
    return [...this.lines];
  }
  invalidate(): void {}
}

function fixture(
  terminal: RecordingTerminal,
  options: ConstructorParameters<typeof TranscriptView>[1] = {},
) {
  const store = new TranscriptStore();
  const view = new TranscriptView(
    new TranscriptVisibilityProjection(store),
    options,
  );
  const tasks = new TuiTaskPanel();
  const activity = new Lines(["Running"]);
  const tui = new TuiMainScreen(terminal);
  const empty = new Lines();
  const welcome = new Lines(["WELCOME"]);
  const composer = new Lines([`composer${CURSOR_MARKER}`]);
  const layout = new TuiChatLayout(terminal, {
    surface: () => "conversation",
    welcome,
    transcript: view,
    interaction: empty,
    activity,
    tasks,
    followUp: empty,
    composer,
    status: new Lines(["status"]),
  });
  tui.addChild(layout);
  const render = async () => {
    tui.renderNow();
    await terminal.flush();
    return terminal.takeWrites();
  };
  return {
    terminal,
    store,
    view,
    tasks,
    activity,
    tui,
    layout,
    welcome,
    composer,
    render,
  };
}

function step(index: number, title = "Bash", turnId = "long-turn") {
  return createTranscriptCell({
    id: `step-${index}`,
    turnId,
    kind: "tool",
    title,
    content:
      title === "Read"
        ? `src/STEP_${String(index).padStart(3, "0")}.ts`
        : `echo STEP_${String(index).padStart(3, "0")}`,
    status: "succeeded",
    createdAtMs: index,
    displayMode: "expanded",
  });
}

function expectNoReplay(output: string): void {
  expect(output).not.toContain("\x1b[3J");
  expect(output).not.toContain("\x1b[2J");
  expect(output).not.toContain("WELCOME");
  expect(output).not.toContain("Transcript refreshed");
}

async function seedShell(terminal: RecordingTerminal): Promise<void> {
  terminal.write(`SHELL_HISTORY_SENTINEL\r\n${"shell line\r\n".repeat(50)}`);
  await terminal.flush();
  terminal.takeWrites();
}

describe.each([
  ["xterm", RecordingTerminal],
  ["clear-to-scrollback host", ClearToScrollbackTerminal],
] as const)("%s regular scrollback stability", (_name, Terminal) => {
  // The rolling-projection and turn-window-eviction siblings of this suite pin
  // the reverted #390 archival mechanics and live in the branch's replacement
  // coverage (see the file header); the expanded-Todo stability contract below
  // is honored by the current engine on both terminal flavors.
  it.each([18, 44])(
    "keeps shell history and cursor stable when expanded Todo finishes in %i rows",
    async (rows) => {
      const f = fixture(new Terminal(100, rows));
      await seedShell(f.terminal);
      for (let i = 0; i < 100; i++) f.store.upsert(step(i));
      const items = Array.from({ length: 11 }, (_, i) => ({
        content: `Task ${i}`,
        status: "in_progress" as const,
      }));
      f.tasks.setItems(items);
      f.tasks.toggleExpanded();
      await f.render();
      f.terminal.scrollLines(-10);
      const before = f.terminal.getScrollPosition().viewport;
      f.tasks.setItems(items.map((item) => ({ ...item, status: "completed" })));
      expectNoReplay(await f.render());
      expect(f.terminal.getScrollPosition().viewport).toBe(before);
      expect(f.terminal.getScrollBuffer()).toContain("SHELL_HISTORY_SENTINEL");
      f.terminal.scrollLines(10000);
      expect(
        f.terminal
          .getViewport()
          .slice(-3)
          .map((line) => line.trim()),
      ).toEqual(["Running", "composer", "status"]);
      expect(f.terminal.getCursorPosition().y).toBe(rows - 2);
      for (let i = 100; i < 120; i++) {
        f.store.upsert(step(i));
        expectNoReplay(await f.render());
      }
      const history = f.terminal.getScrollBuffer();
      for (let i = 0; i < 120; i++) {
        expect(
          history.filter((line) =>
            line.includes(`STEP_${String(i).padStart(3, "0")}`),
          ),
        ).toHaveLength(1);
      }
    },
  );
});

describe("regular renderer boundary regressions", () => {
  it("idle render with footer taller than screen produces no output growth", async () => {
    const f = fixture(new RecordingTerminal(100, 8));
    for (let i = 0; i < 100; i++) f.store.upsert(step(i));
    f.tasks.setItems(
      Array.from({ length: 11 }, (_, i) => ({
        content: `Task ${i}`,
        status: "in_progress" as const,
      })),
    );
    f.tasks.toggleExpanded();
    await f.render();
    const before = f.terminal.getScrollBuffer();
    const output = await f.render();
    const after = f.terminal.getScrollBuffer();
    expect(after).toEqual(before);
  });

  // Only the not-yet-started renderer variant pins a contract this branch
  // honors; the started-renderer variant pins #390's live-resize retention
  // that #396 reverted (replacement coverage: tui-engine-local-deltas.test.ts
  // rebuild/replay suites).
  it("preserves output arriving during resize (live resize callback: false)", async () => {
    const f = fixture(new RecordingTerminal(100, 24));
    for (let i = 0; i < 40; i++) f.store.upsert(step(i));
    await f.render();
    f.terminal.resize(90, 12);
    for (let i = 40; i < 80; i++) f.store.upsert(step(i));
    await f.render();
    const history = f.terminal.getScrollBuffer();
    for (let i = 0; i < 80; i++)
      expect(
        history.filter((line) =>
          line.includes(`STEP_${String(i).padStart(3, "0")}`),
        ),
        `step ${i}`,
      ).toHaveLength(1);
  });

  it("keeps step output across changing oversized footers", async () => {
    const f = fixture(new RecordingTerminal(100, 24));
    for (let i = 0; i < 80; i++) f.store.upsert(step(i));
    f.tasks.toggleExpanded();
    await f.render();
    let total = 80;
    for (const count of [30, 5, 35, 0, 24, 10, 45, 1, 30]) {
      f.tasks.setItems(
        Array.from({ length: count }, (_, i) => ({
          content: `Task ${i}`,
          status: "in_progress" as const,
        })),
      );
      await f.render();
      f.store.upsert(step(total++));
      await f.render();
      const history = f.terminal.getScrollBuffer();
      for (let i = 0; i < total; i++)
        expect(
          history.filter((line) =>
            line.includes(`STEP_${String(i).padStart(3, "0")}`),
          ),
          `count ${count} step ${i}`,
        ).toHaveLength(1);
    }
  });
});

describe("projection gaps and retained images", () => {
  it("does not replay historical images when only text footer collapses", async () => {
    const terminal = new RecordingTerminal(100, 24);
    const tui = new TuiMainScreen(terminal);
    const body = [
      "\x1b_Ga=T,f=100,i=42,r=1;PNGDATA\x1b\\",
      ...Array.from({ length: 60 }, (_, i) => `Body ${i}`),
    ];
    let footer = [
      ...Array.from({ length: 10 }, (_, i) => `Activity ${i}`),
      `composer${CURSOR_MARKER}`,
      "status",
    ];
    const component = {
      render: () => [...body, ...footer],
      invalidate: () => {},
      getScrollbackLayout: () => ({
        bodyEnd: body.length,
        anchors: body.map((_, row) => ({ id: `body-${row}`, row })),
      }),
    };
    tui.addChild(component);
    tui.renderNow();
    await terminal.flush();
    terminal.takeWrites();
    footer = [`composer${CURSOR_MARKER}`, "status"];
    tui.renderNow();
    await terminal.flush();
    const output = terminal.takeWrites();
    expect(output).not.toContain("Transcript refreshed");
    expect(
      terminal.getScrollBuffer().filter((line) => line === "Body 0"),
    ).toHaveLength(1);
  });
});

describe("settled thinking", () => {
  it("does not replay history when a retained thinking preview collapses across the viewport boundary", async () => {
    const f = fixture(new RecordingTerminal(100, 18));
    for (let i = 0; i < 50; i++)
      f.store.upsert(
        createTranscriptCell({
          id: `history-${i}`,
          turnId: "turn",
          kind: "assistant",
          status: "succeeded",
          content: `History ${i}`,
          createdAtMs: i,
        }),
      );
    const thinking = createTranscriptCell({
      id: "thinking",
      turnId: "turn",
      kind: "thinking",
      status: "running",
      content: "First thought\nSecond thought\nThird thought\nFourth thought",
      createdAtMs: 51,
    });
    f.store.upsert(thinking);
    f.tasks.setItems(
      Array.from({ length: 11 }, (_, i) => ({
        content: `Task ${i}`,
        status: "in_progress" as const,
      })),
    );
    f.tasks.toggleExpanded();
    await f.render();
    f.store.upsert({
      ...thinking,
      status: "succeeded",
      updatedAtMs: 1001,
      durationMs: 1000,
    });
    expectNoReplay(await f.render());
    for (let i = 0; i < 50; i++)
      expect(
        f.terminal
          .getScrollBuffer()
          .filter((line) => line.trim() === `● History ${i}`),
      ).toHaveLength(1);
  });
});

describe("transient transcript cleanup", () => {
  it("does not replay history when the previous turn duration is removed", async () => {
    const f = fixture(new RecordingTerminal(100, 24));
    for (let i = 0; i < 80; i++) f.store.upsert(step(i));
    f.store.upsert(
      createTranscriptCell({
        id: "turn-duration:long-turn",
        turnId: "long-turn",
        kind: "turn-duration",
        ephemeral: true,
        status: "succeeded",
        durationMs: 1000,
        content: "",
        createdAtMs: 90,
      }),
    );
    await f.render();
    f.store.remove("turn-duration:long-turn");
    f.store.upsert(
      createTranscriptCell({
        id: "new-request",
        turnId: "new-turn",
        kind: "user",
        status: "succeeded",
        content: "Next request",
        createdAtMs: 91,
      }),
    );
    const output = await f.render();
    expectNoReplay(output);
  });
});

describe("isolated regular overlays", () => {
  it("does not treat a forced first overlay frame as a width reflow", async () => {
    const f = fixture(new RecordingTerminal(100, 24));
    for (let i = 0; i < 60; i++) f.store.upsert(step(i));
    await f.render();
    const before = f.terminal.getScrollBuffer();
    const overlay = f.tui.showOverlay(new Lines(["TRANSIENT_PANEL"]));
    f.tui.renderNow(true);
    await f.terminal.flush();
    f.terminal.takeWrites();
    overlay.hide();
    expectNoReplay(await f.render());
    expect(f.terminal.getScrollBuffer()).toEqual(before);
  });
});

describe("isolated overlay differential output", () => {
  // Same shape as the master suite's panelFixture; only the forced-repaint
  // scenario is retained — the other differential-output scenarios pin the
  // reverted #390 overlay diff stabilization (see the file header).
  function panelFixture() {
    const terminal = new RecordingTerminal(100, 30);
    const f = fixture(terminal);
    const panel = new Lines(
      Array.from(
        { length: 30 },
        (_, row) => `PANEL_ROW_${row} ${"x".repeat(80)}`,
      ),
    );
    const show = () =>
      f.tui.showOverlay(panel, {
        width: "100%",
        maxHeight: "100%",
        row: 0,
        col: 0,
      });
    return { ...f, panel, show };
  }

  it("invalidates cached rows for a forced repaint", async () => {
    const f = panelFixture();
    f.show();
    await f.render();
    f.terminal.write("\x1b[2J");
    await f.terminal.flush();
    f.terminal.takeWrites();
    f.tui.renderNow(true);
    await f.terminal.flush();
    expect(f.terminal.getViewport().map((line) => line.trimEnd())).toEqual(
      f.panel.lines,
    );
    expect(f.terminal.takeWrites()).toContain("PANEL_ROW_29");
  });
});

describe("background updates while welcome occupies native history", () => {
  // Only the footer-completion variant is retained: the header-status variant
  // pins the pre-#416 mutable welcome badge, which this branch replaced with a
  // static banner and Composer-adjacent notices.
  it("does not replay the welcome and warnings after footer completion changes without input", async () => {
    const f = fixture(new RecordingTerminal(100, 24));
    f.welcome.lines = Array.from(
      { length: 24 },
      (_, row) => `WELCOME_${row}`,
    );
    f.composer.lines = ["draft line", `composer${CURSOR_MARKER}`];
    for (let i = 0; i < 4; i++)
      f.store.upsert(
        createTranscriptCell({
          id: `warning-${i}`,
          kind: "warning",
          status: "succeeded",
          content:
            "Content review did not return a usable result, so this response stopped. Unreviewed output was withheld. Retry; if this persists, use /feedback to report the review failure.",
          createdAtMs: i,
        }),
      );
    await f.render();
    f.terminal.scrollLines(-5);
    const before = f.terminal.getScrollPosition().viewport;
    f.composer.lines = [`composer${CURSOR_MARKER}`];
    expectNoReplay(await f.render());
    expect(f.terminal.getScrollPosition().viewport).toBe(before);
    const history = f.terminal.getScrollBuffer();
    expect(history.filter((line) => line.includes("WELCOME_0"))).toHaveLength(
      1,
    );
    expect(
      history.filter((line) => line.includes("Content review")),
    ).toHaveLength(4);
    expectNoReplay(await f.render());
  });
});

describe("main-buffer geometry across deferred frames", () => {
  // Only the same-height restore variant survives on this branch: returning to
  // regular mode with a DIFFERENT height re-frames the screen here (see the
  // file header); the other variants of the master suite pin the reverted
  // #390 held-frame retention.
  it("preserves inactive main history after fullscreen resize 24 -> 8 -> 24 rows", async () => {
    const terminal = new RecordingTerminal(100, 24);
    const f = fixture(terminal);
    const owner = new McodeInteractiveRenderer({ terminal });
    owner.ui.addChild(f.layout);
    for (let i = 0; i < 80; i++) f.store.upsert(step(i));
    owner.start();
    const render = async () => {
      owner.ui.renderNow();
      await terminal.flush();
    };
    try {
      await render();
      owner.switchMode("fullscreen");
      await render();
      terminal.resize(100, 8);
      await render();
      terminal.resize(100, 24);
      await render();
      terminal.takeWrites();
      owner.switchMode("regular");
      await render();
      expectNoReplay(terminal.takeWrites());
      const history = terminal.getScrollBuffer();
      for (let i = 0; i < 80; i++) {
        const token = `STEP_${String(i).padStart(3, "0")}`;
        expect(
          history.filter((line) => line.includes(token)),
          token,
        ).toHaveLength(1);
      }
      expect(terminal.getViewport().join("\n")).toContain("composer");
    } finally {
      owner.stop();
    }
  });
});

describe("mode switch with a pending main frame", () => {
  it("captures main state after stop flushes pending resized output", async () => {
    class HeldTerminal extends RecordingTerminal {
      outputPending = false;
      release: (() => void) | undefined;
      drainOutput(): Promise<void> {
        return new Promise((resolve) => {
          this.release = resolve;
        });
      }
    }
    const terminal = new HeldTerminal(100, 24);
    const f = fixture(terminal);
    const owner = new McodeInteractiveRenderer({ terminal });
    owner.ui.addChild(f.layout);
    for (let i = 0; i < 80; i++) f.store.upsert(step(i));
    owner.start();
    const render = async () => {
      owner.ui.renderNow();
      await terminal.flush();
    };
    try {
      await render();
      terminal.outputPending = true;
      terminal.resize(100, 12);
      for (let i = 80; i < 90; i++) f.store.upsert(step(i));
      owner.switchMode("fullscreen");
      await render();
      terminal.outputPending = false;
      terminal.release?.();
      await render();
      owner.switchMode("regular");
      await render();
      const history = terminal.getScrollBuffer();
      for (let i = 0; i < 90; i++) {
        const token = `STEP_${String(i).padStart(3, "0")}`;
        expect(
          history.filter((line) => line.includes(token)),
          token,
        ).toHaveLength(1);
      }
    } finally {
      terminal.outputPending = false;
      terminal.release?.();
      owner.stop();
    }
  });
});


describe("transcript cache and long mutable blocks", () => {
  it("keeps transcript width stable while fullscreen footer and spinner update", async () => {
    const terminal = new RecordingTerminal(100, 24);
    const f = fixture(terminal);
    for (let i = 0; i < 40; i++) f.store.upsert(step(i));
    const renderTranscript = vi.spyOn(f.view, "render");
    const owner = new McodeInteractiveRenderer({ terminal, initialMode: "fullscreen",
      fullscreenLayoutRoot: f.layout.fullscreenLayoutRoot });
    owner.start();
    try {
      for (let i = 0; i < 5; i++) {
        f.activity.lines = [`Running ${i}`];
        owner.ui.renderNow();
        await terminal.flush();
      }
      expect(new Set(renderTranscript.mock.calls.map(([width]) => width)).size).toBe(1);
      expect(f.view.getPerformanceSnapshot()).toMatchObject({ frameCacheHit: true,
        renderedUnits: 0, unitCacheMisses: 0 });
      f.store.upsert(step(41));
      owner.ui.renderNow();
      await terminal.flush();
      expect(f.view.getPerformanceSnapshot().unitCacheHits).toBeGreaterThan(0);
    } finally { owner.stop(); }
  });

  it("writes every row of an unfinished code fence to native scrollback", async () => {
    const terminal = new RecordingTerminal(80, 16);
    const f = fixture(terminal, { appendOnly: () => true });
    const content = (count: number) => "```text\n" + Array.from({length: count}, (_, i) =>
      `SCROLL_ROW_${String(i).padStart(3, "0")}`).join("\n");
    f.store.upsert(createTranscriptCell({ id: "long", turnId: "turn", kind: "assistant",
      status: "running", content: content(40), createdAtMs: 1 }));
    await f.render();
    for (let count = 60; count <= 100; count += 20) {
      f.store.upsert({ id: "long", content: content(count), updatedAtMs: count });
      await f.render();
    }
    for (let i = 0; i < 100; i++) {
      const token = `SCROLL_ROW_${String(i).padStart(3, "0")}`;
      expect(terminal.getScrollBuffer().filter((line) => line.includes(token))).toHaveLength(1);
    }
    terminal.scrollLines(-30);
    expect(terminal.getViewport().join("\n")).toContain("SCROLL_ROW_");
    f.store.upsert({ id: "long", status: "succeeded", content: content(100) + "\n```" });
    await f.render();
    for (let i = 0; i < 100; i++) {
      expect(terminal.getScrollBuffer().filter((line) =>
        line.includes(`SCROLL_ROW_${String(i).padStart(3, "0")}`))).toHaveLength(1);
    }
  });
});
