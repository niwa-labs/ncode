/**
 * Fixed one-turn image residency: birth/read turn only, next-turn batch
 * eviction, same-turn compaction reseeds, occurrence isolation on re-read,
 * budget accounting, artifact stubs and real provider hydration.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { PiTurnRunner, type RuntimeEvent } from '@mavis/agent-core/pi-turn-runner';
import {
  createBackgroundCompactionScheduler,
  createMessageEntryDraft,
} from '@mavis/context-compaction';
import type { CompactionMessage, LogEntry } from '@mavis/context-compaction';

import {
  contextWireRequestMessages,
  type ContextWireRecord,
} from '../../../../../agent-core/src/pi-turn-runner/context-wire.js';
import type { CanonicalHistoryMessage } from '../agent-host/history/contracts.js';
import {
  ImageArtifactStore,
  resolveArtifactsDir,
} from '../../session-system/messages/history/image-artifact-store.js';
import { createTurnContextWire, DEFAULT_MAX_PAYLOAD_BYTES } from './context-wire.js';
import {
  DEFAULT_RESIDENT_IMAGE_BUDGET_TOKENS,
  resolveResidentImageBudgetTokens,
  TurnImageResidency,
} from './turn-image-residency.js';

afterEach(() => vi.unstubAllEnvs());

const model = {
  api: 'openai-completions',
  provider: 'test-provider',
  id: 'test-model',
} as unknown as Model<Api>;

const SCREENSHOT_BASE64 = 'iVBORw0KGgoAAAANSUhEUg==';

function screenshotMessage(
  text: string,
  data: string = SCREENSHOT_BASE64,
): CanonicalHistoryMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image', data, mimeType: 'image/png' },
    ],
    timestamp: 42,
  } as unknown as CanonicalHistoryMessage;
}

function textMessage(text: string): CanonicalHistoryMessage {
  return { role: 'user', content: text, timestamp: 41 } as CanonicalHistoryMessage;
}

/** An OFFLOADED image message: the canonical log's reference block (no data). */
function offloadedImageMessage(
  text: string,
  ref: { sha256: string; artifact: string; bytes: number },
): CanonicalHistoryMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      {
        type: 'image',
        mimeType: 'image/png',
        sha256: ref.sha256,
        artifact: ref.artifact,
        bytes: ref.bytes,
      },
    ],
    timestamp: 43,
  } as unknown as CanonicalHistoryMessage;
}

