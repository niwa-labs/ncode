import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from '@earendil-works/pi-ai';
import {
  ContextOperationStore,
  contextDigest,
  type RequestReceipt,
} from './context-operation-store.js';
import { withRequestReceipts } from './request-receipts.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'context-operations-'));
  dirs.push(root);
  return { root, store: new ContextOperationStore(root) };
}
async function receipts(root: string): Promise<RequestReceipt[]> {
  const dir = join(root, contextDigest('s'), 'requests');
  return Promise.all(
    (await readdir(dir))
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => JSON.parse(await readFile(join(dir, name), 'utf8'))),
  );
}
const input = {
  sessionId: 's',
  turnId: 't',
  kind: 'agent' as const,
  model: 'test/model',
  planDigest: 'hash',
};

it('recovers definitely unsent, uncertain and canonically committed attempts honestly', async () => {
  const { root, store } = await fixture();
  await store.recover('s', []);
  await store.begin(input);
  const uncertain = await store.begin(input);
  await store.record(uncertain, 'dispatch_intent');
  const committed = await store.begin(input);
  await store.record(committed, 'dispatch_intent');
  await store.record(committed, 'response_received', {
    responseDigest: 'hash',
  });
  await new ContextOperationStore(root).recover('s', [
    { role: 'assistant', content: [], requestReceiptId: committed.id },
  ]);
  expect((await receipts(root)).map((r) => r.phase).sort()).toEqual([
    'not_sent',
    'response_committed',
    'unknown',
  ]);
});

it('persists intent before invoking the provider and links committed history without prompt copies', async () => {
  const { root, store } = await fixture();
  await store.recover('s', []);
  const message = {
    role: 'assistant',
    content: [{ type: 'text', text: 'ANSWER' }],
    timestamp: 12,
    stopReason: 'stop',
    usage: { input: 1, output: 1 },
  } as AssistantMessage;
  const wrapped = withRequestReceipts(
    async () => {
      expect((await receipts(root))[0]?.phase).toBe('dispatch_intent');
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: 'stop', message });
      stream.end();
      return stream;
    },
    store,
    's',
    't',
    'agent',
  );
  const stream = await wrapped(
    { provider: 'test', id: 'model' } as Model<'openai-completions'>,
    { messages: [{ role: 'user', content: 'PRIVATE_PROMPT', timestamp: 1 }] },
  );
  const result = await stream.result();
  expect((await receipts(root))[0]?.phase).toBe('response_received');
  await store.commitResponses('s', [result]);
  const saved = (await receipts(root))[0]!;
  expect(saved.events.map((e) => e.phase)).toEqual([
    'prepared',
    'dispatch_intent',
    'response_received',
    'response_committed',
  ]);
  expect(JSON.stringify(saved)).not.toContain('PRIVATE_PROMPT');
});

it('records a thrown transport outcome as unknown rather than a successful delivery', async () => {
  const { root, store } = await fixture();
  await store.recover('s', []);
  const wrapped = withRequestReceipts(
    () => {
      throw new Error('synthetic transport loss');
    },
    store,
    's',
    't',
    'agent',
  );
  await expect(
    wrapped({ provider: 'test', id: 'model' } as Model<'openai-completions'>, {
      messages: [],
    }),
  ).rejects.toThrow('synthetic transport loss');
  expect((await receipts(root))[0]?.phase).toBe('unknown');
});

it('does not invoke the provider when cancelled before dispatch', async () => {
  const { root, store } = await fixture();
  await store.recover('s', []);
  let invoked = false;
  const wrapped = withRequestReceipts(
    () => {
      invoked = true;
      throw new Error('must not send');
    },
    store,
    's',
    't',
    'agent',
  );
  const controller = new AbortController();
  controller.abort();
  await expect(
    wrapped(
      { provider: 'test', id: 'model' } as Model<'openai-completions'>,
      { messages: [] },
      { signal: controller.signal },
    ),
  ).rejects.toThrow('aborted');
  expect(invoked).toBe(false);
  expect((await receipts(root))[0]?.phase).toBe('not_sent');
});

it('does not attach a rejected prior summary response to a later successful attempt', async () => {
  const { root, store } = await fixture();
  await store.recover('s', []);
  const rejected = await store.begin({ ...input, kind: 'compaction' });
  await store.record(rejected, 'response_received');
  await store.readyStore('s').beginPreparation?.();
  const current = await store.begin({ ...input, kind: 'compaction' });
  await store.record(current, 'response_received');
  expect(store.summaryRequestIds('s')).toEqual([current.id]);
  await store.commitSummaries('s');
  const saved = await receipts(root);
  expect(saved.find((r) => r.id === rejected.id)?.phase).toBe('unknown');
  expect(saved.find((r) => r.id === current.id)?.phase).toBe(
    'response_committed',
  );
});

it('does not fail an already durable answer when its final receipt projection cannot be written', async () => {
  const { root, store } = await fixture();
  await store.recover('s', []);
  const receipt = await store.begin(input);
  await store.record(receipt, 'response_received');
  const path = join(root, contextDigest('s'), 'requests', `${receipt.id}.json`);
  await rm(path);
  await mkdir(path);
  await expect(
    store.commitResponses('s', [
      { role: 'assistant', requestReceiptId: receipt.id },
    ]),
  ).resolves.toBeUndefined();
});
