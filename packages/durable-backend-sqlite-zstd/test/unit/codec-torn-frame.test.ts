/**
 * Torn-frame decoding.
 *
 * The envelope must reject every shape of a partially written frame BEFORE a
 * single decompressed byte is handed out, and the error must say WHY the
 * frame was refused. `codec.test.ts` covers the happy path and byte-level
 * corruption of a stored frame; this file pins the envelope bookkeeping
 * itself — declared lengths, codec ids, legacy envelopes, output budget, and
 * the byte-array shapes a reader may hand to `decodeFrame`.
 *
 * Every assertion is on the verdict (error class + reason), never on "it
 * threw something".
 */

import { describe, expect, it } from 'vitest';

import { decodeFrame, encodeFrame, peekFrameUncompressedLength } from '../../src/codec.js';
import { CorruptFrameError } from '../../src/errors.js';

/** Envelope layout: 'MZS2' (4) | codec id (1) | frame length (8) | uncompressed length (8). */
const MAGIC_LENGTH = 4;
const HEADER_LENGTH = 21;
const FRAME_LENGTH_OFFSET = MAGIC_LENGTH + 1;
const UNCOMPRESSED_LENGTH_OFFSET = FRAME_LENGTH_OFFSET + 8;

/** The codec id byte the envelope carries for a given codec name. */
function codecIdOf(codecName: 'zstd' | 'gzip'): number {
	return encodeFrame(codecName, Buffer.from('probe')).subarray(MAGIC_LENGTH, MAGIC_LENGTH + 1)[0]!;
}

/** A legacy 'MZS1' envelope: magic + codec id, no declared lengths at all. */
function legacyEnvelope(codecName: 'zstd' | 'gzip', data: Uint8Array): Buffer {
	const current = encodeFrame(codecName, data);
	const legacy = Buffer.alloc(5 + (current.length - HEADER_LENGTH));
	legacy.write('MZS1', 0, 'ascii');
	legacy[MAGIC_LENGTH] = codecIdOf(codecName);
	legacy.set(current.subarray(HEADER_LENGTH), 5);
	return legacy;
}

/** Copy of an envelope with one u64 BE length field overwritten. */
function withDeclaredLength(envelope: Buffer, offset: number, value: number | bigint): Buffer {
	const patched = Buffer.from(envelope);
	patched.writeBigUInt64BE(BigInt(value), offset);
	return patched;
}

