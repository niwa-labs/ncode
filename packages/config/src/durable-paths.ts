/**
 * The durable data root and its on-disk layout.
 *
 * The durable runtime owns a data root separate from the legacy mcode data
 * directory: the default profile uses `~/.mcode-durable`, and `--profile work`
 * uses `~/.mcode-durable-work`, following the same profile rule as
 * `auth-profile.ts`. Everything the runtime persists lives under that root —
 * the canonical session databases (`sessions.g<N>.db`, one file per format
 * generation), the content-addressed blob store (`cas/`), the service tables
 * (`runtime.db`), and the daemon socket (`mcoded.sock`).
 *
 * The legacy `~/.minimax` tree is a read-only source during migration: nothing
 * in the durable runtime may open a path inside it for writing. The rule is
 * stated once here ({@link assertNoLegacyWrite}) so filesystem gates can share
 * a single definition of "legacy" instead of restating it per call site.
 *
 * @module
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeProfileSelector } from './auth-profile.js';
import { getPrimaryDataDirPath, NEW_DATA_DIR_BASENAME } from './data-dir.js';

/** Directory name of the durable root under the home directory. */
export const DURABLE_ROOT_BASENAME = '.mcode-durable';

/** Content-addressed blob store directory inside the durable root. */
export const DURABLE_CAS_DIR_BASENAME = 'cas';

/** Service-table SQLite database inside the durable root (agents, cron, queues, memory). */
export const DURABLE_RUNTIME_DB_BASENAME = 'runtime.db';

/** Unix socket the mcoded daemon listens on, inside the durable root. */
export const DURABLE_SOCKET_BASENAME = 'mcoded.sock';

/** Base name of the canonical session database; the generation is inserted before `.db`. */
export const DURABLE_SESSIONS_DB_BASENAME = 'sessions';

/** Generation of the session database the runtime starts from. */
export const DEFAULT_SESSIONS_GENERATION = 1;

/**
 * Absolute path of the legacy data root the durable runtime must never write.
 *
 * `~/.minimax` is `NEW_DATA_DIR_BASENAME` in `data-dir.ts` — "new" only
 * relative to the pre-MiniMax `.mavis` layout; the durable runtime supersedes
 * both and treats this root as read-only.
 *
 * The path is captured when this module is first imported. A process that
 * overrides `HOME`/`os.homedir()` afterwards (a test harness, for example)
 * must pass the matching root explicitly rather than rely on this default.
 */
export const LEGACY_ROOT = path.join(os.homedir(), NEW_DATA_DIR_BASENAME);

/** Thrown when an operation attempts to write inside the legacy data root. */
export class LegacyWriteError extends Error {
  readonly code = 'LEGACY_WRITE_FORBIDDEN';
  readonly targetPath: string;
  readonly legacyRoot: string;

  constructor(targetPath: string, legacyRoot: string) {
    super(
      `Refusing to write "${targetPath}": the path falls inside the legacy data root ` +
        `"${legacyRoot}", which the durable runtime only reads.`,
    );
    this.name = 'LegacyWriteError';
    this.targetPath = targetPath;
    this.legacyRoot = legacyRoot;
  }
}

/**
 * Resolve the durable data root a profile points at, without touching the disk.
 *
 * Profile selection follows {@link normalizeProfileSelector}: an absent, blank,
 * or `default` selector resolves the unsuffixed root, and any other value must
 * pass the profile-name allowlist so the generated directory segment cannot
 * escape the home directory.
 *
 * @throws {InvalidProfileNameError} when a non-blank profile is not a valid name.
 */
export function resolveDurableRoot(
  profile?: string | null,
  homeDir: string = os.homedir(),
): string {
  const selected = normalizeProfileSelector(profile);
  const home = path.resolve(homeDir);
  return path.join(home, selected ? `${DURABLE_ROOT_BASENAME}-${selected}` : DURABLE_ROOT_BASENAME);
}

