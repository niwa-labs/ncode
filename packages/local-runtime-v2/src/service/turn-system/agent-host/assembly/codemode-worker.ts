/**
 * Standalone worker entry for the codemode sandbox (K1): pi-codemode's
 * CodemodeSandbox spawns `workerUrl` with workerData and drives the QuickJS VM
 * off-thread. Built as a self-contained chunk beside dist/cli.js so the
 * bundled daemon can spawn it (source runs resolve pi-codemode's own worker
 * file automatically). The quickjs wasm is copied beside this chunk by the
 * build (pi-codemode resolves it relative to its worker file).
 */
import '@earendil-works/pi-codemode/worker';