describe('TurnImageResidency fixed one-turn lifetime', () => {
  it('expires images at the next actual turn boundary', () => {
    const local = new TurnImageResidency();
    const wire = createTurnContextWire({ residency: local });
    const shot = screenshotMessage('shot');
    wire.seed({ sessionId: 'one-turn', messages: [] });
    wire.observeCommit({ sessionId: 'one-turn', reason: 'messageDelta', messages: [shot] });
    expect(
      wire
        .projection('one-turn')!
        .project()!
        .records.some((r) => r.images),
    ).toBe(true);
    wire.seed({ sessionId: 'one-turn', messages: [shot, textMessage('next turn')] });
    expect(local.stats('one-turn')).toEqual({ entries: 0, tokens: 0 });
    expect(
      wire
        .projection('one-turn')!
        .project()!
        .records.every((r) => !r.images),
    ).toBe(true);
  });

  it('rebuilding after compaction does not age images within the same turn', () => {
    const local = new TurnImageResidency();
    const wire = createTurnContextWire({ residency: local });
    const shot = screenshotMessage('same-turn shot');
    wire.seed({ sessionId: 'reseed', messages: [] });
    wire.observeCommit({ sessionId: 'reseed', reason: 'messageDelta', messages: [shot] });
    wire.reseed('reseed', [shot]);
    wire.observeCommit({ sessionId: 'reseed', reason: 'replaceMessages', messages: [shot] });
    wire.reseed('reseed', [shot]);
    expect(
      wire
        .projection('reseed')!
        .project()!
        .records.some((r) => r.images),
    ).toBe(true);
    wire.seed({ sessionId: 'reseed', messages: [shot] });
    expect(
      wire
        .projection('reseed')!
        .project()!
        .records.every((r) => !r.images),
    ).toBe(true);
  });

  it('re-read admits only the new occurrence without resurrecting old prefix images', () => {
    const local = new TurnImageResidency();
    const wire = createTurnContextWire({ residency: local });
    const original = screenshotMessage('original occurrence');
    const reread = screenshotMessage('read again');
    wire.seed({ sessionId: 'read', messages: [] });
    wire.observeCommit({ sessionId: 'read', reason: 'messageDelta', messages: [original] });
    wire.seed({ sessionId: 'read', messages: [original] });
    wire.observeCommit({ sessionId: 'read', reason: 'messageDelta', messages: [reread] });
    const records = wire.projection('read')!.project()!.records;
    expect(records.find((r) => r.text.includes('original occurrence'))!.images).toBeUndefined();
    expect(records.find((r) => r.text.includes('read again'))!.images).toHaveLength(1);
    expect(local.stats('read').entries).toBe(1);
    wire.seed({ sessionId: 'read', messages: [original, reread] });
    expect(
      wire
        .projection('read')!
        .project()!
        .records.every((r) => !r.images),
    ).toBe(true);
  });

  it('evicts five expired images as one batch', () => {
    const local = new TurnImageResidency();
    const wire = createTurnContextWire({ residency: local });
    wire.seed({ sessionId: 'batch', messages: [] });
    const shots = [1, 2, 3, 4, 5].map((n) => screenshotMessage(`shot ${n}`, `image-${n}`));
    wire.observeCommit({ sessionId: 'batch', reason: 'messageDelta', messages: shots });
    expect(local.stats('batch').entries).toBe(5);
    expect(local.beginTurn('batch')).toHaveLength(5);
    expect(local.stats('batch')).toEqual({ entries: 0, tokens: 0 });
  });

  it('keeps oldest-first budget eviction within the current turn', () => {
    const local = new TurnImageResidency(2_000);
    const wire = createTurnContextWire({ residency: local });
    wire.seed({ sessionId: 'budget', messages: [] });
    for (const [name, data] of [
      ['old', 'A'.repeat(4800)],
      ['new', 'B'.repeat(4800)],
    ]) {
      wire.observeCommit({
        sessionId: 'budget',
        reason: 'messageDelta',
        messages: [screenshotMessage(name!, data!)],
      });
    }
    expect(local.stats('budget')).toEqual({ entries: 1, tokens: 1200 });
    const records = wire
      .projection('budget')!
      .project()!
      .records.filter((r) => r.images);
    expect(records).toHaveLength(1);
    expect(records[0]!.text).toContain('new');
  });

  it('rejects a resident image budget breach before the provider call', async () => {
    const sessionId = 'provider-budget';
    const turnId = 'turn-budget';
    const wire = createTurnContextWire({ residency: new TurnImageResidency(), maxBytes: 128 });
    const data = 'QUFB'.repeat(128);
    wire.seed({ sessionId, messages: [] });
    wire.observeCommit({ sessionId, reason: 'messageDelta', messages: [screenshotMessage('screenshot', data)] });
    const projection = wire.projection(sessionId)!;
    const streamFn = vi.fn(() => { throw new Error('provider must not be called'); });
    const events: RuntimeEvent[] = [];

    await new PiTurnRunner().runTurn({
      sessionId,
      turnId,
      workspaceDir: tmpdir(),
      systemPrompt: 'test',
      userMessage: { text: 'screenshot', attachments: [{ type: 'image', data, mimeType: 'image/png' }] },
      llm: { model: { ...model, input: ['text', 'image'] }, streamFn },
      contextWire: projection,
      eventWriter: {
        appendEvents: (batch) => { events.push(...batch); },
        pushRuntime: (event) => { events.push(event); },
      },
      toolConfig: { tools: [], disableBuiltinToolFallback: true, context: { sessionId, turnId } },
    });

    expect(streamFn).not.toHaveBeenCalled();
    expect(JSON.stringify(events)).toContain('Reduce attached image data or compact the conversation.');
    expect(wire.projection(sessionId)).toBeDefined();
  });

  it('still falls back when a history-only window exceeds the byte budget', () => {
    const wire = createTurnContextWire({ maxBytes: 128 });
    const sessionId = 'history-budget';
    wire.seed({ sessionId, messages: [textMessage('history'.repeat(64))] });
    expect(wire.projection(sessionId)!.project()).toBeUndefined();
  });

  it('budget zero keeps images as placeholders', () => {
    const local = new TurnImageResidency(0);
    const wire = createTurnContextWire({ residency: local });
    wire.seed({ sessionId: 'zero', messages: [] });
    wire.observeCommit({
      sessionId: 'zero',
      reason: 'messageDelta',
      messages: [screenshotMessage('shot')],
    });
    expect(
      wire
        .projection('zero')!
        .project()!
        .records.every((r) => !r.images),
    ).toBe(true);
  });

  it('retired lifetime environment values cannot change the policy', () => {
    for (const value of ['99', '0', 'invalid']) {
      vi.stubEnv('MCODE_RESIDENT_IMAGE_TURNS', value);
      const local = new TurnImageResidency();
      const wire = createTurnContextWire({ residency: local });
      wire.seed({ sessionId: 'fixed', messages: [] });
      const shot = screenshotMessage('shot');
      wire.observeCommit({ sessionId: 'fixed', reason: 'messageDelta', messages: [shot] });
      expect(
        wire
          .projection('fixed')!
          .project()!
          .records.some((r) => r.images),
      ).toBe(true);
      wire.seed({ sessionId: 'fixed', messages: [shot] });
      expect(
        wire
          .projection('fixed')!
          .project()!
          .records.every((r) => !r.images),
      ).toBe(true);
    }
  });
});

