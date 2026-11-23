import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { Ncode, NcodeNotFoundError, NcodeVersionError } from '../src/index.js';
import {
  buildSpawnCommand,
  findOnPath,
  parseCmdShim,
  resolveCli,
  resolvePackageEntry,
} from '../src/cli-resolver.js';
import {
  checkCliVersion,
  MIN_CLI_VERSION,
  parseVersion,
  satisfiesMinimum,
} from '../src/version.js';
import { FAKE_NCODE, fakeClient, fixture, tempDir } from './helpers.js';

const isWindows = process.platform === 'win32';

/** Creates a platform-native `ncode` launcher in a fresh directory that runs the fake CLI. */
function installLauncher(name = 'ncode'): string {
  const dir = tempDir();
  if (isWindows) {
    mkdirSync(join(dir, 'node_modules', 'fake'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'fake', 'ncode.mjs'), readFileSync(FAKE_NCODE));
    writeFileSync(
      join(dir, `${name}.cmd`),
      `@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\fake\\ncode.mjs" %*\r\n`,
    );
  } else {
    const launcher = join(dir, name);
    writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_NCODE}" "$@"\n`);
    chmodSync(launcher, 0o755);
  }
  return dir;
}

describe('CLI resolution', () => {
  it('prefers an explicit bin', () => {
    expect(resolveCli({ bin: FAKE_NCODE, env: {} })).toEqual({
      kind: 'node',
      path: FAKE_NCODE,
      source: 'option',
    });
  });

  it('resolves bin.ncode of an installed @niwa-labs/ncode package and runs it with Node', async () => {
    // The workspace links a test double for the optional peer dependency.
    const sdkSource = new URL('../src/cli-resolver.ts', import.meta.url).href;
    expect(resolvePackageEntry([sdkSource])).toBe(FAKE_NCODE);

    const turn = await new Ncode({
      env: { PATH: '', FAKE_NCODE_FIXTURE: fixture('resumed') },
    })
      .startThread()
      .run('hi');
    expect(turn.finalResponse).toMatch(/^I wrote exactly/u);
  });

  it('falls back to ncode on PATH', async () => {
    const dir = installLauncher();
    const env = { PATH: dir, PATHEXT: '.CMD' };

    const cli = resolveCli({ env, packageSearchFrom: [], projectSearchFrom: tempDir() });
    expect(cli.source).toBe('path');
    // Windows .cmd shims resolve to their JS entry, avoiding cmd.exe.
    expect(cli.kind).toBe(isWindows ? 'node' : 'exec');
    expect(findOnPath('ncode', env)).toBeTruthy();

    const turn = await new Ncode({
      bin: 'ncode',
      env: { ...env, FAKE_NCODE_FIXTURE: fixture('resumed') },
    })
      .startThread()
      .run('hi');
    expect(turn.status).toBe('succeeded');
  });

  it('throws NcodeNotFoundError with an install hint when nothing is found', async () => {
    const empty = tempDir();
    expect(() =>
      resolveCli({ env: { PATH: empty }, packageSearchFrom: [], projectSearchFrom: empty }),
    ).toThrow(NcodeNotFoundError);
    const error = await new Ncode({ bin: join(empty, 'missing-ncode'), env: { PATH: empty } })
      .startThread()
      .run('x')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NcodeNotFoundError);
    expect((error as Error).message).toContain('npm install @niwa-labs/ncode@latest');
  });

  it('extracts the JS entry from npm and pnpm cmd shims', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'node_modules', '@niwa-labs', 'ncode', 'dist'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', '@niwa-labs', 'ncode', 'dist', 'index.js'), '');
    const shim = join(dir, 'ncode.cmd');
    const npm = `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@niwa-labs\\ncode\\dist\\index.js" %*`;
    const pnpm = `"%~dp0\\node_modules\\@niwa-labs\\ncode\\dist\\index.js" %*`;
    const entry = join(dir, 'node_modules', '@niwa-labs', 'ncode', 'dist', 'index.js');

    expect(parseCmdShim(npm, shim)).toBe(entry);
    expect(parseCmdShim(pnpm, shim)).toBe(entry);
    expect(parseCmdShim('@echo off\r\nnative.exe %*', shim)).toBeUndefined();
  });

  it('never starts a batch file through a shell', () => {
    const dir = tempDir();
    const shim = join(dir, 'ncode.cmd');
    writeFileSync(shim, '@echo off\r\nnative-launcher.exe %*\r\n');

    // Without a resolvable JS entry the SDK asks for one instead of falling back to cmd.exe.
    expect(() => resolveCli({ bin: shim, env: {}, platform: 'win32' })).toThrow(
      /Found .*ncode\.cmd, but could not determine the JS entry it runs/u,
    );
    expect(
      buildSpawnCommand({ kind: 'exec', path: 'C:\\bin\\ncode.exe', source: 'path' }, ['exec']),
    ).toEqual({
      command: 'C:\\bin\\ncode.exe',
      args: ['exec'],
    });
  });
});

