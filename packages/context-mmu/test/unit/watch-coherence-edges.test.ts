/**
 * Watch coherence, edge by edge: subscription reference counting, released
 * pages, the replacement chain, and the closed-MMU guard.
 *
 * `coherence.test.ts` covers the main staleness flow. This file covers the
 * boundaries the flow depends on.
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buf, makeMmu, shaOf, sleep, until } from './helpers.js';

const DEBOUNCE_MS = 20;

async function makeFiles(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'mcode-mmu-watch-'));
}

describe('subscription reference counting', () => {
  it('keeps watching while another disposer is alive', { timeout: 20_000 }, async () => {
    const { mmu, dispose } = await makeMmu({ watchDebounceMs: DEBOUNCE_MS });
    const files = await makeFiles();
    try {
      const file = path.join(files, 'shared.png');
      await writeFile(file, buf(10, 1));
      const handle = await mmu.pageFile(file);

      const stopFirst = mmu.watch([file]);
      const stopSecond = mmu.watch([file]);
      stopFirst(); // One disposer is gone; the path is still covered.

      await writeFile(file, buf(20, 2));
      await until(() => handle.stale, 'the page to be marked stale', 15_000);
      expect(handle.stale).toBe(true);
      expect(handle.replacedBy).toBeDefined();

      stopSecond();
    } finally {
      await rm(files, { recursive: true, force: true });
      await dispose();
    }
  });

  it('stops watching when the last disposer fires', { timeout: 20_000 }, async () => {
    const { mmu, dispose } = await makeMmu({ watchDebounceMs: DEBOUNCE_MS });
    const files = await makeFiles();
    try {
      const file = path.join(files, 'last.png');
      await writeFile(file, buf(10, 1));
      const handle = await mmu.pageFile(file);

      const stopFirst = mmu.watch([file]);
      const stopSecond = mmu.watch([file]);
      stopFirst();
      stopSecond();

      await writeFile(file, buf(30, 3));
      await sleep(400);
      expect(handle.stale).toBe(false);
      expect(handle.replacedBy).toBeUndefined();
    } finally {
      await rm(files, { recursive: true, force: true });
      await dispose();
    }
  });
});

describe('a released page', () => {
  it('is never marked stale by a later file change', { timeout: 20_000 }, async () => {
    const { mmu, dispose } = await makeMmu({ watchDebounceMs: DEBOUNCE_MS });
    const files = await makeFiles();
    try {
      const file = path.join(files, 'released.png');
      await writeFile(file, buf(10, 4));
      const handle = await mmu.pageFile(file);

      mmu.release(handle);
      const stop = mmu.watch([file]);
      try {
        await writeFile(file, buf(20, 5));
        await sleep(400);
        // A released page is out of the coherence contract: it stays released.
        expect(handle.stale).toBe(false);
        expect(handle.replacedBy).toBeUndefined();
        expect(mmu.statusOf(handle)).toBe('released');
      } finally {
        stop();
      }
    } finally {
      await rm(files, { recursive: true, force: true });
      await dispose();
    }
  });
});

describe('the replacement chain', () => {
  it('a second content change stales the replacement too', { timeout: 20_000 }, async () => {
    const { mmu, dispose } = await makeMmu({ watchDebounceMs: DEBOUNCE_MS });
    const files = await makeFiles();
    try {
      const file = path.join(files, 'chain.png');
      const first = buf(10, 6);
      const second = buf(20, 7);
      const third = buf(30, 8);
      await writeFile(file, first);

      const handle = await mmu.pageFile(file);
      const stop = mmu.watch([file]);
      try {
        await writeFile(file, second);
        await until(() => handle.stale, 'the original page to go stale', 15_000);
        const replacement = handle.replacedBy!;
        expect(replacement.sha256).toBe(shaOf(second));
        expect(replacement.previousSha256).toBe(shaOf(first));

        // The replacement is bound to the same path: the next change catches it.
        await writeFile(file, third);
        await until(() => replacement.stale, 'the replacement to go stale', 15_000);
        const next = replacement.replacedBy!;
        expect(next.sha256).toBe(shaOf(third));
        expect(next.previousSha256).toBe(shaOf(second));
        // The chain keeps the ORIGINAL handle pointing at the first replacement.
        expect(handle.replacedBy).toBe(replacement);
      } finally {
        stop();
      }
    } finally {
      await rm(files, { recursive: true, force: true });
      await dispose();
    }
  });
});

describe('the closed MMU', () => {
  it('refuses to watch new paths', async () => {
    const { mmu, dispose } = await makeMmu();
    try {
      mmu.close();
      expect(() => mmu.watch('/tmp')).toThrow(/closed/);
    } finally {
      await dispose();
    }
  });

  it('refuses to create new pages', async () => {
    const { mmu, dispose } = await makeMmu();
    try {
      mmu.close();
      expect(() => mmu.page({ sha256: shaOf(buf(4, 1)), mime: 'image/png', bytes: buf(4, 1) })).toThrow(/closed/);
    } finally {
      await dispose();
    }
  });
});
