import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  openV2Session,
  V2SessionFormatError,
  type V2Envelope,
  type V2ImportTarget,
} from '../../src/index.js';
import { envelopeLine, userEnvelope } from './tmp-session.js';

// The resume cursor, the malformed-line policy and the batch delivery are the
// three contract surfaces of the streaming import that no other suite pins:
// the counters they produce are what a caller uses to decide whether the
// import can be resumed (`lastLine`), whether the history is trustworthy
// (`skipped` / `malformedLines`) and whether the target saw every record
// (`putEntries` batches).

async function sessionWith(lines: readonly string[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'v2-import-resume-'));
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

/** Four canonical records with stable message ids. */
function fourRecords(): string[] {
  return [
    envelopeLine(userEnvelope('msg-1', 'first')),
    envelopeLine(userEnvelope('msg-2', 'second')),
    envelopeLine(userEnvelope('msg-3', 'third')),
    envelopeLine(userEnvelope('msg-4', 'fourth')),
  ];
}

describe('the resume cursor', () => {
  it('delivers only the records after the cursor', async () => {
    const dir = await sessionWith(fourRecords());
    try {
      const { target, envelopes } = collectingTarget();
      const stats = await openV2Session(dir).importTo(target, { resumeAfterLine: 2, cas: null });

      expect(envelopes.map((envelope) => envelope.message_id)).toEqual(['msg-3', 'msg-4']);
      // `lines` counts the records CONSUMED by this run...
      expect(stats.lines).toBe(2);
      expect(stats.envelopes).toBe(2);
      // ...while `lastLine` is the cursor for the NEXT run: the last record
      // SEEN, including the ones the cursor skipped.
      expect(stats.lastLine).toBe(4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('resumes exactly where the previous run stopped', async () => {
    const dir = await sessionWith(fourRecords());
    try {
      const session = openV2Session(dir);
      const first = collectingTarget();
      const firstStats = await session.importTo(first.target, { cas: null });
      expect(first.envelopes).toHaveLength(4);
      expect(firstStats.lastLine).toBe(4);

      // A second run with the cursor of the first one imports nothing new.
      const second = collectingTarget();
      const secondStats = await session.importTo(second.target, {
        resumeAfterLine: firstStats.lastLine,
        cas: null,
      });
      expect(second.envelopes).toHaveLength(0);
      expect(secondStats.lines).toBe(0);
      expect(secondStats.envelopes).toBe(0);
      // The cursor still points at the end of the file.
      expect(secondStats.lastLine).toBe(4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('consumes nothing when the cursor is past the end of the file', async () => {
    const dir = await sessionWith(fourRecords());
    try {
      const { target, envelopes } = collectingTarget();
      const stats = await openV2Session(dir).importTo(target, { resumeAfterLine: 99, cas: null });

      expect(envelopes).toHaveLength(0);
      expect(stats.lines).toBe(0);
      expect(stats.envelopes).toBe(0);
      expect(stats.lastLine).toBe(4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('delivers everything when the cursor is zero', async () => {
    const dir = await sessionWith(fourRecords());
    try {
      const { target, envelopes } = collectingTarget();
      const stats = await openV2Session(dir).importTo(target, { resumeAfterLine: 0, cas: null });

      expect(envelopes.map((envelope) => envelope.message_id)).toEqual([
        'msg-1',
        'msg-2',
        'msg-3',
        'msg-4',
      ]);
      expect(stats.lines).toBe(4);
      expect(stats.lastLine).toBe(4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('counts the image blocks of the resumed part only', async () => {
    const imageLine = envelopeLine({
      message_id: 'msg-image',
      turn_id: 'turn-1',
      message: { role: 'user', content: [{ type: 'image', data: 'aGVsbG8=' }] },
    });
    const dir = await sessionWith([
      imageLine,
      envelopeLine(userEnvelope('msg-2', 'second')),
      envelopeLine(userEnvelope('msg-3', 'third')),
    ]);
    try {
      const { target } = collectingTarget();
      const stats = await openV2Session(dir).importTo(target, { resumeAfterLine: 1, cas: null });

      // The image block sits BEFORE the cursor: it was already imported.
      expect(stats.imageBlocks).toBe(0);
      expect(stats.imagesMigrated).toBe(0);
      expect(stats.imagesInline).toBe(0);
      expect(stats.imageBlocks).toBe(stats.imagesMigrated + stats.imagesInline);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the malformed-line policy', () => {
  it('skips the broken lines and keeps the good ones', async () => {
    const dir = await sessionWith([
      envelopeLine(userEnvelope('msg-1', 'first')),
      'not-json-at-all',
      envelopeLine(userEnvelope('msg-3', 'third')),
    ]);
    try {
      const errors: V2SessionFormatError[] = [];
      const delivered: string[] = [];
      const result = await openV2Session(dir).readEnvelopes(
        (envelope) => {
          delivered.push(envelope.message_id);
        },
        {
          formatErrors: 'skip',
          onFormatError: (error) => errors.push(error),
        },
      );

      expect(delivered).toEqual(['msg-1', 'msg-3']);
      expect(result.lines).toBe(2);
      expect(result.skipped).toBe(1);
      // The diagnostic points at the physical line of the broken record.
      expect(errors).toHaveLength(1);
      expect(errors[0]!.lineNo).toBe(2);
      expect(errors[0]!.message).toContain('invalid JSON');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports every broken line and never the payload', async () => {
    const junk = `not-json-${'x'.repeat(2048)}`;
    const dir = await sessionWith([junk, junk]);
    try {
      const errors: V2SessionFormatError[] = [];
      const result = await openV2Session(dir).readEnvelopes(
        () => {},
        { formatErrors: 'skip', onFormatError: (error) => errors.push(error) },
      );

      expect(result.lines).toBe(0);
      expect(result.skipped).toBe(2);
      expect(errors.map((error) => error.lineNo)).toEqual([1, 2]);
      for (const error of errors) expect(error.message).not.toContain('xxxx');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('counts the broken lines in stats and hides them without validation', async () => {
    const dir = await sessionWith([
      envelopeLine(userEnvelope('msg-1', 'first')),
      '{"message_id":',
      envelopeLine(userEnvelope('msg-3', 'third')),
    ]);
    try {
      const session = openV2Session(dir);

      const validated = await session.stats();
      expect(validated.lines).toBe(3);
      expect(validated.malformedLines).toBe(1);

      // Without validation the scan still counts the lines, but nothing is
      // decoded, so nothing can be malformed.
      const cheap = await session.stats({ validate: false });
      expect(cheap.lines).toBe(3);
      expect(cheap.malformedLines).toBe(0);
      expect(cheap.bytes).toBe(validated.bytes);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects the whole read in the default strict mode', async () => {
    const dir = await sessionWith([
      envelopeLine(userEnvelope('msg-1', 'first')),
      'not-json-at-all',
    ]);
    try {
      const error = await openV2Session(dir)
        .readEnvelopes(() => {})
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );
      expect(error).toBeInstanceOf(V2SessionFormatError);
      expect((error as V2SessionFormatError).lineNo).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('batch delivery through putEntries', () => {
  it('delivers the records in ordered batches and never calls putEntry', async () => {
    const dir = await sessionWith(fourRecords());
    try {
      const batches: string[][] = [];
      let putEntryCalls = 0;
      const stats = await openV2Session(dir).importTo(
        {
          putEntry: async () => {
            putEntryCalls += 1;
          },
          putEntries: async (envelopes) => {
            batches.push(envelopes.map((envelope) => envelope.message_id));
          },
        },
        { cas: null, batchSize: 2 },
      );

      expect(batches).toEqual([['msg-1', 'msg-2'], ['msg-3', 'msg-4']]);
      // A target that opted into batches never sees the per-envelope sink.
      expect(putEntryCalls).toBe(0);
      expect(stats.envelopes).toBe(4);
      expect(stats.lines).toBe(4);
      expect(stats.lastLine).toBe(4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('delivers the trailing partial batch', async () => {
    const dir = await sessionWith(fourRecords());
    try {
      const batches: number[] = [];
      await openV2Session(dir).importTo(
        {
          putEntry: async () => {},
          putEntries: async (envelopes) => {
            batches.push(envelopes.length);
          },
        },
        { cas: null, batchSize: 3 },
      );

      // 4 records with a batch size of 3: one full batch and one remainder.
      expect(batches).toEqual([3, 1]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('treats a batch size below one as one', async () => {
    const dir = await sessionWith(fourRecords());
    try {
      const batches: number[] = [];
      await openV2Session(dir).importTo(
        {
          putEntry: async () => {},
          putEntries: async (envelopes) => {
            batches.push(envelopes.length);
          },
        },
        { cas: null, batchSize: 0 },
      );

      expect(batches).toEqual([1, 1, 1, 1]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('counts the image blocks of the batched import exactly like the per-envelope import', async () => {
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
      const session = openV2Session(dir);

      const perEnvelope = collectingTarget();
      const perEnvelopeStats = await session.importTo(perEnvelope.target, { cas: null });

      const batches: number[] = [];
      const batchedStats = await session.importTo(
        {
          putEntry: async () => {},
          putEntries: async (envelopes) => {
            batches.push(envelopes.length);
          },
        },
        { cas: null, batchSize: 2 },
      );

      expect(batches).toEqual([2, 1]);
      expect(batchedStats.imageBlocks).toBe(perEnvelopeStats.imageBlocks);
      expect(batchedStats.imagesMigrated).toBe(perEnvelopeStats.imagesMigrated);
      expect(batchedStats.imagesInline).toBe(perEnvelopeStats.imagesInline);
      expect(batchedStats.imageBlocks).toBe(
        batchedStats.imagesMigrated + batchedStats.imagesInline,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