describe('resolveResidentImageBudgetTokens (the numeric knob)', () => {
  it('defaults to the owner-decided 150k tokens', () => {
    expect(resolveResidentImageBudgetTokens({})).toBe(150_000);
    expect(DEFAULT_RESIDENT_IMAGE_BUDGET_TOKENS).toBe(150_000);
  });

  it('reads an explicit override and rejects invalid values', () => {
    expect(resolveResidentImageBudgetTokens({ MCODE_RESIDENT_IMAGE_BUDGET_TOKENS: '200000' })).toBe(
      200_000,
    );
    expect(resolveResidentImageBudgetTokens({ MCODE_RESIDENT_IMAGE_BUDGET_TOKENS: '0' })).toBe(0);
    expect(() =>
      resolveResidentImageBudgetTokens({ MCODE_RESIDENT_IMAGE_BUDGET_TOKENS: 'many' }),
    ).toThrow('MCODE_RESIDENT_IMAGE_BUDGET_TOKENS');
    expect(() =>
      resolveResidentImageBudgetTokens({ MCODE_RESIDENT_IMAGE_BUDGET_TOKENS: '-1' }),
    ).toThrow('MCODE_RESIDENT_IMAGE_BUDGET_TOKENS');
  });
});

describe('offloaded images (wave 2, item 2.2): bytes from the artifact store, stubs with the path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'residency-artifacts-'));
  const store = new ImageArtifactStore({ artifactsDir: resolveArtifactsDir(dir) });
  const artifact = store.store({ data: SCREENSHOT_BASE64, mimeType: 'image/png' });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('background compaction summarizes artifact links after the one-turn wash, without image bytes', async () => {
    const residency = new TurnImageResidency(150_000, { artifacts: store });
    const wire = createTurnContextWire({ residency });
    const shot = offloadedImageMessage('screenshot', {
      sha256: artifact.sha256,
      artifact: artifact.path,
      bytes: artifact.bytes,
    });
    wire.seed({ sessionId: 'auto-image', messages: [] });
    wire.observeCommit({ sessionId: 'auto-image', reason: 'messageDelta', messages: [shot] });
    expect(
      wire
        .projection('auto-image')!
        .project()!
        .records.some((r) => r.images),
    ).toBe(true);
    wire.seed({ sessionId: 'auto-image', messages: [shot] });
    expect(
      wire
        .projection('auto-image')!
        .project()!
        .records.every((r) => !r.images),
    ).toBe(true);

    const messages: CompactionMessage[] = [
      shot as CompactionMessage,
      { role: 'assistant', content: [{ type: 'text', text: 'work '.repeat(56_000) }] },
      { role: 'user', content: 'new question' },
      { role: 'assistant', content: [{ type: 'text', text: 'recent answer' }] },
    ];
    const entries: LogEntry[] = messages.map((message, i) => ({
      ...createMessageEntryDraft(`auto-${i}`, message),
      seq: (i + 1) as never,
      ordinal: 0,
    }));
    const prompts: string[] = [];
    let committed = 0;
    const scheduler = createBackgroundCompactionScheduler({
      budgets: { tokenBudget: 100_000 },
      session: {
        entries,
        append: async (drafts) => {
          committed += drafts.length;
        },
      },
      summarizer: async (prompt) => {
        prompts.push(prompt);
        return 'Screenshot checked; artifact retained.';
      },
    });
    scheduler.notify();
    await scheduler.whenIdle();
    expect(committed).toBeGreaterThan(0);
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.join('\n')).toContain(artifact.path);
    expect(prompts.join('\n')).not.toContain(SCREENSHOT_BASE64);
    expect(store.readData(artifact.sha256)).toBe(SCREENSHOT_BASE64);
  });

  it('a resident offloaded image resolves its bytes back out of the store (a provider image block)', () => {
    const residency = new TurnImageResidency(150_000, { artifacts: store });
    const wire = createTurnContextWire({ residency });
    wire.seed({ sessionId: 's-off', messages: [] });
    wire.observeCommit({
      sessionId: 's-off',
      reason: 'messageDelta',
      messages: [
        offloadedImageMessage('the screenshot (offloaded)', {
          sha256: artifact.sha256,
          artifact: artifact.path,
          bytes: artifact.bytes,
        }),
      ] as unknown as readonly CanonicalHistoryMessage[],
    });
    const request = wire.projection('s-off')!.project()!;
    const withImage = request.records.find((record) => record.images !== undefined);
    expect(withImage).toBeDefined();
    expect(withImage!.images).toEqual([{ data: SCREENSHOT_BASE64, mimeType: 'image/png' }]);

    // The EXACT hydration the turn loop performs: a real provider image block.
    const transcript = [
      { role: 'user', content: [{ type: 'text', text: 'seed' }], timestamp: 0 },
    ] as unknown as readonly AgentMessage[];
    const messages = contextWireRequestMessages(
      transcript,
      { records: request.records as readonly ContextWireRecord[], totalBytes: request.totalBytes },
      model,
    );
    const hydrated = messages.find(
      (message) =>
        message.role === 'user' && JSON.stringify(message.content).includes(SCREENSHOT_BASE64),
    );
    expect(hydrated).toBeDefined();
  });

  it('an evicted offloaded image renders the read-again stub naming the artifact path', () => {
    const residency = new TurnImageResidency(150_000, { artifacts: store });
    const wire = createTurnContextWire({ residency });
    wire.seed({ sessionId: 's-stub', messages: [] });
    wire.observeCommit({
      sessionId: 's-stub',
      reason: 'messageDelta',
      messages: [
        offloadedImageMessage('the screenshot (offloaded)', {
          sha256: artifact.sha256,
          artifact: artifact.path,
          bytes: artifact.bytes,
        }),
      ] as unknown as readonly CanonicalHistoryMessage[],
    });
    // At the next turn boundary the stub replaces the bytes
    // (each boundary seed folds the full canonical history — the image entry
    // stays in the window).
    const history = [
      offloadedImageMessage('the screenshot (offloaded)', {
        sha256: artifact.sha256,
        artifact: artifact.path,
        bytes: artifact.bytes,
      }),
    ] as unknown as readonly CanonicalHistoryMessage[];
    wire.seed({ sessionId: 's-stub', messages: history });
    const records = wire.projection('s-stub')!.project()!.records;
    expect(records.every((record) => record.images === undefined)).toBe(true);
    const stubRecord = records.find((record) => record.text.includes('Image saved to'));
    expect(stubRecord).toBeDefined();
    expect(stubRecord!.text).toContain(artifact.path);
    expect(stubRecord!.text).toContain('(image/png');
    expect(stubRecord!.text).toContain('use read to view again');
  });
});

