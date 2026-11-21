import { describe, expect, it } from 'vitest';

import { createProductionRunawayGuardToolPolicies } from '../../../src/service/turn-system/runaway-guard/tool-policy.js';

const policies = createProductionRunawayGuardToolPolicies();

describe('production runaway-guard shell action skeleton (the live polling-loop fix)', () => {
  const project = (command: string): unknown =>
    policies['bash']?.projectActionKey?.({ command });

  it('collapses numeric variation: the same poll with different timestamps/pids/percentages is ONE action', () => {
    // Shapes from the live session: identical ssh status polls whose only
    // differences were embedded dates, pids and progress percentages.
    const a = project(
      "ssh log 'date -u; date\nP=$(pgrep -x logscan); echo STATUS 57% pid 3355970 22/748'",
    );
    const b = project(
      "ssh log 'date -u; date\nP=$(pgrep -x logscan); echo STATUS 58% pid 3355971 23/748'",
    );
    const c = project(
      "ssh log 'date -u; date\nP=$(pgrep -x logscan); echo STATUS 61% pid 3355970 25/748'",
    );
    expect(a).toEqual(b);
    expect(a).toEqual(c);
  });

  it('keeps structurally different commands distinct', () => {
    const grep = project('rg "TODO" src/');
    const build = project('pnpm build');
    const test = project('pnpm test');
    expect(grep).not.toEqual(build);
    expect(build).not.toEqual(test);
  });

  it('normalizes the command under whichever key carries it', () => {
    expect(policies['bash']?.projectActionKey?.({ cmd: 'sleep 30 && echo 42' })).toEqual(
      policies['bash']?.projectActionKey?.({ cmd: 'sleep 30 && echo 43' }),
    );
    expect(policies['zsh']?.projectActionKey?.({ script: 'kill -0 12345' })).toEqual(
      policies['zsh']?.projectActionKey?.({ script: 'kill -0 67890' }),
    );
  });

  it('accepts the documented collision price: kill -15 123 ≡ kill -18 456', () => {
    // Multi-digit signal and pid runs collapse to '#', so genuinely different
    // commands share one key (see the price comment on projectShellActionKey):
    // the worst case is one extra reminder marker, never a blocked tool.
    expect(project('kill -15 123')).toEqual(project('kill -18 456'));
    // The collision boundary: a single-digit signal survives the skeleton,
    // so a single-digit `-9` keeps commands distinct.
    expect(project('kill -9 123')).not.toEqual(project('kill -15 124'));
    // Single-digit variation in general remains meaningful.
    expect(project('sleep 5')).not.toEqual(project('sleep 7'));
  });

  it('falls back to raw arguments when no command key is present', () => {
    expect(policies['bash']?.projectActionKey?.({ timeoutMs: 1000 })).toEqual({
      timeoutMs: 1000,
    });
    expect(policies['bash']?.projectActionKey?.('not-a-record')).toBe('not-a-record');
  });
});
