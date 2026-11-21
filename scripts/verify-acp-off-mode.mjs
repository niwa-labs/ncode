/**
 * Live verification: ACP in MCODE_SERVER_MODE=off (the niwa path — one ACP
 * process IS the runtime, no daemon). Drives the real `dist/cli.js acp`
 * binary over stdio JSON-RPC exactly like an external harness:
 *
 *   initialize → session/new → session/prompt (a bash command OUTSIDE the
 *   safe first-word list, so the deterministic engine asks) → answers
 *   allow-once → expects the tool to run and the turn to end.
 *
 *   Second prompt answers reject-once → expects the turn to end with the
 *   tool rejected (no hang).
 *
 *   session/load resumes the same session (the owner's item-2 channel must
 *   have a working baseline in off mode).
 *
 * Auth: copies the live profile's `auth/` tree into a THROWAWAY data dir —
 * nothing in ~/.minimax is touched by the run itself (the session, its
 * durable files and permission rules all live in the temp dir).
 *
 * Prints `VERIFY-ACP-OFF-MODE: PASS` and exits 0 on success.
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
const distEntry = join(repoRoot, 'dist', 'cli.js');

const OVERALL_DEADLINE_MS = 240_000;
const startedAt = Date.now();
const deadlineLeft = () => OVERALL_DEADLINE_MS - (Date.now() - startedAt);

const dataDir = mkdtempSync(join(tmpdir(), 'acp-off-'));
const workspace = join(dataDir, 'workspace');
mkdirSync(workspace, { recursive: true });
// An existing directory inside the runtime root: the mutation canonical-path
// resolution needs an existing ancestor, and the marker file is inert.
mkdirSync(join(dataDir, 'runtime-verify'), { recursive: true });
// Step 6.5 resolves the mutation's canonical path from the EXISTING part of
// the tree, so the immune target must already exist (existing runtime files
// are exactly what the immunity protects; brand-new files are not).
const immuneTarget = join(dataDir, 'runtime-verify', 'base.txt');
writeFileSync(immuneTarget, 'verify\n');
cpSync(join(homedir(), '.minimax', 'auth'), join(dataDir, 'auth'), { recursive: true });
// The credential record key embeds sha256(`${authHome}\0mcode-public`) — the
// identity is bound to the dataDir PATH (opus 2026-11-01: identity =
// realpath(dataDir)). A copied auth tree therefore misses the record in a
// throwaway dataDir; rewrite the prod/en record key for the temp location so
// the child finds the tokens. The temp dir (tokens included) is deleted in
// the finally block.
{
	const clientId = 'mcode-public';
	const service = 'com.minimax.mcode.oauth.prod.en';
	const account = createHash('sha256')
		.update(`${join(dataDir, 'auth')}\u0000${clientId}`)
		.digest('base64url');
	const credPath = join(dataDir, 'auth', 'prod', 'en', clientId, 'auth.json');
	const cred = JSON.parse(readFileSync(credPath, 'utf8'));
	const records = Object.entries(cred.records ?? {});
	for (const [key, value] of records) {
		if (key.startsWith(service)) {
			cred.records = { ...cred.records, [key]: undefined, [`${service}\u0000${account}`]: value };
			delete cred.records[key];
		}
	}
	writeFileSync(credPath, JSON.stringify(cred, null, 2));
}

const child = spawn(
	process.execPath,
	[distEntry, 'acp'],
	{
		cwd: workspace,
		env: {
			...process.env,
			MCODE_SERVER_MODE: 'off',
			MCODE_LOG: 'warn,mcode:wire:error',
			LOG_LEVEL: 'warn',
			MINIMAX_DATA_DIR: dataDir,
			// The live profile's valid v2 auth-state lives under prod/en; the
			// cn tree is a legacy-format state the parser rejects.
			MAVIS_REGION: 'en',
			MAVIS_BUILD_ENV: 'prod',
		},
		stdio: ['pipe', 'pipe', 'pipe'],
	},
);

const stderrTail = [];
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
	for (const line of chunk.split('\n')) {
		if (line.trim()) stderrTail.push(line);
	}
	if (stderrTail.length > 80) stderrTail.splice(0, stderrTail.length - 80);
});

const nextId = { value: 1 };
const pending = new Map();
const notifications = [];
// The phase policy the CURRENT prompt uses: requests arriving mid-turn are
// answered with this policy's kind — exactly the niwa shape (optionId chosen
// by `kind` alone).
let activePolicy = { kind: 'allow_once', label: 'phase-1-allow' };
const permissionAsks = [];

function answerPermissionRequest(message) {
	const params = message.params ?? {};
	permissionAsks.push({ phase: activePolicy.label, params });
	const wanted = activePolicy.kind;
	const optionId = (params.options ?? []).find((option) => option.kind === wanted)?.optionId;
	const outcome = optionId === undefined ? { outcome: 'cancelled' } : { outcome: 'selected', optionId };
	child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { outcome } })}\n`);
}

let buffer = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
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
			const settle = pending.get(message.id);
			if (settle) {
				pending.delete(message.id);
				settle(message);
			}
			continue;
		}
		if (message.method === 'session/request_permission' && message.id !== undefined) {
			answerPermissionRequest(message);
			continue;
		}
		message._phase = activePolicy.label;
		notifications.push(message);
	}
});

function send(method, params) {
	const id = nextId.value++;
	child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
	const timeout = Math.max(deadlineLeft(), 5_000);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`timeout waiting for ${method} (id ${id})`));
		}, timeout);
		pending.set(id, (message) => {
			clearTimeout(timer);
			resolve(message);
		});
	});
}

const updatesOf = (phase) =>
	notifications
		.filter((m) => m._phase === phase && m.method === 'session/update')
		.map((m) => m.params?.update)
		.filter((u) => u && (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update'));

let currentSessionId;

try {
	// 1. initialize — the runtime boots BEFORE the reply (runTuiAcpCommand
	//    creates the runtime first), so this also proves off-mode boot.
	const init = await send('initialize', {
		protocolVersion: 1,
		clientCapabilities: {},
		clientInfo: { name: 'verify-acp-off-mode', version: '0.0.0' },
	});
	if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
	console.log(`[initialize] ok: protocol=${init.result?.protocolVersion}, agent=${init.result?.agentInfo?.name ?? '?'}`);

	// 2. session/new in off mode.
	// §2: bind the session to `default` — deterministic asks (no auto
// classifier), which is exactly what this verifier drives.
const created = await send('session/new', {
	cwd: workspace,
	mcpServers: [],
	_meta: { 'minimax-code/permissionMode': 'default' },
});
	if (created.error) throw new Error(`session/new failed: ${JSON.stringify(created.error)}`);
	currentSessionId = created.result?.sessionId;
	if (!currentSessionId) throw new Error(`session/new returned no sessionId: ${JSON.stringify(created.result)}`);
	console.log(`[session/new] sessionId=${currentSessionId}`);
	const modeOption = (created.result?.configOptions ?? []).find(
		(option) => option.id === 'permissionMode',
	);
	console.log(`[session/new] permissionMode currentValue=${JSON.stringify(modeOption?.currentValue)}`);
	if (modeOption?.currentValue !== 'default') {
		const setMode = await send('session/set_config_option', {
			sessionId: currentSessionId,
			configId: 'permissionMode',
			value: 'default',
		});
		console.log(`[set_config_option] ${JSON.stringify(setMode.error ?? setMode.result)}`);
	}

	const runPrompt = async (label, marker, text, expectAsk) => {
		activePolicy = {
			kind: expectAsk === false ? 'allow_once' : label === 'phase-1-allow' ? 'allow_once' : 'reject_once',
			label,
		};
		const response = await send('session/prompt', {
			sessionId: currentSessionId,
			prompt: [{ type: 'text', text }],
		});
		if (response.error) throw new Error(`${label}: session/prompt failed: ${JSON.stringify(response.error)}`);
		if (!response.result?.stopReason) throw new Error(`${label}: ended without stopReason`);
		const updates = updatesOf(label);
		console.log(
			`[${label}] stopReason=${response.result.stopReason} toolUpdates=${updates.length} asksSoFar=${permissionAsks.length}`,
		);
		return { response, updates };
	};

	const marker1 = Math.floor(Math.random() * 100_000);

	// 3. Bash smoke: a safe command executes without any ask.
	const smoke = await runPrompt(
		'smoke-bash',
		marker1,
		`Use the bash tool to run exactly this command: echo ${marker1}. Then reply with the number it printed. No other tools.`,
		false,
	);

	// 4. Immune ask, answered allow_once: a WRITE into the runtime tree
	//    (fs step 6.5) is bypass-immune — no classifier, one-time options
	//    only — and still crosses the ACP boundary in off mode.
	const turn1 = await runPrompt(
		'phase-1-allow',
		marker1 + 1,
		`Use the bash tool to run exactly this command: python3 -c \"print(${marker1 + 1}); open('/tmp/mcode-acp-off-${marker1 + 1}','w')\". Then reply with the number it printed. No other tools.`,
		true,
	);

	// 5. Same immune ask, answered reject_once — the call fails, the turn ends.
	const turn2 = await runPrompt(
		'phase-2-reject',
		marker1 + 2,
		`Use the bash tool to run exactly this command: python3 -c \"print(${marker1 + 2}); open('/tmp/mcode-acp-off-${marker1 + 2}','w')\". Then reply with the number it printed. No other tools.`,
		true,
	);

	// 5. session/load: resume the same session in the SAME off-mode process.
	const loaded = await send('session/load', { sessionId: currentSessionId, cwd: workspace, mcpServers: [] });
	if (loaded.error) throw new Error(`session/load failed: ${JSON.stringify(loaded.error)}`);
	console.log('[session/load] ok');

	// ---- Assertions ----
	const problems = [];
	// reject_once is strictly one-time (§1): a retry of the same command asks
	// again, so the reject phase may produce more than one ask.
	if (permissionAsks.length < 2) {
		problems.push(`expected at least 2 permission asks, got ${permissionAsks.length}`);
	}
	const asksWithKind = (kind) =>
		permissionAsks.filter((p) => (p.params?.options ?? []).some((o) => o.kind === kind));
	if (asksWithKind('allow_once').length === 0) problems.push('no permission request offered allow_once');
	if (asksWithKind('reject_once').length === 0) problems.push('no permission request offered reject_once');
	if (!permissionAsks.some((p) => p.params?.toolCall?.rawInput !== undefined && p.params?.toolCall?.kind !== undefined)) {
		problems.push('permission request lacked structured toolCall (kind + rawInput)');
	}
	const smokeCompleted = smoke.updates.some((u) => u.status === 'completed');
	if (!smokeCompleted) problems.push('the safe bash command never completed — tools do not run in off mode');
	const writeCompleted = turn1.updates.some((u) => u.status === 'completed');
	if (!writeCompleted) problems.push('the allowed immune write never completed');
	const outputSeen = notifications.some((m) => JSON.stringify(m).includes(String(marker1)));
	if (!outputSeen) problems.push(`tool output marker ${marker1} never appeared in any update`);
	// §3: an immune ask never offers allow_always / reject_always and must
	// reach the client in EVERY mode (the classifier is skipped).
	for (const [index, ask] of permissionAsks.entries()) {
		const kinds = (ask.params?.options ?? []).map((o) => o.kind);
		if (!kinds.includes('allow_once') || !kinds.includes('reject_once')) {
			problems.push(`ask #${index + 1} offered kinds "${kinds.join(',')}" — allow_once and reject_once must always be present`);
		}
	}
	// §4: the decidedBy mark rides existing tool_call updates as
	// _meta["minimax-code/permission"] — no new messages.
	const marks = notifications
		.map((m) => m.params?.update?._meta?.['minimax-code/permission'])
		.filter((mark) => mark !== undefined);
	if (marks.length === 0) {
		problems.push('no _meta["minimax-code/permission"] mark ever arrived on a tool_call update');
	} else {
		const shapeOk = marks.every(
			(mark) =>
				(mark.decision === 'allow' || mark.decision === 'deny') &&
				['classifier', 'rule', 'mode', 'hook', 'user'].includes(mark.decidedBy) &&
				['builtin', 'session', 'agent', 'global', null].includes(mark.ruleKind) &&
				typeof mark.mode === 'string' &&
				typeof mark.reason === 'string' &&
				mark.reason.length > 0,
		);
		if (!shapeOk) problems.push('a permission mark had a wrong shape (decision/decidedBy/ruleKind/mode/reason)');
		const userMarks = marks.filter((mark) => mark.decidedBy === 'user');
		if (userMarks.length === 0) {
			problems.push('no user-decided mark — the answered asks were not attributed to the user');
		}
	}
	const rejected = turn2.updates.some((u) => u.status === 'failed' || u.status === 'rejected');
	if (!rejected) problems.push('phase-2 reject did not surface as a failed/rejected tool call');
	if (problems.length > 0) {
		for (const problem of problems) console.error(`FAIL: ${problem}`);
		throw new Error(`${problems.length} assertion(s) failed`);
	}

	console.log(
		`[summary] asks=${permissionAsks.length} (${permissionAsks.map((p) => p.phase).join(',')}), kinds=${permissionAsks.flatMap((p) => (p.params?.options ?? []).map((o) => o.kind)).filter((k, i, a) => a.indexOf(k) === i).join(',')}`,
	);
	console.log('VERIFY-ACP-OFF-MODE: PASS');
	process.exitCode = 0;
} catch (error) {
	console.error(`VERIFY-ACP-OFF-MODE: FAIL — ${error.message}`);
	if (stderrTail.length > 0) {
		console.error('--- stderr tail ---');
		for (const line of stderrTail.slice(-40)) console.error(line);
	}
	console.error('--- last notifications ---');
	for (const message of notifications.slice(-10)) console.error(JSON.stringify(message).slice(0, 400));
	process.exitCode = 1;
} finally {
	child.kill('SIGTERM');
	setTimeout(() => child.kill('SIGKILL'), 3_000).unref?.();
	setTimeout(() => {
		try {
			rmSync(dataDir, { recursive: true, force: true });
		} catch {}
	}, 4_000).unref?.();
}
