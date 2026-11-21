import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { compile } from '@earendil-works/pi-schema';
import { formats } from '@earendil-works/pi-schema/formats';
import {
  LOCAL_BROWSER_ACTION_INPUT_CONTRACTS,
  LocalBrowserToolDef,
} from './builtin-browser-defs.js';

// Regression (2026-11-11, live session): the declared schema of the compact
// `browser` tool enumerated `run_script` in its action enum but its input
// object carried no `code`/`path` fields, so the harness validation rejected
// every run_script call with "input.code: unknown field" before the runtime
// contract could accept it — the action was advertised yet unusable. This pin
// drives the EXACT production path (pi compiles the tool's TypeBox schema and
// parses call arguments through it, validateToolArguments) for both input
// shapes, and keeps the per-action exclusivity enforced at the runtime layer.
const validator = compile(LocalBrowserToolDef.schema as never, {
  formats,
  coerce: true,
  unresolvedRefs: 'reject',
});
const parse = (argumentsValue: unknown) => validator.parse(structuredClone(argumentsValue));

describe('browser tool declared schema admits run_script inputs', () => {
  it('accepts inline code (the field that failed in production)', () => {
    const result = parse({ action: 'run_script', input: { code: 'async (page) => 1;' } });
    expect(result.ok).toBe(true);
  });

  it('accepts a workspace path (the second production failure)', () => {
    const result = parse({ action: 'run_script', input: { path: '.pk-mobile-check.js' } });
    expect(result.ok).toBe(true);
  });

  it('the runtime contract still rejects code on a non-run_script action', () => {
    // The declared schema is the union of all action fields (like `kind`);
    // per-action exclusivity is enforced by the runtime input contracts.
    expect(Value.Check(LOCAL_BROWSER_ACTION_INPUT_CONTRACTS.fill.schema, { code: 'x' })).toBe(false);
  });
});
