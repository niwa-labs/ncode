/**
 * W4 (§4.4/R5): the per-session toolEnv snapshot reaches the bash spawn.
 *
 * The real spawn is exercised (`echo` of an env var + `pwd`) with a snapshot
 * supplied through the tool context — the exact consumer side of the
 * `session.attach{toolEnv}` channel. Daemon-reserved names must never leak
 * through even when a hostile window attaches them.
 *
 * @module
 */

import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LocalBashTool } from '../../src/desktop/local-pi-tools.js';
import type { LocalRuntimeToolContext } from '../../src/desktop/types.js';

const workspace = '/tmp';

function contextWith(
	toolEnv: { cwd?: string; env?: Record<string, string> } | undefined,
): LocalRuntimeToolContext {
	return {
		sessionId: 's-w4',
		turnId: 't-w4',
		...(toolEnv ? { toolEnv } : {}),
	} as LocalRuntimeToolContext;
}

async function run(tool: LocalBashTool, ctx: LocalRuntimeToolContext, command: string): Promise<string> {
	const result = await tool.execute(ctx, { command, description: 'w4 toolEnv probe' });
	return result.text;
}

describe('bash toolEnv overlay (W4 §4.4)', () => {
	it('spawns with the snapshot env instead of the daemon env', async () => {
		const tool = new LocalBashTool(workspace, undefined, { mode: 'off' });
		const text = await run(
			tool,
			contextWith({ env: { W4_PROBE: 'from-window' } }),
			'echo "$W4_PROBE"',
		);
		expect(text.trim()).toBe('from-window');
	});

	it('spawns with the snapshot cwd when provided', async () => {
		const tool = new LocalBashTool(workspace, undefined, { mode: 'off' });
		const dir = mkdtempSync(join(tmpdir(), 'w4-toolenv-'));
		const text = await run(tool, contextWith({ cwd: dir, env: {} }), 'pwd');
		// macOS reports the realpath of a temp dir (`/var` → `/private/var`).
		expect(text.trim()).toBe(realpathSync(dir));
	});

	it('without a snapshot the daemon env applies (off-path and embedded TUI unchanged)', async () => {
		const tool = new LocalBashTool(workspace, undefined, { mode: 'off' });
		const text = await run(tool, contextWith(undefined), 'echo "${W4_PROBE:-<unset>}"');
		expect(text.trim()).toBe('<unset>');
	});

	it('daemon-reserved names are stripped from the snapshot before spawn', async () => {
		const tool = new LocalBashTool(workspace, undefined, { mode: 'off' });
		const text = await run(
			tool,
			contextWith({ env: { MCODE_TOKEN: 'leak', MINIMAX_KEY: 'leak', W4_OK: '1' } }),
			'echo "${MCODE_TOKEN:-<stripped>}/${MINIMAX_KEY:-<stripped>}/$W4_OK"',
		);
		expect(text.trim()).toBe('<stripped>/<stripped>/1');
	});

	it('the sandbox path overlays the same snapshot (when the sandbox factory is absent, foreground matches)', async () => {
		// Direct-foreground path uses this.tool's hook; the sandbox construction
		// shares overlaySessionToolEnv — this pins the no-factory branch only.
		const tool = new LocalBashTool(workspace, undefined, { mode: 'off' });
		const text = await run(tool, contextWith({ env: { W4_PROBE: 'v2' } }), 'echo "$W4_PROBE"');
		expect(text.trim()).toBe('v2');
	});
});
