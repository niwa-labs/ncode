/**
 * W3 gate: allowlist completeness (arch §4.3.6) — every CliService method the
 * TUI actually invokes must be allowlisted for the v2 wire. The single
 * documented exception is `watchEvents`, which rides the `subscribe` frame.
 *
 * The grep covers the two REAL shapes of CliService access in
 * `packages/tui/src`:
 * 1. direct calls on a `cliService`-named receiver (`cliService.x(...)`,
 *    `this.cliService.x(...)` in the runtime adapters);
 * 2. the `TuiRuntimeAccessContext.service('...').x(...)` chains of the
 *    adapters (goal/product/workspace access), including the multiline
 *    spelling `.service("op")\n .x(...)`.
 *
 * The task-brief §2.4 port table (the map the ask names) is pinned verbatim
 * as a second source: those names MUST be allowlisted too.
 *
 * @module
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
	REMOTE_CLI_METHODS,
	REMOTE_METHOD_EXCEPTIONS,
} from '../src/remote-methods.js';

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const TUI_SRC = path.join(REPO_ROOT, 'packages', 'tui', 'src');

/** Collect all `.ts` files under a directory. */
function listTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
		else if (entry.endsWith('.ts')) out.push(full);
	}
	return out;
}

/** Method names invoked on a cliService-named receiver. */
function grepDirectCliServiceCalls(files: string[]): Set<string> {
	const found = new Set<string>();
	const pattern = /\b(?:cliService|this\.cli)\.([a-zA-Z][a-zA-Z0-9_]*)\(/g;
	for (const file of files) {
		const source = readFileSync(file, 'utf8');
		for (const match of source.matchAll(pattern)) {
			found.add(match[1]!);
		}
	}
	return found;
}

/** Method names chained after `service('...')` across newlines. */
function grepChainedServiceCalls(files: string[]): Set<string> {
	const found = new Set<string>();
	const pattern = /\.service\((?:'[^']*'|"[^"]*")\)\s*\n?\s*\.([a-zA-Z][a-zA-Z0-9_]*)\(/g;
	for (const file of files) {
		const source = readFileSync(file, 'utf8');
		for (const match of source.matchAll(pattern)) {
			found.add(match[1]!);
		}
	}
	return found;
}

describe('allowlist completeness vs packages/tui/src (arch §4.3.6)', () => {
	const allowlist = new Set<string>(REMOTE_CLI_METHODS);
	const exceptions = new Set<string>(REMOTE_METHOD_EXCEPTIONS);

	it('greps the TUI sources and requires every invoked method to be allowlisted', () => {
		const files = listTsFiles(TUI_SRC);
		expect(files.length).toBeGreaterThan(50); // the grep really swept the tree
		const invoked = new Set<string>([
			...grepDirectCliServiceCalls(files),
			...grepChainedServiceCalls(files),
		]);
		expect(invoked.size).toBeGreaterThan(20); // the extraction really matched
		const missing: string[] = [];
		for (const method of invoked) {
			if (!allowlist.has(method) && !exceptions.has(method)) missing.push(method);
		}
		expect(missing, `methods the TUI calls but the v2 wire does not carry: ${missing.join(', ')}`).toEqual([]);
	});

	it('watchEvents is the ONLY exception (it rides subscribe, arch §4.3.6)', () => {
		const files = listTsFiles(path.join(TUI_SRC, 'runtime', 'adapters'));
		const invoked = new Set<string>([
			...grepDirectCliServiceCalls(files),
			...grepChainedServiceCalls(files),
		]);
		expect(invoked.has('watchEvents')).toBe(true); // the exception is real, not vestigial
		expect(REMOTE_METHOD_EXCEPTIONS).toEqual(['watchEvents']);
	});

	it('task-brief §2.4 port table is fully allowlisted (minus the exception)', () => {
		// The surface map the ask names: every method TUI consumes per port.
		const taskBriefSurface = [
			// SessionPort
			'createSession', 'listSessions', 'getSession', 'getMessages', 'updateSession',
			'archiveSession', 'deleteSession', 'listSessionInputSummaries',
			'getSessionRewindPreview', 'rewindSession', 'editSessionMessage',
			'configureSessionMcpServers', 'clearSessionMcpServers', 'forkSession',
			'getSessionForkOptions', 'getSessionTree',
			// ConversationPort
			'sendMessage', 'abortSession', 'steer', 'steerSession', 'enqueueMessage',
			// InteractionPort
			'getPendingQuestionnaire', 'replyQuestionnaire', 'dismissQuestionnaire',
			'getLatestPlanReview', 'getPlanModeCapabilities', 'listPendingPermissions',
			'replyPermission',
			// RuntimeEventPort
			'watchEvents',
			// GoalPort
			'isGoalEnabled', 'getGoal', 'createGoal', 'patchGoal', 'clearGoal',
			// QueuePort
			'listQueueMessages', 'updateQueueItem', 'deleteQueueItem',
			// InspectionPort
			'getSessionUsage', 'watchSessionUsageCommits', 'requestCompaction',
			'listSkills', 'collectSessionReport',
			// ConfigurationPort
			'getPermissionMode', 'setPermissionMode', 'listModels', 'selectModel',
			'getRuntimeDiagnostics', 'getAccountStatus', 'getInstructionSources',
			// Delegation / background
			'listBackgroundTasks',
			// SessionTurnPort
			'resumeSession',
			// Plugins
			'refreshPlugins', 'listMarketplacePlugins', 'listInstalledPlugins',
			// Workspace
			'getWorkspaceGitMetadata', 'listWorkspaceFileTree', 'searchWorkspaceFiles',
		];
		const missing = taskBriefSurface.filter(
			(method) => !allowlist.has(method) && !exceptions.has(method),
		);
		expect(missing, `task-brief §2.4 methods missing from REMOTE_CLI_METHODS: ${missing.join(', ')}`).toEqual([]);
	});
});