describe('decodeFrame — envelope refusals', () => {
	it('refuses an empty frame with an explicit magic mismatch', () => {
		// A zero-length read must not be mistaken for "no frame".
		expect(() => decodeFrame(Buffer.alloc(0))).toThrow(CorruptFrameError);
		expect(() => decodeFrame(Buffer.alloc(0))).toThrow(/frame magic mismatch/);
	});

	it('refuses a frame shorter than the envelope header', () => {
		// Right magic, but the declared-length fields never arrived.
		const truncated = Buffer.concat([Buffer.from('MZS2', 'ascii'), Buffer.alloc(8)]);
		expect(() => decodeFrame(truncated)).toThrow(CorruptFrameError);
		expect(() => decodeFrame(truncated)).toThrow(
			/frame is 12 bytes, shorter than the 21-byte envelope header/,
		);
	});

	it('refuses an unknown codec id', () => {
		// The codec id is checked before any length field, so an id the
		// runtime cannot serve must never be reported as corruption.
		const envelope = Buffer.alloc(HEADER_LENGTH);
		envelope.write('MZS2', 0, 'ascii');
		envelope[MAGIC_LENGTH] = 0x7f;
		expect(() => decodeFrame(envelope)).toThrow(CorruptFrameError);
		expect(() => decodeFrame(envelope)).toThrow(/unknown frame codec id 0x7f/);
	});

	it('refuses a truncated payload: the envelope declares more frame bytes than it holds', () => {
		const envelope = encodeFrame('gzip', Buffer.from('a torn write in the middle'));
		const truncated = envelope.subarray(0, envelope.length - 4);
		expect(() => decodeFrame(truncated)).toThrow(CorruptFrameError);
		expect(() => decodeFrame(truncated)).toThrow(/frame length mismatch/);
		expect(() => decodeFrame(truncated)).toThrow(
			new RegExp(`envelope declares ${envelope.length - HEADER_LENGTH} frame bytes, payload holds ${truncated.length - HEADER_LENGTH}`),
		);
	});

	it('refuses an over-long tail: the payload holds more frame bytes than declared', () => {
		// The other direction of the same check: a frame that grew after the
		// header was written must not be served with its declared length.
		const envelope = encodeFrame('gzip', Buffer.from('payload'));
		const withTail = Buffer.concat([envelope, Buffer.from('EXTRA')]);
		expect(() => decodeFrame(withTail)).toThrow(CorruptFrameError);
		expect(() => decodeFrame(withTail)).toThrow(/frame length mismatch/);
	});

	it('refuses a declared uncompressed length that disagrees with the decoded size', () => {
		// The frame itself is intact and checksums fine; only the envelope
		// lies about the size. The mismatch must still be caught.
		const payload = Buffer.from('the declared length is a lie');
		const envelope = encodeFrame('gzip', payload);
		const lying = withDeclaredLength(envelope, UNCOMPRESSED_LENGTH_OFFSET, payload.length + 1);
		expect(() => decodeFrame(lying)).toThrow(CorruptFrameError);
		expect(() => decodeFrame(lying)).toThrow(/uncompressed length mismatch/);
		expect(() => decodeFrame(lying)).toThrow(
			new RegExp(`envelope declares ${payload.length + 1} bytes, frame decoded to ${payload.length}`),
		);
	});

	it('refuses a declared uncompressed length of zero for a non-empty frame', () => {
		const envelope = encodeFrame('gzip', Buffer.from('not empty'));
		const lying = withDeclaredLength(envelope, UNCOMPRESSED_LENGTH_OFFSET, 0);
		expect(() => decodeFrame(lying)).toThrow(/uncompressed length mismatch/);
	});

	it('refuses a declared uncompressed length above the output limit without decompressing', () => {
		// The budget check must come first: a frame that claims to expand
		// past the limit is refused before a single byte is materialized.
		const envelope = encodeFrame('gzip', Buffer.from('small but claiming to be huge'));
		const lying = withDeclaredLength(envelope, UNCOMPRESSED_LENGTH_OFFSET, 10_000);
		expect(() => decodeFrame(lying, { maxOutputLength: 1_000 })).toThrow(CorruptFrameError);
		expect(() => decodeFrame(lying, { maxOutputLength: 1_000 })).toThrow(
			/frame declares 10000 uncompressed bytes, above the 1000-byte output limit/,
		);
	});

	it('accepts an output limit exactly equal to the decoded size', () => {
		// The limit is a ceiling, not an exclusive bound: a frame that fits
		// exactly must still decode.
		const payload = Buffer.from('x'.repeat(4096));
		const envelope = encodeFrame('gzip', payload);
		const decoded = decodeFrame(envelope, { maxOutputLength: payload.length });
		expect(decoded.data.equals(payload)).toBe(true);
		expect(decoded.name).toBe('gzip');
	});

	it('refuses a declared length beyond the safe integer range', () => {
		// A u64 header field can hold values JavaScript cannot count. Such a
		// declaration must be refused, not silently truncated.
		const envelope = encodeFrame('gzip', Buffer.from('data'));
		const absurd = withDeclaredLength(envelope, UNCOMPRESSED_LENGTH_OFFSET, 2n ** 63n);
		expect(() => decodeFrame(absurd)).toThrow(CorruptFrameError);
		expect(() => decodeFrame(absurd)).toThrow(/unreasonable length/);
	});

	it('refuses a frame length beyond the safe integer range', () => {
		const envelope = encodeFrame('gzip', Buffer.from('data'));
		const absurd = withDeclaredLength(envelope, FRAME_LENGTH_OFFSET, 2n ** 63n);
		expect(() => decodeFrame(absurd)).toThrow(/unreasonable length/);
	});
});