/**
 * Resolve the canonical session database of one format generation.
 *
 * Generation `N` lives in `sessions.g<N>.db` next to the previous generation,
 * which must stay byte-identical while a verified migration fills the new one.
 *
 * @throws {RangeError} when the generation is not an integer >= 1.
 */
export function resolveSessionsDbPath(
  root: string,
  generation: number = DEFAULT_SESSIONS_GENERATION,
): string {
  if (!Number.isInteger(generation) || generation < 1) {
    throw new RangeError(`Invalid session database generation ${generation}. Use an integer >= 1.`);
  }
  return path.join(root, `${DURABLE_SESSIONS_DB_BASENAME}.g${generation}.db`);
}

/** Resolve the content-addressed blob store directory under a durable root. */
export function resolveCasDirPath(root: string): string {
  return path.join(root, DURABLE_CAS_DIR_BASENAME);
}

/** Resolve the service-table database under a durable root. */
export function resolveRuntimeDbPath(root: string): string {
  return path.join(root, DURABLE_RUNTIME_DB_BASENAME);
}

/** Resolve the daemon socket under a durable root. */
export function resolveMcodedSocketPath(root: string): string {
  const candidate = path.join(root, DURABLE_SOCKET_BASENAME);
  if (Buffer.byteLength(candidate) <= MCODED_SOCKET_PATH_MAX_BYTES) return candidate;
  return resolveFallbackMcodedSocketPath(root);
}

/**
 * Longest socket path the daemon may bind inside the control root.
 *
 * `sun_path` is 104 bytes on macOS and 108 on Linux; a long profile name
 * pushes `<root>/mcoded.sock` past the limit. The fallback keeps the daemon
 * bindable instead of failing at startup.
 */
export const MCODED_SOCKET_PATH_MAX_BYTES = 100;

/**
 * Resolve the out-of-root socket path used when the control-root socket path
 * does not fit into `sun_path`.
 *
 * The fallback directory lives under the temp dir, is named after the uid, and
 * carries the hash of the control root — two profiles of the same user never
 * collide, and a different user cannot guess the name.
 */
export function resolveFallbackMcodedSocketPath(root: string): string {
  const digest = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 12);
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return path.join(os.tmpdir(), `mcoded-${uid}`, `${digest}.sock`);
}

/**
 * Resolve the directory the daemon's fallback socket lives in.
 *
 * Callers create it with `0700` and verify the owner before binding — the
 * fallback must not weaken the control-root trust boundary.
 */
export function resolveFallbackMcodedSocketDir(root: string): string {
  return path.dirname(resolveFallbackMcodedSocketPath(root));
}

/**
 * The three server modes of the `MCODE_SERVER_MODE` switch.
 *
 * - `off` — the in-process runtime; the daemon refuses to start.
 * - `auto` — the daemon may be started on demand.
 * - `required` — the daemon must run; the in-process path refuses.
 */
export type ServerMode = 'off' | 'auto' | 'required';

/** Environment variable that selects the server mode. */
export const MCODE_SERVER_MODE_ENV = 'MCODE_SERVER_MODE';

/** Thrown when `MCODE_SERVER_MODE` holds a value the daemon does not know. */
export class ServerModeConfigError extends Error {
  readonly code = 'SERVER_MODE_INVALID';
  readonly value: string;

  constructor(value: string) {
    super(
      `Invalid ${MCODE_SERVER_MODE_ENV} value ${JSON.stringify(value)}. ` +
        'Expected one of: off, auto, required.',
    );
    this.name = 'ServerModeConfigError';
    this.value = value;
  }
}

/**
 * Resolve the server mode from the environment.
 *
 * The default is `auto`: every entry (TUI/exec/ACP) runs as a thin client of
 * the mcoded daemon, auto-spawning it on demand — the single-writer durable
 * store has exactly one writer and multi-window simply works.
 * An unknown value fails closed —
 * the caller must not silently fall back to a mode the user did not ask for.
 *
 * @throws {ServerModeConfigError} when the variable holds an unknown value.
 */