describe('acceptance: a live request with a screenshot carries an image block (the provider payload)', () => {
  it('the current-turn screenshot rides the request as an image block; other images stay placeholders', () => {
    const residency = new TurnImageResidency();
    const wire = createTurnContextWire({ residency });
    // Turn 1 seed: the pre-turn history (an OLD screenshot with DIFFERENT
    // content — never observed this turn, so the placeholder baseline).
    wire.seed({
      sessionId: 'session-shot',
      messages: [screenshotMessage('old shot from the previous turn', 'oldBase64Value==')],
    });

    // The CURRENT turn: the owner sends a fresh screenshot (a messageDelta
    // commit — the executor feeds every canonical history commit here).
    wire.observeCommit({
      sessionId: 'session-shot',
      reason: 'messageDelta',
      messages: [
        screenshotMessage('свежий скриншот'),
      ] as unknown as readonly CanonicalHistoryMessage[],
    });

    // The projection the runner consumes on EVERY provider request:
    const projection = wire.projection('session-shot')!;
    const request = projection.project();
    expect(request).toBeDefined();
    const recordWithImage = request!.records.find((record) => record.images !== undefined);
    expect(recordWithImage).toBeDefined();
    expect(recordWithImage!.text).toContain('свежий скриншот');
    expect(recordWithImage!.images).toEqual([{ data: SCREENSHOT_BASE64, mimeType: 'image/png' }]);

    // The EXACT hydration the turn loop performs (agent-core
    // contextWireRequestMessages): the provider payload carries a real
    // image block at the marker position.
    const transcript = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'seed' }],
        timestamp: 0,
      },
    ] as unknown as readonly AgentMessage[];
    const messages = contextWireRequestMessages(
      transcript,
      {
        records: request!.records as readonly ContextWireRecord[],
        totalBytes: request!.totalBytes,
      },
      model,
    );
    const hydrated = messages.find(
      (message) =>
        message.role === 'user' && JSON.stringify(message.content).includes(SCREENSHOT_BASE64),
    );
    expect(hydrated).toBeDefined();
    expect(hydrated!.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'image', data: SCREENSHOT_BASE64, mimeType: 'image/png' }),
      ]),
    );

    // The never-observed old screenshot stays the placeholder: no image
    // block, no bytes.
    const oldRecord = request!.records.find((record) => record.text.includes('old shot'))!;
    expect(oldRecord.images).toBeUndefined();
    expect(oldRecord.text).toContain('[image: image/png]');
    expect(JSON.stringify(messages)).not.toContain('data:image/png;base64,');
  });

  it('the payload budget stays honest: resident bytes count in the compiled payload', () => {
    const residency = new TurnImageResidency();
    const wire = createTurnContextWire({
      residency,
      maxBytes: DEFAULT_MAX_PAYLOAD_BYTES,
    });
    wire.seed({ sessionId: 'session-bytes', messages: [] });
    wire.observeCommit({
      sessionId: 'session-bytes',
      reason: 'messageDelta',
      messages: [screenshotMessage('shot')] as unknown as readonly CanonicalHistoryMessage[],
    });
    const resident = wire.projection('session-bytes')!.project()!;

    // A 0-budget overlay keeps the entry untracked; the payload then carries
    // only the placeholder — the resident bytes were a real cost of the
    // request, not hidden text.
    const digestResidency = new TurnImageResidency(0);
    const digestWire = createTurnContextWire({ residency: digestResidency });
    digestWire.seed({ sessionId: 'session-bytes', messages: [] });
    digestWire.observeCommit({
      sessionId: 'session-bytes',
      reason: 'messageDelta',
      messages: [screenshotMessage('shot')] as unknown as readonly CanonicalHistoryMessage[],
    });
    const digest = digestWire.projection('session-bytes')!.project()!;
    expect(digest.totalBytes).toBeLessThan(resident.totalBytes);
  });
});
