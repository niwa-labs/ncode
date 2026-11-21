/**
 * Wave 4 (verdict 09 §5.4 №19, form test): the task tool's model-facing
 * description must promise owner-input release ONLY on runtimes that own the
 * native task-wait binding. A registry built with `taskToolReactive: false`
 * (the wiring value of `host.nativeTaskWaits !== undefined` — JSONL
 * persistence, embeddings) carries the honest non-reactive contract instead:
 * no release promise, an explicit statement that a foreground wait is never
 * released, and the untouched explicit-background notice contract.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';

import {
  LocalTaskOutputToolDef,
  LOCAL_TASK_NON_REACTIVE_CONTRACT,
  LOCAL_TASK_OUTPUT_TOOL_DESCRIPTION,
  LOCAL_TASK_OUTPUT_TOOL_DESCRIPTION_NON_REACTIVE,
  LOCAL_TASK_REACTIVE_RELEASE_CONTRACT,
  LOCAL_TASK_TOOL_DESCRIPTION,
  LOCAL_TASK_TOOL_DESCRIPTION_NON_REACTIVE,
} from './builtin-defs.js';
import {
  buildLocalToolRegistry,
  type LocalToolRegistryDeps,
} from './index.js';
import type { LocalTaskAdapter } from './types.js';

const REACTIVE_PROMISE = 'the runtime releases those waits';
const HONEST_STATEMENT = 'does NOT move it to the background';

const baseDeps = {
  workspaceRoot: '/tmp/unused',
  bashEnvPolicy: { mode: 'off' },
} as unknown as LocalToolRegistryDeps;

const taskAdapter = {
  runForeground: async () => {
    throw new Error('not executed in this form test');
  },
} as unknown as LocalTaskAdapter;

describe('task tool description follows the release capability (§5.4 №19)', () => {
  it('the durable (default) description carries the §2.3 reactive contract verbatim', () => {
    expect(LOCAL_TASK_TOOL_DESCRIPTION).toContain(LOCAL_TASK_REACTIVE_RELEASE_CONTRACT);
    expect(LOCAL_TASK_TOOL_DESCRIPTION).toContain(REACTIVE_PROMISE);
    expect(LOCAL_TASK_TOOL_DESCRIPTION).not.toContain('does NOT move');
  });

  it('the reactive contract pins the no-wait-by-default owner-input rule (§2.3, owner bug 2026-11-06)', () => {
    // The contract is wrapped at ~80 columns; pin the sentences on a
    // whitespace-normalized copy so re-wrapping cannot silently drop them.
    const flat = LOCAL_TASK_REACTIVE_RELEASE_CONTRACT.replace(/\s+/gu, ' ');
    expect(flat).toContain(
      'When the user sends a message while a background task runs, respond to the user now.',
    );
    expect(flat).toContain(
      "Do NOT call task_output with waiting unless the user explicitly asked you to wait for this task's completion in this turn.",
    );
    expect(flat).toContain(
      'The completion notice already carries the full output — read it there; task_output is for re-reading or when the user asks for more detail.',
    );
  });

  it('the non-reactive contract never promises the owner-input wait release', () => {
    expect(LOCAL_TASK_NON_REACTIVE_CONTRACT).not.toContain(
      'Do NOT call task_output with waiting',
    );
  });

  it('the non-reactive description never promises release and states the honest contract', () => {
    expect(LOCAL_TASK_TOOL_DESCRIPTION_NON_REACTIVE).toContain(
      LOCAL_TASK_NON_REACTIVE_CONTRACT,
    );
    expect(LOCAL_TASK_TOOL_DESCRIPTION_NON_REACTIVE).toContain(HONEST_STATEMENT);
    expect(LOCAL_TASK_TOOL_DESCRIPTION_NON_REACTIVE).not.toContain(REACTIVE_PROMISE);
    // The explicit-background notice contract is intact — JSONL keeps it.
    expect(LOCAL_TASK_TOOL_DESCRIPTION_NON_REACTIVE).toContain(
      'still deliver their completion notice automatically',
    );
    expect(LOCAL_TASK_TOOL_DESCRIPTION_NON_REACTIVE).toContain(
      'A normal turn ending does not cancel background tasks.',
    );
  });

  it('a registry without the reactive capability swaps the task and task_output descriptions', () => {
    const taskControlAdapter = {} as unknown as NonNullable<
      LocalToolRegistryDeps['taskControlAdapter']
    >;
    const reactive = buildLocalToolRegistry({
      ...baseDeps,
      taskAdapter,
      taskControlAdapter,
    });
    const nonReactive = buildLocalToolRegistry({
      ...baseDeps,
      taskAdapter,
      taskControlAdapter,
      taskToolReactive: false,
    });

    const reactiveTask = reactive.get('task');
    const nonReactiveTask = nonReactive.get('task');
    expect(reactiveTask).toBeDefined();
    expect(nonReactiveTask).toBeDefined();
    expect(reactiveTask!.def.description).toBe(LOCAL_TASK_TOOL_DESCRIPTION);
    expect(reactiveTask!.def.description).toContain(REACTIVE_PROMISE);

    expect(nonReactiveTask!.def.description).toBe(LOCAL_TASK_TOOL_DESCRIPTION_NON_REACTIVE);
    expect(nonReactiveTask!.def.description).not.toContain(REACTIVE_PROMISE);
    // The schema and the execution semantics are identical — only the promise changes.
    expect(nonReactiveTask!.def.schema).toBe(reactiveTask!.def.schema);
    expect(nonReactiveTask!.def.executionMode).toBe(reactiveTask!.def.executionMode);
    // Sibling tools keep their identities; task_output swaps its description
    // the same way (no early-release promise without the native binding).
    expect(nonReactiveTask!.def.name).toBe(reactiveTask!.def.name);
    expect(nonReactive.get('task_query')).toBeDefined();
    expect(nonReactive.get('task_output')!.def.description).toBe(
      LOCAL_TASK_OUTPUT_TOOL_DESCRIPTION_NON_REACTIVE,
    );
    expect(nonReactive.get('task_stop')).toBeDefined();
  });

  it('an absent flag keeps the legacy reactive description (byte-identical behavior)', () => {
    const registry = buildLocalToolRegistry({ ...baseDeps, taskAdapter });
    expect(registry.get('task')!.def.description).toBe(LOCAL_TASK_TOOL_DESCRIPTION);
  });
});

describe('task_output text pins the no-wait-by-default contract (owner bug 2026-11-06)', () => {
  it('the wait_ms parameter is an explicit wait; the default returns immediately', () => {
    const schemaDescription = (LocalTaskOutputToolDef.schema.properties.wait_ms as {
      description: string;
    }).description;
    expect(schemaDescription).toContain('Explicit wait only.');
    expect(schemaDescription).toContain(
      'Set wait_ms only when the user explicitly asked you to wait for this task result in this turn.',
    );
    expect(schemaDescription).toContain('defaults to 0 (return immediately');
    expect(schemaDescription).toContain('no parking the turn');
    expect(schemaDescription).toContain('which carries the full output');
  });

  it('the reactive description promises the owner-input early release', () => {
    expect(LOCAL_TASK_OUTPUT_TOOL_DESCRIPTION).toContain(
      'By default (the user did not ask you to wait for this task in this turn) omit wait_ms: the read returns the current status and output immediately, without parking your turn.',
    );
    expect(LOCAL_TASK_OUTPUT_TOOL_DESCRIPTION).toContain(
      'If the user sends a new message while a wait is in flight, the read returns early with the output so far and the task keeps running in the background.',
    );
  });

  it('the non-reactive description keeps the default-no-wait rule without the release promise', () => {
    expect(LOCAL_TASK_OUTPUT_TOOL_DESCRIPTION_NON_REACTIVE).toContain(
      'By default (the user did not ask you to wait for this task in this turn) omit wait_ms',
    );
    expect(LOCAL_TASK_OUTPUT_TOOL_DESCRIPTION_NON_REACTIVE).not.toContain(
      'returns early with the output so far',
    );
  });
});
