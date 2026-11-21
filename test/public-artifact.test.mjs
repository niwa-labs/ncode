import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractMcodeToolsArtifact, MCODE_TOOLS_ARTIFACT } from '../scripts/lib/mcode-tools-artifact.mjs';

test('public archive yields the exact embedded production tool artifact', async () => {
  const archive = readFileSync(new URL('../.cache/artifacts/code-0.3.11.tgz', import.meta.url));
  const extracted = await extractMcodeToolsArtifact(archive);
  const built = readFileSync(new URL('../dist/embedded/mcode-tools/cli.mjs', import.meta.url));
  assert.deepEqual(extracted.cli, built);
  assert.equal(createHash('sha256').update(built).digest('hex'), MCODE_TOOLS_ARTIFACT.sha256);
  assert.equal(JSON.parse(extracted.manifest).auth.mode, 'shared-broker');
});

test('modified public archives fail before any artifact is accepted', async () => {
  const archive = readFileSync(new URL('../.cache/artifacts/code-0.3.11.tgz', import.meta.url));
  archive[archive.length - 1] ^= 1;
  await assert.rejects(extractMcodeToolsArtifact(archive), /integrity mismatch/);
});

test('the built mcode-tools CLI starts independently and exposes its commands', () => {
  const cli = fileURLToPath(new URL('../dist/mcode-tools.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /mcode-tools/);
});

test('the built image preview worker processes a synthetic PNG and exits cleanly', { timeout: 15000 }, async (t) => {
  const { Worker } = await import('node:worker_threads');
  const worker = new Worker(new URL('../dist/image-preview-worker.js', import.meta.url), {
    workerData: {
      bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGP4n8LwnxLMMGrAqAGjBgwXAwCOqWIfmQV0zAAAAABJRU5ErkJggg==', 'base64'),
      mimeType: 'image/png',
      maxWidth: 960,
    },
  });
  // Allow normal Worker/WASM teardown after the reply. A message alone does
  // not prove a clean exit; force termination is only timeout/failure cleanup.
  t.after(() => worker.terminate());
  const preview = await new Promise((resolve, reject) => {
    let response;
    worker.once('message', (value) => { response = value; });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Preview worker exited with code ${code}`));
      else resolve(response);
    });
  });
  assert.equal(typeof preview, 'string');
  assert.deepEqual([...Buffer.from(preview, 'base64').subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});

test('the bundled Codemode worker loads its QuickJS module and calls a tool', { timeout: 15000 }, async (t) => {
  const { Worker } = await import('node:worker_threads');
  const wasm = await WebAssembly.compile(readFileSync(new URL('../dist/quickjs.wasm', import.meta.url)));
  const worker = new Worker(new URL('../dist/codemode-worker.js', import.meta.url), {
    workerData: {
      code: 'const result = await tools.echo({ n: 41 }); return result.n + 1;',
      tools: [{ name: 'echo', jsName: 'echo', description: 'Return the input.' }],
      globals: [],
      memoryLimitBytes: 32 * 1024 * 1024,
      store: {},
      interrupt: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
      wasm,
    },
  });
  t.after(() => worker.terminate());
  const calls = [];
  const result = await new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.once('exit', (code) => reject(new Error(`Codemode worker exited with code ${code}`)));
    worker.on('message', (message) => {
      if (message.type === 'call') {
        calls.push({ target: message.target, name: message.name, args: message.args });
        worker.postMessage({ type: 'result', id: message.id, ok: true, payload: message.args });
      } else if (message.type === 'crash') {
        reject(new Error(message.message));
      } else if (message.type === 'done') {
        resolve(message);
      }
    });
  });
  assert.deepEqual(calls, [{ target: 'tool', name: 'echo', args: '{"n":41}' }]);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value, '42');
});
