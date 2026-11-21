/**
 * The fault path and the digest placeholder, edge by edge.
 *
 * `fault-and-digest.test.ts` covers the happy paths. This file pins the
 * boundaries: the publication happens EXACTLY once, a fault after eviction
 * still returns the original bytes, and the digest renders the dimension
 * edge cases exactly.
 */

import { describe, expect, it } from 'vitest';

import { createMMU, formatPageDigest } from '../../src/mmu.js';
import type { CasStore } from '../../src/types.js';
import { buf, makeMmu, refOf, shaOf } from './helpers.js';

describe('publishing pending bytes', () => {
  it('publishes to the CAS exactly once, however often the page is faulted', async () => {
    const { cas, dispose } = await makeMmu();
    try {
      let putBytesCalls = 0;
      const counting = new Proxy(cas, {
        get(target, property, receiver) {
          if (property === 'putBytes') {
            return async (...args: unknown[]) => {
              putBytesCalls += 1;
              return (target.putBytes as unknown as (...a: unknown[]) => unknown)(...args);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      }) as CasStore;

      const mmu = createMMU(counting);
      try {
        const data = buf(64, 9);
        const handle = mmu.page(refOf(data));
        expect(putBytesCalls).toBe(0); // Creating a page publishes nothing.

        expect(await mmu.fault(handle)).toEqual(data);
        expect(putBytesCalls).toBe(1);

        expect(await mmu.fault(handle)).toEqual(data);
        expect(await mmu.fault(handle)).toEqual(data);
        // The blob is durable after the first fault: no second publication.
        expect(putBytesCalls).toBe(1);
        expect(cas.has(shaOf(data))).toBe(true);
      } finally {
        mmu.close();
      }
    } finally {
      await dispose();
    }
  });

  it('returns the original bytes of an evicted page', async () => {
    const { mmu, dispose } = await makeMmu({ maxResidentBytes: 300 });
    try {
      const data = buf(100, 3);
      const evicted = mmu.page(refOf(data));
      const other = mmu.page(refOf(buf(100, 4)));
      mmu.admit(evicted);
      mmu.admit(other);
      expect(await mmu.fault(evicted)).toEqual(data);

      // Over-budget admission evicts the LRU tail.
      mmu.admit(mmu.page(refOf(buf(100, 5))));
      mmu.admit(mmu.page(refOf(buf(100, 6))));
      expect(mmu.statusOf(evicted)).toBe('digest');

      // The bytes are still the ORIGINAL ones: the CAS keeps them.
      expect(await mmu.fault(evicted)).toEqual(data);
    } finally {
      await dispose();
    }
  });

  it('never changes residency when it faults', async () => {
    const { mmu, dispose } = await makeMmu({ maxResidentBytes: 300 });
    try {
      const handle = mmu.page(refOf(buf(100, 1)));
      expect(mmu.statusOf(handle)).toBe('new');
      await mmu.fault(handle);
      expect(mmu.statusOf(handle)).toBe('new');
      expect(mmu.stats().resident).toBe(0);
    } finally {
      await dispose();
    }
  });
});

describe('the digest placeholder format', () => {
  it('collapses a HALF-known dimension to ?x?', () => {
    // Only one of width/height is known: the pair is unusable, so the
    // placeholder must not render a half-truth like "10x?".
    const withWidth = formatPageDigest({ sha256: 'abcdef0123456789', mime: 'image/png', width: 10 });
    const withHeight = formatPageDigest({ sha256: 'abcdef0123456789', mime: 'image/png', height: 20 });
    expect(withWidth).toContain('?x?');
    expect(withHeight).toContain('?x?');
    expect(withWidth).not.toContain('10x');
    expect(withHeight).not.toContain('x20');
  });

  it('renders known dimensions verbatim, including zero', () => {
    expect(formatPageDigest({ sha256: 'abcdef0123456789', mime: 'image/png', width: 0, height: 0 })).toContain(
      '0x0',
    );
    expect(formatPageDigest({ sha256: 'abcdef0123456789', mime: 'image/png', width: 1920, height: 1080 })).toContain(
      '1920x1080',
    );
  });

  it('distinguishes unknown dimensions from zero dimensions', () => {
    const unknown = formatPageDigest({ sha256: 'abcdef0123456789', mime: 'image/png' });
    const zero = formatPageDigest({ sha256: 'abcdef0123456789', mime: 'image/png', width: 0, height: 0 });
    expect(unknown).not.toBe(zero);
  });

  it('truncates the digest to the first hex quartet', () => {
    const digest = formatPageDigest({ sha256: 'abcdef0123456789', mime: 'image/png' });
    expect(digest).toContain('sha256:abcd…');
    expect(digest).not.toContain('abcdef01');
  });

  it('renders the mime verbatim', () => {
    expect(formatPageDigest({ sha256: 'abcdef0123456789', mime: 'image/webp' })).toContain('image/webp');
    expect(formatPageDigest({ sha256: 'abcdef0123456789', mime: 'application/pdf' })).toContain('application/pdf');
  });

  it('is a pure function of the identity fields', () => {
    const info = { sha256: 'abcdef0123456789', mime: 'image/png', width: 4, height: 5 };
    expect(formatPageDigest(info)).toBe(formatPageDigest({ ...info }));
  });
});

describe('the MMU digest agrees with the pure renderer', () => {
  it('renders the same placeholder for a page with one-sided dimensions', async () => {
    const { mmu, dispose } = await makeMmu();
    try {
      const data = buf(32, 2);
      const handle = mmu.page(refOf(data, { width: 12 }));
      expect(mmu.digest(handle)).toBe(
        formatPageDigest({ sha256: shaOf(data), mime: 'image/png', width: 12 }),
      );
      expect(mmu.digest(handle)).toContain('?x?');
    } finally {
      await dispose();
    }
  });
});
