/**
 * Live verification (§2 pins 2.1 / 2.5 / 2.6 / 2.9 / 2.10): the per-session
 * permission mode in `MCODE_SERVER_MODE=off` (the niwa path — one ACP process
 * IS the runtime). Runs the worktree CLI via tsx (no dist build needed):
 *
 *   child #1 (niwa-handshake + 2.1 + 2.5):
 *     initialize → session/new {cwd, mcpServers} (no _meta → snapshot auto)
 *     → set_config_option permissionMode=bypassPermissions (before any prompt)
 *     → model / thinkingEffort when advertised → prompt: non-safe bash with
 *       NO session/request_permission (2.9)
 *     → session #2 bound to default → the same bash ASKS (2.1)
 *     → session/load WITHOUT _meta → currentValue default (2.6)
 *   child #2 (niwa-resume, 2.10): a NEW process loads the first session with
 *     _meta bypassPermissions → prompt with no questions.
 *
 * Auth: copies the live profile's `auth/` tree into a THROWAWAY data dir
 * (see verify-acp-off-mode.mjs for the record-key rewrite).
 *
 * Prints `VERIFY-ACP-SESSION-MODE: PASS` and exits 0 on success.
 *
 * @module
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliEntry = join(repoRoot, 'packages', 'tui', 'src', 'index.ts');

const OVERALL_DEADLINE_MS = 360_000;
const dataDir = mkdtempSync(join(tmpdir(), 'acp-mode-'));
const workspace = join(dataDir, 'workspace');
mkdirSync(workspace, { recursive: true });
cpSync(join(homedir(), '.minimax', 'auth'), join(dataDir, 'auth'), { recursive: true });
// Bind the copied OAuth record to the throwaway dataDir path (same dance as
// verify-acp-off-mode.mjs).
{
	const clientId = 'mcode-public';
	const service = 'com.minimax.mcode.oauth.prod.en';
	const account = createHash('sha256')
		.update(`${join(dataDir, 'auth')}\u0000${clientId}`)
		.digest('base64url');
	const credPath = join(dataDir, 'auth', 'prod', 'en', clientId, 'auth.json');
	const cred = JSON.parse(readFileSync(credPath, 'utf-8'));
	const records = Object.entries(cred.records ?? {});
	for (const [key, value] of records) {
		if (key.startsWith(service)) {
			cred.records = { ...cred.records, [key]: undefined, [`${service}\u0000${account}`]: value };
			delete cred.records[key];
		}
	}
	writeFileSync(credPath, JSON.stringify(cred, null, 2));
}

class AcpChild {
	constructor() {
		this.startedAt = Date.now();
		this.pending = new Map();
		this.notifications = [];
		this.permissionAsks = [];
		this.activePolicy = { kind: 'allow_once', label: 'default' };
		this.nextId = 1;
		this.child = spawn(process.execPath, [
			join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
			'--tsconfig',
			join(repoRoot, 'tsconfig.standalone.json'),
			cliEntry,
			'acp',
		], {
			cwd: workspace,
			env: {
				...process.env,
				MCODE_SERVER_MODE: 'off',
				// The durable storage worker thread cannot run under tsx (it
				// resolves workspace deps to unbuilt dist/); the jsonl
				// compatibility mode keeps the same turn/permission path.
				MCODE_HISTORY_PROVIDER: 'jsonl',
				MCODE_LOG: 'warn,mcode:wire:error',
				LOG_LEVEL: 'warn',
				MINIMAX_DATA_DIR: dataDir,
				MAVIS_REGION: 'en',
				MAVIS_BUILD_ENV: 'prod',
				TZ: 'UTC',
			},
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		this.stderrTail = [];
		this.child.stderr.setEncoding('utf-8');
		this.child.stderr.on('data', (chunk) => {
			for (const line of chunk.split('\n')) if (line.trim()) this.stderrTail.push(line);
			if (this.stderrTail.length > 80) this.stderrTail.splice(0, this.stderrTail.length - 80);
		});
		let buffer = '';
		this.child.stdout.setEncoding('utf-8');
		this.child.stdout.on('data', (chunk) => {
			buffer += chunk;
			for (;;) {
				const nl = buffer.indexOf('\n');
				if (nl < 0) break;
				const line = buffer.slice(0, nl).trim();
				buffer = buffer.slice(nl + 1);
				if (!line) continue;
				let message;
				try {
					message = JSON.parse(line);
				} catch {
					continue;
				}
				if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
					const settle = this.pending.get(message.id);
					if (settle) {
						this.pending.delete(message.id);
						settle(message);
					}
					continue;
				}
				if (message.method === 'session/request_permission' && message.id !== undefined) {
					this.answerPermission(message);
					continue;
				}
				this.notifications.push(message);
			}
		});
	}

	answerPermission(message) {
		const params = message.params ?? {};
		this.permissionAsks.push({ phase: this.activePolicy.label, params });
		const optionId = (params.options ?? []).find((option) => option.kind === this.activePolicy.kind)?.optionId;
		const outcome = optionId === undefined ? { outcome: 'cancelled' } : { outcome: 'selected', optionId };
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { outcome } })}\n`);
	}

	send(method, params) {
		const id = this.nextId++;
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
		const left = OVERALL_DEADLINE_MS - (Date.now() - this.startedAt);
		const timeout = Math.max(left, 5_000);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`timeout waiting for ${method} (id ${id})`));
			}, timeout);
			this.pending.set(id, (message) => {
				clearTimeout(timer);
				resolve(message);
			});
		});
	}

	kill() {
		this.child.kill('SIGTERM');
		setTimeout(() => this.child.kill('SIGKILL'), 3_000).unref?.();
	}
}

const permissionOption = (response) =>
	(response?.configOptions ?? []).find((option) => option.id === 'permissionMode');

const expectOk = (response, label) => {
	if (response.error) throw new Error(`${label} failed: ${JSON.stringify(response.error)}`);
	return response.result;
};

const nonSafeBashPrompt = (marker) => [
	{
		type: 'text',
		text:
			`Use the bash tool to run exactly this command: python3 -c "print(${marker})" && echo done-${marker}. ` +
			'Then reply with the number it printed. No other tools.',
	},
];

const problems = [];
const check = (condition, message) => {
	if (!condition) problems.push(message);
};

async function runFirstChild() {
	const child = new AcpChild();
	try {
		const init = expectOk(await child.send('initialize', {
			protocolVersion: 1,
			clientCapabilities: {},
			clientInfo: { name: 'verify-acp-session-mode', version: '0.0.0' },
		}), 'initialize');
		check(
			init._meta?.['minimax-code/extensions']?.methods instanceof Array,
			'initialize did not advertise minimax-code/extensions',
		);

		// 2.5: session/new without _meta snapshots the process config (today auto).
		const first = expectOk(await child.send('session/new', { cwd: workspace, mcpServers: [] }), 'session/new #1');
		check(
			permissionOption(first)?.currentValue === 'auto',
			`2.5 new without _meta: expected auto snapshot, got ${permissionOption(first)?.currentValue}`,
		);
		console.log(`[child1] session #1 ${first.sessionId} snapshot=${permissionOption(first)?.currentValue}`);

		// 2.9 niwa-handshake: set_config_option BEFORE the first prompt moves the session.
		const setBypass = expectOk(await child.send('session/set_config_option', {
			sessionId: first.sessionId,
			configId: 'permissionMode',
			value: 'bypassPermissions',
		}), 'set_config_option bypassPermissions');
		check(
			permissionOption(setBypass)?.currentValue === 'bypassPermissions',
			`2.9 set_config_option: expected bypassPermissions, got ${permissionOption(setBypass)?.currentValue}`,
		);
		check(
			permissionOption(setBypass)?.description === 'Permission mode for this session; fixed after the first prompt',
			`2.2 option description mismatch: ${permissionOption(setBypass)?.description}`,
		);
		// niwa also sets model/thinkingEffort when advertised — drive them the same way.
		const modelOption = (setBypass.configOptions ?? []).find((option) => option.id === 'model');
		if (modelOption) {
			expectOk(await child.send('session/set_config_option', {
				sessionId: first.sessionId,
				configId: 'model',
				value: modelOption.currentValue,
			}), 'set_config_option model');
		}
		const effortOption = (setBypass.configOptions ?? []).find((option) => option.id === 'thinkingEffort');
		if (effortOption) {
			expectOk(await child.send('session/set_config_option', {
				sessionId: first.sessionId,
				configId: 'thinkingEffort',
				value: effortOption.currentValue,
			}), 'set_config_option thinkingEffort');
		}

		// 2.9: the non-safe bash runs with NO permission request in bypass.
		const marker1 = Math.floor(Math.random() * 100_000);
		const bypassTurn = expectOk(await child.send('session/prompt', {
			sessionId: first.sessionId,
			prompt: nonSafeBashPrompt(marker1),
		}), 'bypass prompt');
		check(bypassTurn.stopReason !== undefined, '2.9 bypass prompt ended without stopReason');
		const bypassAsks = child.permissionAsks.filter((ask) => ask.phase === 'default');
		check(bypassAsks.length === 0, `2.9 bypass session received ${bypassAsks.length} permission asks (expected 0)`);
		console.log(`[child1] 2.9 bypass turn stopReason=${bypassTurn.stopReason} asks=${bypassAsks.length}`);

		// 2.8: after the first prompt the mode is fixed.
		const fixed = await child.send('session/set_config_option', {
			sessionId: first.sessionId,
			configId: 'permissionMode',
			value: 'default',
		});
		check(
			fixed.error?.code === -32602 && fixed.error?.data?.currentValue === 'bypassPermissions',
			`2.8 post-prompt change not refused: ${JSON.stringify(fixed.error)}`,
		);

		// 2.1: a SECOND session in default asks for the same command.
		const second = expectOk(await child.send('session/new', {
			cwd: workspace,
			mcpServers: [],
			_meta: { 'minimax-code/permissionMode': 'default' },
		}), 'session/new #2 (default)');
		check(
			permissionOption(second)?.currentValue === 'default',
			`2.1 explicit default: got ${permissionOption(second)?.currentValue}`,
		);
		const marker2 = marker1 + 1;
		child.activePolicy = { kind: 'allow_once', label: 'default-session' };
		const defaultTurn = expectOk(await child.send('session/prompt', {
			sessionId: second.sessionId,
			prompt: nonSafeBashPrompt(marker2),
		}), 'default prompt');
		const defaultAsks = child.permissionAsks.filter((ask) => ask.phase === 'default-session');
		check(defaultAsks.length > 0, '2.1 default session never asked for the non-safe bash');
		console.log(`[child1] 2.1 default turn stopReason=${defaultTurn.stopReason} asks=${defaultAsks.length}`);

		// 2.4: invalid _meta rejects with the allowed list.
		const invalid = await child.send('session/new', {
			cwd: workspace,
			mcpServers: [],
			_meta: { 'minimax-code/permissionMode': 'off' },
		});
		check(
			invalid.error?.code === -32602 &&
				invalid.error?.data?.allowed?.includes('bypassPermissions') === true &&
				String(invalid.error.message).includes('invalid minimax-code/permissionMode'),
			`2.4 invalid _meta not rejected as specified: ${JSON.stringify(invalid.error)}`,
		);

		// 2.6: load WITHOUT _meta rebinds even a locked bypass session to default.
		const reloaded = expectOk(await child.send('session/load', {
			sessionId: first.sessionId,
			cwd: workspace,
			mcpServers: [],
		}), 'session/load #1 (no _meta)');
		check(
			permissionOption(reloaded)?.currentValue === 'default',
			`2.6 load without _meta: expected default, got ${permissionOption(reloaded)?.currentValue}`,
		);
		console.log(`[child1] 2.6 reload without _meta → ${permissionOption(reloaded)?.currentValue}`);

		return { firstSessionId: first.sessionId };
	} finally {
		child.kill();
		await new Promise((resolve) => setTimeout(resolve, 1_500));
	}
}

async function runSecondChild(firstSessionId) {
	const child = new AcpChild();
	try {
		expectOk(await child.send('initialize', {
			protocolVersion: 1,
			clientCapabilities: {},
			clientInfo: { name: 'verify-acp-session-mode-resume', version: '0.0.0' },
		}), 'initialize #2');

		// 2.10 niwa-resume: a NEW process re-binds the mode through load _meta.
		const loaded = expectOk(await child.send('session/load', {
			sessionId: firstSessionId,
			cwd: workspace,
			mcpServers: [],
			_meta: { 'minimax-code/permissionMode': 'bypassPermissions' },
		}), 'session/load #2 (bypass _meta)');
		check(
			permissionOption(loaded)?.currentValue === 'bypassPermissions',
			`2.10 load with _meta: expected bypassPermissions, got ${permissionOption(loaded)?.currentValue}`,
		);
		const marker3 = Math.floor(Math.random() * 100_000) + 500;
		const turn = expectOk(await child.send('session/prompt', {
			sessionId: firstSessionId,
			prompt: nonSafeBashPrompt(marker3),
		}), '2.10 resumed prompt');
		check(child.permissionAsks.length === 0, `2.10 resumed bypass session asked ${child.permissionAsks.length} times`);
		console.log(`[child2] 2.10 resumed turn stopReason=${turn.stopReason} asks=${child.permissionAsks.length}`);
	} finally {
		child.kill();
	}
}

let firstSessionId;
try {
	({ firstSessionId } = await runFirstChild());
	await runSecondChild(firstSessionId);
	if (problems.length > 0) {
		for (const problem of problems) console.error(`FAIL: ${problem}`);
		throw new Error(`${problems.length} assertion(s) failed`);
	}
	console.log('VERIFY-ACP-SESSION-MODE: PASS');
	process.exitCode = 0;
} catch (error) {
	console.error(`VERIFY-ACP-SESSION-MODE: FAIL — ${error.message}`);
	process.exitCode = 1;
} finally {
	setTimeout(() => {
		try {
			rmSync(dataDir, { recursive: true, force: true });
		} catch {}
	}, 4_000).unref?.();
}
