import { readFileSync } from 'node:fs';
import path from 'node:path';

export function versionFromTag(tag) {
  // Accept canonical SemVer release/prerelease tags, with no build metadata.
  const number = '(?:0|[1-9][0-9]*)';
  const identifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
  if (typeof tag !== 'string' || tag.trim() !== tag || !new RegExp(`^v${number}\\.${number}\\.${number}(?:-${identifier}(?:\\.${identifier})*)?$`).test(tag)) {
    throw new Error('Release tag must be vX.Y.Z or vX.Y.Z-prerelease (canonical SemVer).');
  }
  return tag.slice(1);
}

export function isUpstreamCliSource(manifest) {
  return manifest.name === 'minimax-code';
}

export function assertUpstreamCliPublication(root) {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (!isUpstreamCliSource(manifest)) {
    throw new Error('CLI publication is reserved for upstream MiniMax Code.');
  }
}

export function cliBuildVersion(root, tag = process.env.MCODE_RELEASE_TAG) {
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const tuiVersion = JSON.parse(readFileSync(path.join(root, 'packages/tui/package.json'), 'utf8')).version;
  if (version !== tuiVersion) throw new Error('Root and TUI package versions must match.');
  if (tag != null && versionFromTag(tag) !== version) throw new Error('Release tag must match root and TUI package versions. Run the release command before tagging.');
  return version;
}

// These modules stay outside the JS bundle and must travel with an installation.
export const cliExternalModules = [
  'better-sqlite3',
  '@mariozechner/clipboard',
  '@vscode/ripgrep',
  '@larksuiteoapi/node-sdk',
  // W10 (U30 build/release paths, patch registry PR-11 row №23): the image
  // pipeline dynamically imports this CJS module; bundled into a split chunk
  // it loses Node's CJS named-exports interop (`PhotonImage` resolves
  // undefined → resizeImage returns null → the preview worker posts no
  // image). External keeps the real dynamic import (Node interop + the
  // module's own __dirname wasm resolution) and the release manifest ships it.
  '@silvia-odwyer/photon-node',
];

export const cliReleaseTargets = ['ubuntu-latest', 'macos-latest'].flatMap(os =>
  ['22.19.0', '24.2.0', '25', '26'].map(node => ({ os, node })));
