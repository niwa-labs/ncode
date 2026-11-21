import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  openV2Session,
  type V2Envelope,
  type V2ImportProgress,
  type V2ImportTarget,
} from '../../src/index.js';
import { envelopeLine, userEnvelope } from './tmp-session.js';

// R4: the import progress channel is public API. The contract pinned here:
// an opening `scan` snapshot, cadence-driven snapshots during the scan
// (every 500 records or 250 ms), one terminal `complete` snapshot, and
// honest counters — the byte cursor counts exactly, and an unobservable
// source size stays `undefined` instead of an invented total.

async function sessionWith(lines: readonly string[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'v2-import-progress-'));
  await writeFile(path.join(dir, 'messages.jsonl'), `${lines.join('\n')}\n`, 'utf8');
  return dir;
}

function collectingTarget(): { target: V2ImportTarget; envelopes: V2Envelope[] } {
  const envelopes: V2Envelope[] = [];
  return {
    target: {
      putEntry: async (envelope) => {
        envelopes.push(envelope);
      },
    },
    envelopes,
  };
}

describe('the public import progress channel', () => {
  it('opens with a scan snapshot and closes with a complete snapshot', async () => {
    const dir = await sessionWith([
      envelopeLine(userEnvelope('msg-1', 'first')),
      envelopeLine(userEnvelope('msg-2', 'second')),
    ]);
    try {
      const events: V2ImportProgress[] = [];
      const { target } = collectingTarget();
      const stats = await openV2Session(dir).importTo(target, {
        cas: null,
        onProgress: (progress) => events.push(progress),
      });

      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events[0]).toMatchObject({ phase: 'scan', recordsRead: 0, recordsDelivered: 0 });
      const last = events.at(-1)!;
      expect(last.phase).toBe('complete');
      // The terminal snapshot reports the final counters of the run.
      expect(last.recordsRead).toBe(2);
      expect(last.recordsDelivered).toBe(2);
      expect(last.sourceCursor).toBe(stats.lastLine);
      expect(last.bytesRead).toBe(stats.bytes);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('counts bytes exactly and reports the observed source size', async () => {
    const lines = [
      envelopeLine(userEnvelope('msg-1', 'first')),
      envelopeLine(userEnvelope('msg-2', 'second')),
    ];
    const dir = await sessionWith(lines);
    try {
      const events: V2ImportProgress[] = [];
      const { target } = collectingTarget();
      await openV2Session(dir).importTo(target, {
        cas: null,
        onProgress: (progress) => events.push(progress),
      });

      // The source byte length is a stat snapshot taken at the start.
      const sourceBytes = lines.map((line) => Buffer.byteLength(line, 'utf8') + 1).reduce((a, b) => a + b, 0);
      for (const event of events) {
        expect(event.totalBytes).toBe(sourceBytes);
      }
      // The byte cursor never exceeds the source and ends at it exactly.
      const cursor = events.map((event) => event.bytesRead);
      for (const value of cursor) expect(value).toBeLessThanOrEqual(sourceBytes);
      expect(events.at(-1)?.bytesRead).toBe(sourceBytes);
      // Monotonic.
      for (let index = 1; index < cursor.length; index += 1) {
        expect(cursor[index]!).toBeGreaterThanOrEqual(cursor[index - 1]!);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('emits intermediate snapshots at the 500-record trigger', async () => {
    const lines = Array.from({ length: 1200 }, (_, index) =>
      envelopeLine(userEnvelope(`msg-${String(index)}`, 'tick')),
    );
    const dir = await sessionWith(lines);
    try {
      const scanEvents: V2ImportProgress[] = [];
      const { target } = collectingTarget();
      await openV2Session(dir).importTo(target, {
        cas: null,
        onProgress: (progress) => {
          if (progress.phase === 'scan' && progress.recordsRead > 0) scanEvents.push(progress);
        },
      });

      // Records 500 and 1000 each force a snapshot besides the opener.
      expect(scanEvents.length).toBeGreaterThanOrEqual(2);
      const counts = scanEvents.map((event) => event.recordsRead);
      expect(counts).toContain(500);
      expect(counts).toContain(1000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('counts images seen and stored in the snapshots', async () => {
    const imageLine = envelopeLine({
      message_id: 'msg-image',
      turn_id: 'turn-1',
      message: { role: 'user', content: [{ type: 'image', data: 'aGVsbG8=' }] },
    });
    const dir = await sessionWith([
      envelopeLine(userEnvelope('msg-1', 'first')),
      imageLine,
      envelopeLine(userEnvelope('msg-3', 'third')),
    ]);
    try {
      const events: V2ImportProgress[] = [];
      const { target } = collectingTarget();
      const stats = await openV2Session(dir).importTo(target, {
        cas: null, // the hook is absent: every image block stays inline
        onProgress: (progress) => events.push(progress),
      });

      const last = events.at(-1)!;
      expect(last.imagesSeen).toBe(stats.imageBlocks);
      expect(last.imagesStored).toBe(stats.imagesMigrated);
      expect(last.imagesSeen).toBe(last.imagesStored + stats.imagesInline);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('counts only the resumed suffix after the cursor', async () => {
    const dir = await sessionWith([
      envelopeLine(userEnvelope('msg-1', 'first')),
      envelopeLine(userEnvelope('msg-2', 'second')),
      envelopeLine(userEnvelope('msg-3', 'third')),
    ]);
    try {
      const events: V2ImportProgress[] = [];
      const { target } = collectingTarget();
      await openV2Session(dir).importTo(target, {
        cas: null,
        resumeAfterLine: 2,
        onProgress: (progress) => events.push(progress),
      });

      const last = events.at(-1)!;
      expect(last.recordsRead).toBe(1);
      // The cursor still reports the end of the file (the next resume point).
      expect(last.sourceCursor).toBe(3);
      // The byte cursor covers the whole scan, skipped prefix included.
      expect(last.bytesRead).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails the import when the progress listener throws', async () => {
    const dir = await sessionWith([envelopeLine(userEnvelope('msg-1', 'first'))]);
    try {
      const { target } = collectingTarget();
      await expect(
        openV2Session(dir).importTo(target, {
          cas: null,
          onProgress: () => {
            throw new Error('progress listener bug');
          },
        }),
      ).rejects.toThrow('progress listener bug');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
