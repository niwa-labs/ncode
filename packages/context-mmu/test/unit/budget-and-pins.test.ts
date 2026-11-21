/**
 * The MMU budget and pin contract: the 12 MiB default resident budget, the
 * option validation, and the pin semantics measured in turns.
 */

import { describe, expect, it } from 'vitest';

import { createMMU } from '../../src/mmu.js';
import type { CasStore } from '../../src/types.js';
import { buf, makeMmu, refOf } from './helpers.js';

const MIB = 1024 * 1024;

describe('the default resident budget', () => {
  it('is 12 MiB: a page of exactly the budget fits, one byte more never can', async () => {
    // No options at all: the default budget decides whether a page can ever
    // be resident. A page larger than the budget stays digest-only forever.
    const { mmu, dispose } = await makeMmu();
    try {
      const atBudget = buf(12 * MIB, 1);
      const overBudget = buf(12 * MIB + 1, 2);

      const fits = mmu.page(refOf(atBudget));
      expect(mmu.admit(fits)).toBe('resident');
      expect(mmu.stats()).toEqual({ resident: 1, bytes: 12 * MIB });

      const tooBig = mmu.page(refOf(overBudget));
      expect(mmu.admit(tooBig)).toBe('digest');
      expect(mmu.statusOf(tooBig)).toBe('digest');
      // The oversized page never occupies a resident slot.
      expect(mmu.stats().bytes).toBe(12 * MIB);
    } finally {
      await dispose();
    }
  });

  it('keeps the resident set at or under the budget with the default ratio', async () => {
    const { mmu, dispose } = await makeMmu({ maxResidentBytes: 300 });
    try {
      const pages = [1, 2, 3, 4].map((fill) => mmu.page(refOf(buf(100, fill))));
      for (const handle of pages) expect(mmu.admit(handle)).toBe('resident');
      // The default batch ratio (0.75) drains to 225 bytes in ONE pass.
      expect(mmu.stats().bytes).toBeLessThanOrEqual(225);
      expect(mmu.stats().bytes).toBeGreaterThan(0);
    } finally {
      await dispose();
    }
  });
});

describe('option validation', () => {
  it('rejects a negative budget', async () => {
    const { cas, dispose } = await makeMmu();
    try {
      expect(() => createMMU(cas as CasStore, { maxResidentBytes: -1 })).toThrow(/maxResidentBytes/);
    } finally {
      await dispose();
    }
  });

  it('accepts a zero budget: every page is digest-only', async () => {
    const { mmu, dispose } = await makeMmu({ maxResidentBytes: 0 });
    try {
      const handle = mmu.page(refOf(buf(16, 1)));
      expect(mmu.admit(handle)).toBe('digest');
      expect(mmu.stats()).toEqual({ resident: 0, bytes: 0 });
      // The bytes are still reachable — residency and access are separate.
      expect(await mmu.fault(handle)).toHaveLength(16);
      expect(mmu.statusOf(handle)).toBe('digest');
    } finally {
      await dispose();
    }
  });

  it('rejects a batch eviction ratio outside (0, 1]', async () => {
    const { cas, dispose } = await makeMmu();
    try {
      expect(() => createMMU(cas as CasStore, { batchEvictRatio: 0 })).toThrow(/batchEvictRatio/);
      expect(() => createMMU(cas as CasStore, { batchEvictRatio: -0.5 })).toThrow(/batchEvictRatio/);
      expect(() => createMMU(cas as CasStore, { batchEvictRatio: 1.5 })).toThrow(/batchEvictRatio/);
      expect(() => createMMU(cas as CasStore, { batchEvictRatio: 1 })).not.toThrow();
    } finally {
      await dispose();
    }
  });
});

