import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { openCas } from '../../src/cas.js';

/**
 * A publisher that stalls between "the tmp file is written" and "the blob is
 * linked", i.e. exactly the window `kill -9` hits. It creates the tmp file
 * with the store's own naming scheme and then blocks, so the parent can
 * SIGKILL it and inherit the post-mortem filesystem state.
 */
const STALLING_PUBLISHER = `
const fs = require('node:fs');
const path = require('node:path');
const tmpDir = process.argv[1];
const name = process.argv[2];
fs.mkdirSync(tmpDir, { recursive: true });
const file = path.join(tmpDir, name);
const fd = fs.openSync(file, 'w');
fs.writeSync(fd, Buffer.alloc(4096, 0x41));
setInterval(() => {}, 1000);
`;

const GRACE_PERIOD_MS = 60 * 60 * 1000;

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'mcode-cas-sweep-'));
}

async function tmpEntries(root: string): Promise<string[]> {
  return readdir(path.join(root, 'tmp'));
}

/** Ages a tmp file past the orphan grace period, as a crash would. */
async function age(pathname: string, ageMs = GRACE_PERIOD_MS * 2): Promise<void> {
  const when = new Date(Date.now() - ageMs);
  await utimes(pathname, when, when);
}

async function waitForFile(pathname: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(pathname)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${pathname}`);
}

describe('cas tmp sweep after a killed publisher', () => {
  it('keeps the orphan of a SIGKILLed publisher until the grace period passes, then sweeps it', async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, 'cas'), { recursive: true });
    await mkdir(path.join(root, 'tmp'), { recursive: true });
    const digest = createHash('sha256').update('killed-publication').digest('hex');
    const tmpName = `${digest}-11111111-2222-3333-4444-555555555555.tmp`;
    const tmpPath = path.join(root, 'tmp', tmpName);

    // A publisher is killed between the write and the commit.
    const child = spawn(process.execPath, ['-e', STALLING_PUBLISHER, path.join(root, 'tmp'), tmpName], {
      stdio: 'ignore',
    });
    await waitForFile(tmpPath);
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));

    // The post-mortem state: an orphan tmp file and no published blob.
    expect(await tmpEntries(root)).toEqual([tmpName]);
    expect(await readdir(path.join(root, 'cas'))).toEqual([]);

    // A store opened right after the kill does NOT sweep the orphan: the
    // grace period protects a publication that is still alive.
    const store = await openCas(root);
    expect(await tmpEntries(root)).toEqual([tmpName]);

    // The store stays fully usable while the orphan sits in the tmp dir.
    const payload = Buffer.from('usable-while-the-orphan-waits', 'utf8');
    const published = await store.putBytes(payload);
    expect(await store.get(published.sha256)).toEqual(payload);

    // Once the orphan is older than the grace period, the next open sweeps it.
    await age(tmpPath);
    const reopened = await openCas(root);
    expect(await tmpEntries(root)).toEqual([]);
    // The published blob survives the sweep.
    expect(await reopened.get(published.sha256)).toEqual(payload);
  });

  it('sweeps orphans of every tmp naming scheme the store uses', async () => {
    const root = await makeRoot();
    const store = await openCas(root);
    const tmpDir = path.join(root, 'tmp');
    const digest = createHash('sha256').update('naming-schemes').digest('hex');
    const names = [
      `incoming-11111111-2222-3333-4444-555555555555.tmp`,
      `${digest}-11111111-2222-3333-4444-555555555555.tmp`,
      `base64-11111111-2222-3333-4444-555555555555.tmp`,
    ];
    for (const name of names) {
      const file = path.join(tmpDir, name);
      await writeFile(file, 'partial-bytes');
      await age(file);
    }

    await openCas(root);

    expect(await tmpEntries(root)).toEqual([]);
    // The store still works after the sweep.
    const payload = Buffer.from('after-the-sweep', 'utf8');
    const published = await store.putBytes(payload);
    expect(await store.get(published.sha256)).toEqual(payload);
    expect(await tmpEntries(root)).toEqual([]);
  });

  it('keeps a fresh tmp file: the grace period protects a live publication', async () => {
    const root = await makeRoot();
    await openCas(root);
    const fresh = path.join(root, 'tmp', 'live-publisher.tmp');
    await writeFile(fresh, 'still-being-written');

    await openCas(root);

    expect(await tmpEntries(root)).toEqual(['live-publisher.tmp']);
    expect((await stat(fresh)).size).toBeGreaterThan(0);
  });

  it('ignores non-file entries in the tmp dir', async () => {
    const root = await makeRoot();
    await openCas(root);
    const nested = path.join(root, 'tmp', 'not-a-file');
    await mkdir(nested, { recursive: true });
    await age(nested);

    await openCas(root);

    // Directories are skipped by the sweep: only regular files are orphans.
    expect(await tmpEntries(root)).toEqual(['not-a-file']);
  });

  it('sweeps the orphan of a digest whose blob was published before the crash', async () => {
    const root = await makeRoot();
    const store = await openCas(root);
    const payload = Buffer.from('published-before-the-crash', 'utf8');
    const published = await store.putBytes(payload);

    // A second tmp copy of the same content, left behind by a crashed writer.
    const orphan = path.join(root, 'tmp', `${published.sha256}-99999999-8888-7777-6666-555555555555.tmp`);
    await writeFile(orphan, 'partial-bytes');
    await age(orphan);

    const reopened = await openCas(root);

    expect(await tmpEntries(root)).toEqual([]);
    expect(await reopened.get(published.sha256)).toEqual(payload);
  });

  it('starts from a clean tmp dir when the store is opened on a fresh root', async () => {
    const root = await makeRoot();
    const store = await openCas(root);

    expect(await tmpEntries(root)).toEqual([]);
    const payload = Buffer.from('fresh-root', 'utf8');
    const published = await store.putBytes(payload);
    expect(await tmpEntries(root)).toEqual([]);
    expect(await store.get(published.sha256)).toEqual(payload);
  });
});