export function resolveServerMode(env: NodeJS.ProcessEnv = process.env): ServerMode {
  const raw = env[MCODE_SERVER_MODE_ENV];
  if (raw === undefined || raw.trim() === '') return 'auto';
  const value = raw.trim().toLowerCase();
  if (value === 'off' || value === 'auto' || value === 'required') return value;
  throw new ServerModeConfigError(raw);
}

/** Thrown when a daemon entry point is asked to start while the mode is `off`. */
export class ServerModeOffError extends Error {
  readonly code = 'SERVER_MODE_OFF';

  constructor() {
    super(
      `Refusing to start the daemon: ${MCODE_SERVER_MODE_ENV} is 'off'. ` +
        `Set ${MCODE_SERVER_MODE_ENV}=auto or =required, or use the in-process runtime.`,
    );
    this.name = 'ServerModeOffError';
  }
}

/**
 * The start gate of every daemon entry point (`mcode daemon run`, the
 * standalone `mcoded` entry): resolve the mode and refuse `off`.
 *
 * `off` means the in-process runtime is the whole product; a resident daemon
 * behind it would surprise the operator (arch §4.8). `auto` and `required`
 * pass through unchanged.
 *
 * @throws {ServerModeOffError} when the resolved mode is `off`.
 * @throws {ServerModeConfigError} when the variable holds an unknown value.
 */
export function assertDaemonStartAllowed(env: NodeJS.ProcessEnv = process.env): ServerMode {
  const mode = resolveServerMode(env);
  if (mode === 'off') throw new ServerModeOffError();
  return mode;
}

/** Basename of the per-data-dir control root inside the default durable root. */
export const DAEMON_CONTROL_ROOT_DIR_PREFIX = 'dd-';

/** Options of {@link resolveDaemonControlRoot}. */
export interface DaemonControlRootOptions {
  /** Selected profile; `null`/absent means the default profile. */
  readonly profile?: string | null;
  /**
   * Data directory the daemon serves. When it differs from the profile's
   * default data directory, the control root moves into a per-data-dir
   * subdirectory of the default durable root.
   */
  readonly dataDir?: string | null;
  /** Home directory used to resolve the durable root (tests override this). */
  readonly homeDir?: string;
}

/**
 * Which profile a data directory belongs to, inferred from its path (opus
 * decision 2026-11-01: the daemon's identity IS `realpath(dataDir)`; the
 * profile is a derived label, never an independent input).
 *
 * - `profile` — the directory is the primary data directory `~/.minimax-<name>`
 *   of a valid profile name.
 * - `default` — the directory is the unsuffixed `~/.minimax`.
 * - `foreign` — everything else: a genuinely foreign directory the `dd-<hash>`
 *   control-root branch exists for.
 */
export type DataDirProfileInference =
  | { readonly kind: 'profile'; readonly profile: string }
  | { readonly kind: 'default' }
  | { readonly kind: 'foreign' };

/**
 * Infer the profile a data directory belongs to.
 *
 * Both sides of the comparison are realpath'd ({@link resolveRealPath}), so a
 * symlinked spelling of a profile directory resolves to that profile and a
 * not-yet-created profile directory still infers its name through the same
 * fallback rule the daemon pins the data plane with. Candidate names come from
 * the dataDir's own basename AND the `.minimax-*` entries of the home
 * directory — the first covers the not-yet-created directory, the second a
 * symlinked spelling whose realpath basename is the REAL directory's name. A
 * name outside the profile allowlist (`normalizeProfileSelector`) is never a
 * match; a path that is no candidate's primary data directory reports
 * `foreign` rather than guessing.
 */
