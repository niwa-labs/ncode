import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  MAX_LINE_BYTES,
  openV2Session,
  V2SessionFormatError,
  type V2Envelope,
} from '../../src/index.js';
import { envelopeLine, userEnvelope } from './tmp-session.js';

// A history line whose serialized length is exactly `total` bytes. The text
// filler is a plain ASCII character, so JSON.stringify does not escape it and
// the length is exact.
function envelopeOfSize(total: number): string {
  const base = {
    message_id: 'msg-sized',
    turn_id: '3f7d9c2e-1a4b-4c8d-9e2f-5a6b7c8d9e01',
    message: { role: 'user', content: [{ type: 'text', text: '' }] },
  };
  const overhead = JSON.stringify(base).length;
  const filler = 'y'.repeat(Math.max(0, total - overhead));
  return JSON.stringify({
    ...base,
    message: { role: 'user', content: [{ type: 'text', text: filler }] },
  });
}

async function writeRawSession(lines: readonly string[], trailingNewline = true): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'v2-giant-line-'));
  const messagesPath = path.join(dir, 'messages.jsonl');
  await writeFile(messagesPath, trailingNewline ? `${lines.join('\n')}\n` : lines.join('\n'), 'utf8');
  return messagesPath;
}

describe('giant history lines in the streaming reader', () => {
  it('caps a single line at maxLineBytes and rejects one byte more', async () => {
    const cap = 4096;
    const exact = envelopeOfSize(cap);
    expect(Buffer.byteLength(exact)).toBe(cap);

    const okPath = await writeRawSession([exact]);
    const okSession = openV2Session(path.dirname(okPath));
    const seen: V2Envelope[] = [];
    const okResult = await okSession.readEnvelopes((envelope) => {
      seen.push(envelope);
    }, { maxLineBytes: cap });
    expect(okResult.lines).toBe(1);
    expect(seen).toHaveLength(1);

    const tooBigPath = await writeRawSession([envelopeOfSize(cap + 1)]);
    const tooBigSession = openV2Session(path.dirname(tooBigPath));
    await expect(
      tooBigSession.readEnvelopes(() => {}, { maxLineBytes: cap }),
    ).rejects.toBeInstanceOf(V2SessionFormatError);
    await rm(path.dirname(tooBigPath), { recursive: true, force: true });
  });

  it('reports the oversized line without leaking its payload', async () => {
    const cap = 1024;
    const path_ = await writeRawSession([envelopeOfSize(64 * 1024)]);
    const session = openV2Session(path.dirname(path_));

    const error = await session
      .readEnvelopes(() => {}, { maxLineBytes: cap })
      .then(
        () => null,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(V2SessionFormatError);
    const message = (error as V2SessionFormatError).message;
    // The diagnostic must not embed the payload (lines hold megabytes of base64).
    expect(message).not.toContain('yyyy');
    expect(message.length).toBeLessThan(300);
    expect(message).toMatch(/line exceeds 1024 bytes/);
    await rm(path.dirname(path_), { recursive: true, force: true });
  });

  it('reports the physical line number of the oversized line, counting blank lines', async () => {
    const cap = 1024;
    const messagesPath = await writeRawSession([
      envelopeLine(userEnvelope('msg-1', 'first')),
      '',
      envelopeLine(userEnvelope('msg-2', 'second')),
      '',
      envelopeOfSize(64 * 1024),
    ]);
    const session = openV2Session(path.dirname(messagesPath));

    const error = (await session.readEnvelopes(() => {}, { maxLineBytes: cap }).then(
      () => null,
      (caught: unknown) => caught,
    )) as V2SessionFormatError;

    expect(error).toBeInstanceOf(V2SessionFormatError);
    // Physical line 5, not the record number 3.
    expect(error.lineNo).toBe(5);
    expect(error.filePath).toBe(messagesPath);
    await rm(path.dirname(messagesPath), { recursive: true, force: true });
  });

  it('delivers the records before the oversized one and never the oversized one', async () => {
    const cap = 2048;
    const messagesPath = await writeRawSession([
      envelopeLine(userEnvelope('msg-1', 'before')),
      envelopeOfSize(128 * 1024),
      envelopeLine(userEnvelope('msg-2', 'after')),
    ]);
    const session = openV2Session(path.dirname(messagesPath));

    const delivered: string[] = [];
    await expect(
      session.readEnvelopes((envelope) => {
        delivered.push(envelope.message_id);
      }, { maxLineBytes: cap }),
    ).rejects.toBeInstanceOf(V2SessionFormatError);

    expect(delivered).toEqual(['msg-1']);
    await rm(path.dirname(messagesPath), { recursive: true, force: true });
  });

  it('enforces the same cap in stats', async () => {
    const cap = 1024;
    const messagesPath = await writeRawSession([envelopeOfSize(64 * 1024)]);
    const session = openV2Session(path.dirname(messagesPath));

    await expect(session.stats({ maxLineBytes: cap })).rejects.toBeInstanceOf(V2SessionFormatError);
    // Without the cap the same file is a valid single record.
    const stats = await session.stats();
    expect(stats.lines).toBe(1);
    expect(stats.malformedLines).toBe(0);
    expect(stats.bytes).toBeGreaterThan(64 * 1024);
    await rm(path.dirname(messagesPath), { recursive: true, force: true });
  });

  it('enforces the same cap during the import and keeps the target free of the oversized record', async () => {
    const cap = 2048;
    const messagesPath = await writeRawSession([
      envelopeLine(userEnvelope('msg-1', 'before')),
      envelopeOfSize(256 * 1024),
    ]);
    const session = openV2Session(path.dirname(messagesPath));

    const imported: string[] = [];
    await expect(
      session.importTo(
        {
          putEntry: async (envelope) => {
            imported.push(envelope.message_id);
          },
        },
        { cas: null, maxLineBytes: cap },
      ),
    ).rejects.toBeInstanceOf(V2SessionFormatError);

    expect(imported).toEqual(['msg-1']);
    await rm(path.dirname(messagesPath), { recursive: true, force: true });
  });

  it('rejects an oversized last line that has no trailing newline', async () => {
    const cap = 1024;
    const messagesPath = await writeRawSession([envelopeOfSize(64 * 1024)], false);
    const session = openV2Session(path.dirname(messagesPath));

    const error = (await session.readEnvelopes(() => {}, { maxLineBytes: cap }).then(
      () => null,
      (caught: unknown) => caught,
    )) as V2SessionFormatError;

    expect(error).toBeInstanceOf(V2SessionFormatError);
    expect(error.lineNo).toBe(1);
    await rm(path.dirname(messagesPath), { recursive: true, force: true });
  });

  it('rejects an oversized line that spans many read chunks', async () => {
    // The line is far larger than a stream chunk, so the scanner has to
    // accumulate it in the carry buffer before it can reject it.
    const cap = 4096;
    const messagesPath = await writeRawSession([
      envelopeLine(userEnvelope('msg-1', 'first')),
      envelopeOfSize(3 * 1024 * 1024),
    ]);
    const session = openV2Session(path.dirname(messagesPath));

    const error = (await session.readEnvelopes(() => {}, { maxLineBytes: cap }).then(
      () => null,
      (caught: unknown) => caught,
    )) as V2SessionFormatError;

    expect(error).toBeInstanceOf(V2SessionFormatError);
    expect(error.lineNo).toBe(2);
    await rm(path.dirname(messagesPath), { recursive: true, force: true });
  });

  it('awaits an async visitor, keeping the stream in file order', async () => {
    const messagesPath = await writeRawSession([
      envelopeLine(userEnvelope('msg-1', 'one')),
      envelopeLine(userEnvelope('msg-2', 'two')),
      envelopeLine(userEnvelope('msg-3', 'three')),
    ]);
    const session = openV2Session(path.dirname(messagesPath));

    const order: string[] = [];
    const result = await session.readEnvelopes(async (envelope) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(envelope.message_id);
    });

    expect(result.lines).toBe(3);
    expect(result.skipped).toBe(0);
    expect(order).toEqual(['msg-1', 'msg-2', 'msg-3']);
    await rm(path.dirname(messagesPath), { recursive: true, force: true });
  });

  it('declares a default line cap of 64 MiB', () => {
    expect(MAX_LINE_BYTES).toBe(64 * 1024 * 1024);
  });
});