describe('decodeFrame — legacy envelopes and input shapes', () => {
	it('decodes a legacy MZS1 envelope that declares no lengths', () => {
		const payload = Buffer.from('written by an older generation');
		const legacy = legacyEnvelope('gzip', payload);
		const decoded = decodeFrame(legacy);
		expect(decoded.name).toBe('gzip');
		expect(decoded.data.equals(payload)).toBe(true);
	});

	it('refuses a legacy envelope whose frame is torn', () => {
		// The legacy envelope carries no lengths, so the frame's own checksum
		// is the only witness — and it must reject, not serve damaged bytes.
		const legacy = legacyEnvelope('gzip', Buffer.from('a torn legacy frame'));
		const torn = Buffer.from(legacy);
		torn[torn.length - 1] = (torn[torn.length - 1] ?? 0) ^ 0xff;
		expect(() => decodeFrame(torn)).toThrow(CorruptFrameError);
		expect(() => decodeFrame(torn)).toThrow(/frame failed gzip decompression/);
	});

	it('decodes a frame handed over as a plain Uint8Array', () => {
		// Not every reader holds a Buffer; the decoder must accept a bare
		// typed array without copying semantics changing the verdict.
		const payload = Buffer.from('a bare typed array');
		const envelope = encodeFrame('gzip', payload);
		const plain = new Uint8Array(envelope); // copies, no Buffer prototype
		expect(Buffer.isBuffer(plain)).toBe(false);
		const decoded = decodeFrame(plain);
		expect(decoded.data.equals(payload)).toBe(true);
	});

	it('decodes a frame stored in an offset subarray view', () => {
		// A view into a larger arena must be read from its own offset — the
		// envelope is not at the start of the backing buffer.
		const payload = Buffer.from('an offset view');
		const envelope = encodeFrame('gzip', payload);
		const arena = new Uint8Array(envelope.length + 32);
		arena.set(envelope, 16);
		const view = arena.subarray(16, 16 + envelope.length);
		const decoded = decodeFrame(view);
		expect(decoded.data.equals(payload)).toBe(true);
	});

	it('round-trips an empty payload', () => {
		// A zero-length batch is legal input; it must not be mistaken for a
		// missing frame.
		const envelope = encodeFrame('gzip', Buffer.alloc(0));
		const decoded = decodeFrame(envelope);
		expect(decoded.data.length).toBe(0);
		expect(peekFrameUncompressedLength(envelope)).toBe(0);
	});
});

describe('peekFrameUncompressedLength', () => {
	it('returns the declared length of a current envelope', () => {
		const payload = Buffer.from('budget me without decompressing');
		const envelope = encodeFrame('gzip', payload);
		expect(peekFrameUncompressedLength(envelope)).toBe(payload.length);
	});

	it('returns null for anything that is not a current envelope', () => {
		expect(peekFrameUncompressedLength(Buffer.alloc(0))).toBeNull();
		expect(peekFrameUncompressedLength(Buffer.from('not a frame at all'))).toBeNull();
		expect(peekFrameUncompressedLength(legacyEnvelope('gzip', Buffer.from('legacy')))).toBeNull();
		// A header cut short has no length field to report.
		expect(peekFrameUncompressedLength(Buffer.from('MZS2', 'ascii'))).toBeNull();
	});

	it('reports the length even when the frame itself is damaged', () => {
		// The peek is a budget hint for the reader, not a validity verdict:
		// it must not depend on the frame's integrity.
		const payload = Buffer.from('damaged but budgeted');
		const envelope = encodeFrame('gzip', payload);
		const torn = Buffer.from(envelope);
		torn[torn.length - 1] = (torn[torn.length - 1] ?? 0) ^ 0xff;
		expect(peekFrameUncompressedLength(torn)).toBe(payload.length);
	});
});