export function profileOfDataDir(homeDir: string, dataDir: string): DataDirProfileInference {
  const home = path.resolve(homeDir);
  const resolvedDataDir = resolveRealPath(dataDir);
  if (resolvedDataDir === resolveRealPath(getPrimaryDataDirPath(home, null))) {
    return { kind: 'default' };
  }

  const prefix = `${NEW_DATA_DIR_BASENAME}-`;
  const candidates = new Set<string>();
  const base = path.basename(resolvedDataDir);
  if (base.startsWith(prefix)) candidates.add(base.slice(prefix.length));
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(home, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (entry.name.startsWith(prefix)) candidates.add(entry.name.slice(prefix.length));
  }

  for (const candidate of candidates) {
    let profile: string | null;
    try {
      profile = normalizeProfileSelector(candidate);
    } catch {
      continue; // not a usable profile name — not a profile directory
    }
    if (profile === null) continue;
    // The name alone is not enough: the FULL path must be this home's
    // primary data directory of that profile (another home's ~/.minimax-work
    // is not a profile directory of this home). The realpath comparison is
    // the symlink-proof identity check.
    if (resolvedDataDir === resolveRealPath(getPrimaryDataDirPath(home, profile))) {
      return { kind: 'profile', profile };
    }
  }
  return { kind: 'foreign' };
}

/**
 * Resolve the control root of the daemon: the directory that holds the socket,
 * the writer lock, the daemon manifest, the event log and the handshake token.
 *
 * The control plane is separate from the data plane. The data plane is the
 * profile's data directory; the control plane is `~/.mcode-durable[-profile]`.
 * A data-directory override moves the control root to
 * `~/.mcode-durable/dd-<hash>/` so two windows with different data directories
 * never share one daemon.
 *
 * When no profile was selected, the dataDir itself decides (opus 2026-11-01):
 * a directory that IS some profile's primary data directory keeps that
 * profile's plain durable root, so a profile-less request for a profile
 * directory can no longer land in a `dd-<hash>` root; the `dd-<hash>` branch
 * is reserved for genuinely foreign data directories.
 */
export function resolveDaemonControlRoot(options: DaemonControlRootOptions = {}): string {
  const homeDir = options.homeDir ?? os.homedir();
  const profile = options.profile ?? null;
  const defaultDurableRoot = resolveDurableRoot(profile, homeDir);
  const dataDir = options.dataDir?.trim();
  if (!dataDir) return defaultDurableRoot;

  const resolvedDataDir = resolveRealPath(dataDir);
  const profileDataDir = resolveRealPath(getPrimaryDataDirPath(homeDir, profile));
  if (resolvedDataDir === profileDataDir) return defaultDurableRoot;

  if (profile === null) {
    const inference = profileOfDataDir(homeDir, resolvedDataDir);
    if (inference.kind === 'profile') return resolveDurableRoot(inference.profile, homeDir);
    if (inference.kind === 'default') return resolveDurableRoot(null, homeDir);
  }

  const digest = createHash('sha256').update(resolvedDataDir).digest('hex').slice(0, 16);
  return path.join(
    resolveDurableRoot(null, homeDir),
    `${DAEMON_CONTROL_ROOT_DIR_PREFIX}${digest}`,
  );
}

/**
 * Resolve the real path of a directory, falling back to the resolved path when
 * the directory does not exist yet.
 */
export function resolveRealPath(target: string): string {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** Thrown when the control root is writable by other users or has a foreign owner. */
export class ControlRootInsecureError extends Error {
  readonly code = 'CONTROL_ROOT_INSECURE';
  readonly controlRoot: string;

  constructor(controlRoot: string, reason: string) {
    super(`Refusing to use control root "${controlRoot}": ${reason}`);
    this.name = 'ControlRootInsecureError';
    this.controlRoot = controlRoot;
  }
}

/**
 * Verify that only the owning user may use the control root.
 *
 * The socket file's own permissions are the second layer; the directory is the
 * real barrier (macOS historically ignores socket file modes on `connect`).
 */
export function assertSecureControlRoot(root: string): string {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(root);
  } catch {
    throw new ControlRootInsecureError(root, 'the directory does not exist');
  }
  if (!stats.isDirectory()) {
    throw new ControlRootInsecureError(root, 'the path is not a directory');
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid !== undefined && stats.uid !== uid) {
    throw new ControlRootInsecureError(root, `it is owned by uid ${stats.uid}, not by ${uid}`);
  }
  if ((stats.mode & 0o022) !== 0) {
    throw new ControlRootInsecureError(
      root,
      `it is writable by group or other (mode ${(stats.mode & 0o777).toString(8)})`,
    );
  }
  return root;
}

