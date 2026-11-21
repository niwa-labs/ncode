import { describe, expect, it } from "vitest";
import { SessionStreamService } from "./session-stream-service.js";

function fixture(maxItems = 2000) {
  const service = new SessionStreamService({
    messages: { listAfter: async () => ({ status: "ok", messages: [] }) },
    ring: { maxItems },
  });
  let sequence = 0;
  const write = (
    kind: "runtime-event" | "turn-terminal" = "runtime-event",
    turnId = "turn",
  ) =>
    service.write({
      sessionId: "session",
      turnId,
      identity: String(++sequence),
      kind,
      data: { sequence },
      createdAtMs: sequence,
    }).frame;
  return { service, write };
}

async function consume(source: AsyncIterable<unknown>) {
  const frames = [];
  for await (const frame of source) frames.push(frame);
  return frames;
}

describe("session stream backpressure", () => {
  it("retains a 600-frame burst while the client has no credits, including terminal", async () => {
    const { service, write } = fixture();
    const reservation = service.reserve("session");
    reservation.bindTurn("turn");
    const expected = Array.from({ length: 600 }, () => write());
    expected.push(write("turn-terminal"));
    reservation.complete();
    expect(await consume(reservation.source)).toEqual(expected);
    service.dispose();
  });

  it("resumes after a cursor and catches live bursts without duplicates", async () => {
    const { service, write } = fixture();
    const anchor = write();
    const first = write();
    const resumed = service.resume({
      sessionId: "session",
      afterCursor: anchor.cursor,
    });
    expect((await resumed.next()).value).toEqual(first);
    const expected = Array.from({ length: 400 }, () => write());
    expected.push(write("turn-terminal"));
    expect(await consume(resumed)).toEqual(expected);
    service.dispose();
  });

  it("returns explicit resync when a paused live reader falls behind retention", async () => {
    const { service, write } = fixture(3);
    const reserved = service.reserve("session");
    for (let i = 0; i < 10; i++) write();
    expect((await reserved.source.next()).value).toMatchObject({
      kind: "resync-required",
      data: { reason: "evicted" },
    });
    expect((await reserved.source.next()).done).toBe(true);
    service.dispose();
  });

  it("wakes a pending reader on retention overflow without throwing", async () => {
    const { service, write } = fixture(1);
    const reserved = service.reserve("session");
    const pending = reserved.source.next();
    const first = write();
    for (let i = 0; i < 10; i++) write();
    expect((await pending).value).toEqual(first);
    expect((await reserved.source.next()).value.kind).toBe("resync-required");
    reserved.close();
    service.dispose();
  });

  it("completion drains only the captured turn and never the next one", async () => {
    const { service, write } = fixture();
    const reserved = service.reserve("session");
    reserved.bindTurn("turn");
    write("runtime-event", "other");
    const expected = write();
    reserved.complete();
    write("runtime-event", "next");
    expect(await consume(reserved.source)).toEqual([expected]);
    service.dispose();
  });

  it("closing the session wakes pending readers", async () => {
    const { service } = fixture();
    const reserved = service.reserve("session");
    const pending = reserved.source.next();
    service.deleteSession("session");
    expect((await pending).done).toBe(true);
  });
});
