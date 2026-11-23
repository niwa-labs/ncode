import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';

import { Ncode } from '../src/index.js';
import type { NcodeOptions } from '../src/index.js';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));

export const FAKE_NCODE = join(fixtures, 'cli-package', 'ncode.mjs');

export type Fixture = 'success-tools' | 'failed-upstream' | 'resumed' | 'cancelled';

export function fixture(name: Fixture): string {
  return join(fixtures, `${name}.jsonl`);
}

export function fixtureEvents(name: Fixture): Record<string, unknown>[] {
  return readFileSync(fixture(name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'code-sdk-test-'));
  tempDirs.push(dir);
  return dir;
}

export interface FakeEnv {
  readonly FAKE_NCODE_FIXTURE?: string;
  readonly FAKE_NCODE_EXIT?: string;
  readonly FAKE_NCODE_STDERR?: string;
  readonly FAKE_NCODE_MODE?: 'normal' | 'wait-sigint' | 'ignore-signals' | 'hang';
  readonly FAKE_NCODE_SPLIT?: string;
  readonly FAKE_NCODE_PREFIX?: string;
  readonly FAKE_NCODE_VERSION?: string;
  readonly FAKE_NCODE_VERSION_LOG?: string;
  readonly FAKE_NCODE_RECORD?: string;
  readonly FAKE_NCODE_GRANDCHILD_PID?: string;
  readonly FAKE_NCODE_SIGNAL_LOG?: string;
}

export function fakeClient(fake: FakeEnv, options: Omit<NcodeOptions, 'env'> = {}): Ncode {
  return new Ncode({
    bin: FAKE_NCODE,
    ...options,
    env: { PATH: process.env.PATH, ...fake },
  });
}

export interface Recorded {
  readonly argv: string[];
  readonly stdin: string;
  readonly env: { MINIMAX_DATA_DIR: string | null };
  readonly promptFiles: Record<string, string>;
}

export function readRecord(path: string): Recorded {
  return JSON.parse(readFileSync(path, 'utf8')) as Recorded;
}
