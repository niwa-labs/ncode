import type { WriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { createOutputFileStream } from "../../utils/output-files.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult, truncateHead, truncateTail } from "./truncate.ts";

export interface OutputAccumulatorOptions {
	maxLines?: number;
	maxBytes?: number;
	tempFilePrefix?: string;
	/**
	 * MiniMax reapply (W01-C PR-09, ledger №43): `head_tail` keeps the start of
	 * the output next to the tail so early failures stay visible; the default
	 * `tail` retains Pi's behavior.
	 */
	strategy?: "tail" | "head_tail";
	/** MiniMax reapply (W01-C PR-09): disable when the host already owns the complete output log. */
	persistOutput?: boolean;
}

export interface OutputSnapshot {
	content: string;
	truncation: TruncationResult;
	fullOutputPath?: string;
	/** MiniMax reapply (W01-C PR-09): raw bytes appended across all streams. */
	rawBytes: number;
}

export interface FullOutput {
	content: string;
	/** Whether `content` omits part of the output. */
	truncated: boolean;
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

function utf8Prefix(text: string, maxBytes: number): string {
	const buffer = Buffer.from(text, "utf8");
	let end = Math.min(buffer.length, Math.max(0, maxBytes));
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
	return buffer.subarray(0, end).toString("utf-8");
}

/**
 * Incrementally tracks streaming output with bounded memory.
 *
 * Appends decode chunks with a streaming UTF-8 decoder, keeps only a decoded
 * tail for display snapshots, and opens a temp file when the full output needs
 * to be preserved.
 */
export class OutputAccumulator {
	private readonly maxLines: number;
	private readonly maxBytes: number;
	private readonly maxRollingBytes: number;
	private readonly tempFilePrefix: string;
	private readonly strategy: "tail" | "head_tail";
	private readonly persistOutput: boolean;
	private readonly decoders = new Map<string, TextDecoder>();

	private rawChunks: Buffer[] = [];
	private tailText = "";
	private tailBytes = 0;
	private tailStartsAtLineBoundary = true;
	private totalRawBytes = 0;
	private totalDecodedBytes = 0;
	private completedLines = 0;
	private totalLines = 0;
	private currentLineBytes = 0;
	private hasOpenLine = false;
	private finished = false;

	// MiniMax reapply (W01-C PR-09, ledger №43): head window for the head_tail strategy.
	private headText = "";
	private headBytes = 0;
	private headClosed = false;

	private tempFilePath: string | undefined;
	private tempFileStream: WriteStream | undefined;
	private tempFileError: Error | undefined;

	constructor(options: OutputAccumulatorOptions = {}) {
		this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
		this.tempFilePrefix = options.tempFilePrefix ?? "pi-output";
		this.strategy = options.strategy ?? "tail";
		this.persistOutput = options.persistOutput !== false;
	}

	append(data: Buffer, stream: "stdout" | "stderr" | "combined" = "combined"): void {
		if (this.finished) {
			throw new Error("Cannot append to a finished output accumulator");
		}

		this.totalRawBytes += data.length;
		// MiniMax reapply (W01-C PR-09): split streams decode independently, so
		// interleaved chunk boundaries never split a UTF-8 sequence for display.
		let decoder = this.decoders.get(stream);
		if (!decoder) {
			decoder = new TextDecoder();
			this.decoders.set(stream, decoder);
		}
		this.appendDecodedChunk(decoder.decode(data, { stream: true }), data);

		if (this.persistOutput && (this.tempFileStream || this.shouldUseTempFile())) {
			this.ensureTempFile();
			this.tempFileStream?.write(data);
		} else if (this.persistOutput && data.length > 0) {
			this.rawChunks.push(data);
		}
	}

	finish(): void {
		if (this.finished) {
			return;
		}
		this.finished = true;
		for (const decoder of this.decoders.values()) {
			this.appendDecodedChunk(decoder.decode(), Buffer.alloc(0));
		}
		if (this.persistOutput && this.shouldUseTempFile()) {
			this.ensureTempFile();
		}
	}

	snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
		// Clipping drops the partial first line of the retained tail. When the tail is only the end of
		// one over-long line (plus blank lines), nothing is left, so show the end of that line instead.
		const clippedText = this.getSnapshotText();
		const snapshotText = clippedText.trim().length === 0 ? this.tailText : clippedText;
		const tailTruncation = truncateTail(snapshotText, {
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		});
		const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
		const truncatedBy = truncated
			? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
			: null;
		const truncation: TruncationResult = {
			...tailTruncation,
			truncated,
			truncatedBy,
			totalLines: this.totalLines,
			totalBytes: this.totalDecodedBytes,
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		};

		if (this.strategy === "head_tail" && truncated) {
			const marker = "\n\n[... output omitted ...]\n\n";
			const budget = Math.max(0, this.maxBytes - byteLength(marker));
			const headBudget = Math.floor(budget * 0.45);
			const head =
				truncateHead(this.headText, { maxBytes: headBudget, maxLines: this.maxLines }).content ||
				utf8Prefix(this.headText, headBudget);
			const tail = truncateTail(this.tailText, { maxBytes: budget - headBudget, maxLines: this.maxLines }).content;
			const content = utf8Prefix(head + marker + tail, this.maxBytes);
			Object.assign(truncation, {
				content,
				outputBytes: byteLength(content),
				outputLines: content.split("\n").length,
			});
		}

		if (options.persistIfTruncated && truncation.truncated && this.persistOutput) {
			this.ensureTempFile();
		}

		return {
			content: truncation.content,
			truncation,
			fullOutputPath: this.tempFileError ? undefined : this.tempFilePath,
			rawBytes: this.totalRawBytes,
		};
	}

	async closeTempFile(): Promise<void> {
		if (this.tempFileError) throw this.tempFileError;
		if (!this.tempFileStream) {
			return;
		}

		const stream = this.tempFileStream;
		this.tempFileStream = undefined;

		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				stream.off("finish", onFinish);
				reject(error);
			};
			const onFinish = () => {
				stream.off("error", onError);
				resolve();
			};
			stream.once("error", onError);
			stream.once("finish", onFinish);
			stream.end();
		});
	}

	/**
	 * The complete output, for callers that can take more than the display snapshot. Call after
	 * `finish()` and `closeTempFile()`. Output longer than `maxBytes` raw bytes keeps its first and
	 * last `maxBytes / 2` bytes around an omission marker.
	 */
	async readFullOutput(maxBytes: number): Promise<FullOutput> {
		if (!this.tempFilePath) {
			return { content: new TextDecoder().decode(Buffer.concat(this.rawChunks)), truncated: false };
		}
		const file = await open(this.tempFilePath, "r");
		try {
			const size = (await file.stat()).size;
			if (size <= maxBytes) {
				return { content: new TextDecoder().decode(await file.readFile()), truncated: false };
			}
			const headBytes = Math.floor(maxBytes / 2);
			const tailBytes = maxBytes - headBytes;
			const head = Buffer.alloc(headBytes);
			const tail = Buffer.alloc(tailBytes);
			await file.read(head, 0, headBytes, 0);
			await file.read(tail, 0, tailBytes, size - tailBytes);
			// Cut at character boundaries: streaming decode holds back an incomplete trailing sequence,
			// and the tail skips leading continuation bytes.
			const headText = new TextDecoder().decode(head, { stream: true });
			let tailStart = 0;
			while (tailStart < tail.length && (tail[tailStart] & 0xc0) === 0x80) tailStart++;
			const tailText = new TextDecoder().decode(tail.subarray(tailStart));
			const omitted = size - headBytes - tailBytes;
			return { content: `${headText}\n\n[... ${omitted} bytes omitted ...]\n\n${tailText}`, truncated: true };
		} finally {
			await file.close();
		}
	}

	getLastLineBytes(): number {
		return this.currentLineBytes;
	}

	private appendDecodedChunk(text: string, raw: Buffer): void {
		this.appendDecodedText(text);
		// MiniMax reapply (W01-C PR-09, ledger №43): a head window tracks the same
		// bounds as the display budget so head+tail snapshots stay bounded.
		if (this.strategy === "head_tail" && !this.headClosed && text.length > 0) {
			this.headClosed = this.headBytes + byteLength(text) >= this.maxBytes;
			this.headText += utf8Prefix(text, this.maxBytes - this.headBytes);
			this.headBytes = byteLength(this.headText);
		}
	}

	private appendDecodedText(text: string): void {
		if (text.length === 0) {
			return;
		}

		const bytes = byteLength(text);
		this.totalDecodedBytes += bytes;
		this.tailText += text;
		this.tailBytes += bytes;
		if (this.tailBytes > this.maxRollingBytes * 2) {
			this.trimTail();
		}

		let newlines = 0;
		let lastNewline = -1;
		for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
			newlines++;
			lastNewline = i;
		}
		if (newlines === 0) {
			this.currentLineBytes += bytes;
			this.hasOpenLine = true;
		} else {
			this.completedLines += newlines;
			const tail = text.slice(lastNewline + 1);
			this.currentLineBytes = byteLength(tail);
			this.hasOpenLine = tail.length > 0;
		}
		this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
	}

	private trimTail(): void {
		const buffer = Buffer.from(this.tailText, "utf-8");
		if (buffer.length <= this.maxRollingBytes) {
			this.tailBytes = buffer.length;
			return;
		}

		let start = buffer.length - this.maxRollingBytes;
		while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
			start++;
		}

		this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
		this.tailText = buffer.subarray(start).toString("utf-8");
		this.tailBytes = byteLength(this.tailText);
	}

	private getSnapshotText(): string {
		if (this.tailStartsAtLineBoundary) {
			return this.tailText;
		}

		const firstNewline = this.tailText.indexOf("\n");
		return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
	}

	private shouldUseTempFile(): boolean {
		return (
			this.totalRawBytes > this.maxBytes || this.totalDecodedBytes > this.maxBytes || this.totalLines > this.maxLines
		);
	}

	private ensureTempFile(): void {
		if (this.tempFilePath || !this.persistOutput) {
			return;
		}
		const { path, stream } = createOutputFileStream(this.tempFilePrefix, ".log");
		this.tempFilePath = path;
		// MiniMax reapply (W01-C PR-09): a failed persistence stream degrades the
		// full-output reference instead of crashing the running command.
		stream.on("error", (error) => {
			this.tempFileError = error;
		});
		this.tempFileStream = stream;
		for (const chunk of this.rawChunks) {
			this.tempFileStream.write(chunk);
		}
		this.rawChunks = [];
	}
}