/**
 * Create the control root and the fallback socket directory, then verify both.
 *
 * Both directories are created with `0700`. An existing directory that is
 * writable by group or other fails closed instead of being silently tightened
 * (chmod'ing behind the operator's back would hide a misconfiguration, and
 * `mkdir` with `recursive` would silently accept a foreign directory);
 * read-looser modes such as `0755` pass — the fail-closed rule is the
 * group/other WRITE bits plus the owner check (arch §4.6.1). The fallback
 * socket directory gets the same verification: it sits under the shared temp
 * dir, so a pre-existing directory we did not create must not weaken the
 * control-root trust boundary (arch §4.6.1: "каталог 0700, владелец
 * проверяется").
 */
export function ensureControlRootLayout(root: string): string {
  assertNoLegacyWrite(root);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const fallbackDir = resolveFallbackMcodedSocketDir(root);
  if (fallbackDir !== root) {
    fs.mkdirSync(fallbackDir, { recursive: true, mode: 0o700 });
    assertSecureControlRoot(fallbackDir);
  }
  assertSecureControlRoot(root);
  return root;
}

// Same normalization `data-dir.ts` uses to compare paths: resolve, and fold
// case only on Windows, where the file system is case-insensitive.
function normalizePathForCompare(targetPath: string): string {
  let normalized = path.resolve(targetPath);
  if (process.platform === 'win32') {
    normalized = normalized.replace(/^\\\\\?\\/, '');
    return normalized.toLowerCase();
  }
  return normalized;
}

/**
 * Report whether `target` falls inside the write-protected legacy family.
 *
 * The family is the legacy root itself plus its profile-suffixed siblings
 * (`~/.minimax`, `~/.minimax-work`), matched at the home-directory level the
 * same way the profile resolver names them. Paths elsewhere under the home
 * directory, and absolute paths outside it entirely, are not legacy.
 */
function isLegacyFamilyPath(target: string, legacyRoot: string): boolean {
  const resolvedRoot = normalizePathForCompare(legacyRoot);
  const legacyHome = path.dirname(resolvedRoot);

  const relative = path.relative(legacyHome, normalizePathForCompare(target));
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return false;
  }
  const [first] = relative.split(path.sep);
  const legacyBasename = path.basename(resolvedRoot);
  return first !== undefined && (first === legacyBasename || first.startsWith(`${legacyBasename}-`));
}

/**
 * Assert that a path may be written under the durable architecture.
 *
 * The legacy tree is read-only: the durable runtime streams data out of it but
 * never opens anything inside it for writing. Call this before any filesystem
 * mutation whose target is derived from configuration or a profile;
 * {@link ensureDurableLayout} applies the same guard to its own writes.
 *
 * Filesystem gates that cannot trust the process environment (see
 * {@link LEGACY_ROOT}) should pass `legacyRoot` explicitly instead of relying
 * on the default.
 *
 * @returns The validated path, unchanged.
 * @throws {LegacyWriteError} when `target` is inside the legacy family.
 */
export function assertNoLegacyWrite(target: string, legacyRoot: string = LEGACY_ROOT): string {
  if (isLegacyFamilyPath(target, legacyRoot)) throw new LegacyWriteError(target, legacyRoot);
  return target;
}

/**
 * Create the durable directory layout under `root`.
 *
 * Only directories are created: the SQLite databases and the daemon socket are
 * opened by their owners on demand. Existing directories are left untouched,
 * so the call is idempotent and safe at every startup.
 *
 * @throws {LegacyWriteError} when `root` is inside the legacy family.
 */
export function ensureDurableLayout(root: string): void {
  assertNoLegacyWrite(root);
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(resolveCasDirPath(root), { recursive: true });
}