describe('CLI version check', () => {
  it('compares major.minor.patch and accepts preview builds of the minimum', () => {
    const satisfies = (text: string): boolean => {
      const version = parseVersion(text);
      const minimum = parseVersion(MIN_CLI_VERSION);
      if (!version || !minimum) throw new Error(`unparseable version ${text}`);
      return satisfiesMinimum(version, minimum);
    };
    expect(MIN_CLI_VERSION).toBe('0.1.2');
    expect(satisfies('0.1.2-preview.1')).toBe(true);
    expect(satisfies('0.1.2')).toBe(true);
    expect(satisfies('0.1.3')).toBe(true);
    expect(satisfies('0.2.0-preview.1015121')).toBe(true);
    expect(satisfies('Ncode 0.2.1')).toBe(true);
    expect(satisfies('1.0.0')).toBe(true);
    expect(satisfies('0.1.1')).toBe(false);
  });

  it('checks the Ncode version in the banner instead of the bundled component versions', async () => {
    const cli = resolveCli({ bin: FAKE_NCODE, env: {} });
    const components = 'MCode 0.7.2\nPi 1.6.0';
    await expect(
      checkCliVersion(cli, { FAKE_NCODE_VERSION: `Ncode ${MIN_CLI_VERSION}\n${components}` }),
    ).resolves.toBe(MIN_CLI_VERSION);
    await expect(
      checkCliVersion(cli, { FAKE_NCODE_VERSION: `Ncode 0.1.1\n${components}` }),
    ).rejects.toMatchObject({ version: '0.1.1' });
    await expect(checkCliVersion(cli, { FAKE_NCODE_VERSION: components })).rejects.toBeInstanceOf(
      NcodeVersionError,
    );
  });

  it('rejects an older CLI before running', async () => {
    const error = await fakeClient({ FAKE_NCODE_VERSION: 'Ncode 0.1.1' })
      .startThread()
      .run('x')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NcodeVersionError);
    expect((error as NcodeVersionError).version).toBe('0.1.1');
    expect((error as Error).message).toContain('npm install @niwa-labs/ncode@latest');
  });

  it('checks the version once per client', async () => {
    const log = join(tempDir(), 'versions.log');
    const ncode = fakeClient({
      FAKE_NCODE_FIXTURE: fixture('resumed'),
      FAKE_NCODE_VERSION_LOG: log,
    });
    await ncode.startThread().run('a');
    await ncode.startThread().run('b');
    expect(readFileSync(log, 'utf8')).toBe('version\n');
  });
});

describe('package metadata', () => {
  it('keeps engines.node identical to the ncode CLI package', () => {
    const read = (path: string): { engines: { node: string } } =>
      JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')) as {
        engines: { node: string };
      };
    expect(read('../package.json').engines.node).toBe(read('../../tui/package.json').engines.node);
    const sdk = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as {
      peerDependencies: { '@niwa-labs/ncode': string };
    };
    expect(sdk.peerDependencies['@niwa-labs/ncode']).toBe(`>=${MIN_CLI_VERSION}`);
  });
});