describe('the pin contract', () => {
  it('rejects a non-positive or fractional turn count', async () => {
    const { mmu, dispose } = await makeMmu({ maxResidentBytes: 300 });
    try {
      const handle = mmu.page(refOf(buf(100, 1)));
      expect(() => mmu.pin(handle, 0)).toThrow(/positive integer/);
      expect(() => mmu.pin(handle, -1)).toThrow(/positive integer/);
      expect(() => mmu.pin(handle, 1.5)).toThrow(/positive integer/);
      expect(() => mmu.pin(handle, Number.NaN)).toThrow(/positive integer/);
    } finally {
      await dispose();
    }
  });

  it('takes the LONGER of two pins, not their sum', async () => {
    const { mmu, dispose } = await makeMmu({ maxResidentBytes: 300 });
    try {
      const pages = [1, 2, 3, 4, 5, 6].map((fill) => mmu.page(refOf(buf(100, fill))));
      mmu.pin(pages[0]!, 2);
      mmu.pin(pages[0]!, 5); // The longer pin wins: 5 turns, NOT 2 + 5 = 7.
      for (const handle of pages.slice(0, 3)) mmu.admit(handle);

      // Turn 4: still inside the 5-turn window.
      for (let turn = 0; turn < 4; turn += 1) mmu.advanceTurn();
      mmu.admit(pages[3]!);
      expect(mmu.statusOf(pages[0]!)).toBe('resident');

      // Turn 5: the countdown expired, the page is evictable like any other.
      mmu.advanceTurn();
      mmu.admit(pages[4]!);
      mmu.admit(pages[5]!);
      expect(mmu.statusOf(pages[0]!)).toBe('digest');
    } finally {
      await dispose();
    }
  });

  it('defaults to a four-turn pin', async () => {
    const { mmu, dispose } = await makeMmu({ maxResidentBytes: 300 });
    try {
      const pages = [1, 2, 3, 4, 5, 6].map((fill) => mmu.page(refOf(buf(100, fill))));
      mmu.pin(pages[0]!); // No count: the default pin lifetime applies.
      for (const handle of pages.slice(0, 3)) mmu.admit(handle);

      // Turns 1..3: protected.
      for (let turn = 0; turn < 3; turn += 1) mmu.advanceTurn();
      mmu.admit(pages[3]!);
      expect(mmu.statusOf(pages[0]!)).toBe('resident');

      // Turn 4: the default countdown expired.
      mmu.advanceTurn();
      mmu.admit(pages[4]!);
      mmu.admit(pages[5]!);
      expect(mmu.statusOf(pages[0]!)).toBe('digest');
    } finally {
      await dispose();
    }
  });

  it('pinning never makes a digest-only page resident', async () => {
    const { mmu, dispose } = await makeMmu({ maxResidentBytes: 10 });
    try {
      const handle = mmu.page(refOf(buf(100, 1))); // Larger than the budget.
      mmu.pin(handle, 5);
      expect(mmu.statusOf(handle)).toBe('new');
      // A pin is an eviction shield, not an admission.
      expect(mmu.admit(handle)).toBe('digest');
      expect(mmu.statusOf(handle)).toBe('digest');
      expect(mmu.stats().resident).toBe(0);
    } finally {
      await dispose();
    }
  });

  it('a re-pin after the countdown expired starts from the current turn', async () => {
    const { mmu, dispose } = await makeMmu({ maxResidentBytes: 300 });
    try {
      const pages = [1, 2, 3, 4, 5, 6].map((fill) => mmu.page(refOf(buf(100, fill))));
      mmu.pin(pages[0]!, 1);
      for (const handle of pages.slice(0, 3)) mmu.admit(handle);

      mmu.advanceTurn(); // Turn 1: the 1-turn pin expired.
      mmu.pin(pages[0]!, 3); // Re-pinned from the CURRENT turn.
      for (let turn = 0; turn < 2; turn += 1) mmu.advanceTurn();
      mmu.admit(pages[3]!);
      mmu.admit(pages[4]!);
      // Turn 3: still inside the re-pinned window (1 + 3 = 4).
      expect(mmu.statusOf(pages[0]!)).toBe('resident');
      mmu.advanceTurn(); // Turn 4: expired.
      mmu.admit(pages[5]!);
      expect(mmu.statusOf(pages[0]!)).toBe('digest');
    } finally {
      await dispose();
    }
  });
});
