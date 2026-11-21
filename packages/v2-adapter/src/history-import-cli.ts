/**
 * Entry of the history-import CLI (integration plan R6): a thin shell over
 * `history-import/import-service.js`, bundled to `dist/history-import.js` by
 * `scripts/build.mjs` and launched through `scripts/history-import.mjs`.
 *
 * Subcommands:
 *   plan   --source <dir> [--report <path>]            list legacy v2 sessions
 *   run    --source <sessionDir> --root <durableRoot>  import one session
 *          [--chunk-bytes N] [--progress-jsonl <path>] [--receipt <path>]
 *          [--batch-records N] [--keep-images-inline] [--json]
 *   resume --source <sessionDir> --root <durableRoot>  continue from the durable cursor
 *          [--progress-jsonl <path>] [--receipt <path>] [--json]
 *   verify --source <sessionDir> --root <durableRoot>  counts, CAS 100%, revision
 *
 * `--root` is MANDATORY for run/resume/verify: the CLI never resolves a
 * default and never touches a live profile directory by implication. Progress
 * goes to stderr and, with `--progress-jsonl`, is appended as one JSON event
 * per line (append-only artifact, §10.3); results go to stdout (`--json` for
 * machine output). Exit codes: 0 success, 1 failure (including a failed
 * verify or an import conflict), 2 usage.
 *
 * Recorded deviation from test-architecture.md §10.3 (revision round
 * 2026-10-23): the plan-file flow (`--plan`), the DB sources
 * (`--source-db`/`--target-root`, §10.1 source selector) and the full
 * §10.3 `ImportProgress` schema are not part of this delivery — this shell
 * drives one session directory directly through the shared service.
 *
 * @module
 */

import { writeFileSync } from 'node:fs';

import {
  ImportConflictError,
  planHistoryImports,
  resumeHistoryImport,
  runHistoryImport,
  SourceDriftError,
  verifyHistoryImport,
  type ImportProgressEvent,
  type ImportVerificationReport,
} from './history-import/import-service.js';

interface ParsedArgs {
  source?: string;
  root?: string;
  receipt?: string;
  report?: string;
  batchRecords?: number;
  chunkBytes?: number;
  progressJsonl?: string;
  json: boolean;
  keepImagesInline: boolean;
}

function usage(program: string): string {
  return [
    `Usage:`,
    `  ${program} plan --source <dir> [--report <path>] [--json]`,
    `  ${program} run --source <sessionDir> --root <durableRoot> [--chunk-bytes N] [--batch-records N] [--progress-jsonl <path>] [--receipt <path>] [--keep-images-inline] [--json]`,
    `  ${program} resume --source <sessionDir> --root <durableRoot> [--chunk-bytes N] [--progress-jsonl <path>] [--receipt <path>] [--json]`,
    `  ${program} verify --source <sessionDir> --root <durableRoot> [--keep-images-inline] [--report <path>] [--json]`,
    ``,
    `--root is mandatory and must name the durable root explicitly; nothing is`,
    `imported into, or resolved from, a default location.`,
  ].join('\n');
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { json: false, keepImagesInline: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) break;
    const value = (): string | undefined => {
      const next = argv[index + 1];
      index += 1;
      return next;
    };
    switch (arg) {
      case '--source':
        parsed.source = value();
        break;
      case '--root':
        parsed.root = value();
        break;
      case '--receipt':
        parsed.receipt = value();
        break;
      case '--report':
        parsed.report = value();
        break;
      case '--batch-records': {
        const raw = value();
        const count = raw === undefined ? Number.NaN : Number(raw);
        if (!Number.isSafeInteger(count) || count < 1) {
          throw new UsageError(`--batch-records must be a positive integer, got ${String(raw)}`);
        }
        parsed.batchRecords = count;
        break;
      }
      case '--chunk-bytes': {
        const raw = value();
        const bytes = raw === undefined ? Number.NaN : Number(raw);
        if (!Number.isSafeInteger(bytes) || bytes < 1) {
          throw new UsageError(`--chunk-bytes must be a positive integer, got ${String(raw)}`);
        }
        parsed.chunkBytes = bytes;
        break;
      }
      case '--progress-jsonl':
        parsed.progressJsonl = value();
        break;
      case '--json':
        parsed.json = true;
        break;
      case '--keep-images-inline':
        parsed.keepImagesInline = true;
        break;
      default:
        throw new UsageError(`unknown option ${arg}`);
    }
  }
  return parsed;
}

class UsageError extends Error {}

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

function printError(line: string): void {
  process.stderr.write(`${line}\n`);
}

function printProgress(event: ImportProgressEvent): void {
  switch (event.kind) {
    case 'source':
      printError(
        `source ${event.phase}: bytes ${String(event.bytesRead)}` +
          (event.totalBytes === undefined ? '' : `/${String(event.totalBytes)}`) +
          `, records ${String(event.recordsRead)} delivered ${String(event.recordsDelivered)}` +
          `, images ${String(event.imagesStored)} stored, cursor ${String(event.sourceCursor)}, ${String(event.elapsedMs)} ms`,
      );
      break;
    case 'seed-begin':
      printError(`seed begin: import ${event.importId}`);
      break;
    case 'seed-chunk':
      printError(
        `seed chunk ${String(event.chunkNo)}: ${String(event.entries)} records, ${String(event.bytes)} bytes, cursor ${String(event.sourceCursor)}`,
      );
      break;
    case 'seed-commit':
      printError(
        `seed commit: ${String(event.chunks)} chunks, ${String(event.entries)} records, revision ${event.revision}`,
      );
      break;
  }
}

function printReceipt(result: {
  readonly status: string;
  readonly sessionId: string;
  readonly importId: string;
  readonly receipt: {
    readonly state: string;
    readonly durableRoot: string;
    readonly cursor: { readonly chunkNo: number; readonly records: number };
    readonly chunks: { readonly committed: number; readonly entries: number };
    readonly counts: { readonly records: number; readonly imagesStored: number; readonly imagesInline: number };
    readonly revision?: string;
  };
}, json: boolean): void {
  if (json) {
    print(JSON.stringify(result, null, 2));
    return;
  }
  print(`${result.status}: ${result.sessionId}`);
  print(`  import       ${result.importId}`);
  print(`  state        ${result.receipt.state}`);
  print(`  durable root ${result.receipt.durableRoot}`);
  print(`  chunks       ${String(result.receipt.chunks.committed)} committed, ${String(result.receipt.chunks.entries)} records`);
  print(`  cursor       chunk ${String(result.receipt.cursor.chunkNo)}, records ${String(result.receipt.cursor.records)}`);
  print(`  images       ${String(result.receipt.counts.imagesStored)} stored, ${String(result.receipt.counts.imagesInline)} inline`);
  if (result.receipt.revision !== undefined) print(`  revision     ${result.receipt.revision}`);
}

function printVerification(report: ImportVerificationReport, json: boolean): void {
  if (json) {
    print(JSON.stringify(report, null, 2));
    return;
  }
  print(`${report.ok ? 'PASS' : 'FAIL'} verify ${report.sessionId}`);
  print(`  durable root  ${report.durableRoot}`);
  print(`  source        ${String(report.source.records)} records, ${String(report.source.turns)} turns, ${String(report.source.bytes)} bytes, sha256 ${report.source.sha256}`);
  print(`  durable       ${String(report.durable.records)} records, ${String(report.durable.turns)} turns, ${String(report.durable.chunks)} chunks`);
  print(`  counts        records ${report.counts.recordsMatch ? 'match' : 'MISMATCH'}, turns ${report.counts.turnsMatch ? 'match' : 'MISMATCH'}, id order ${report.counts.idOrderMatch ? 'match' : 'MISMATCH'}`);
  print(`  revision      ${report.revisionMatch ? 'match' : 'MISMATCH'}${report.durable.revision === undefined ? '' : ` (${report.durable.revision})`}`);
  print(`  cas           ${String(report.cas.verified)}/${String(report.cas.references)} verified (digest+size)`);
  for (const issue of report.issues) print(`  issue: ${issue}`);
  for (const failure of report.cas.failed) print(`  cas failure ${failure.digest}: ${failure.reason}`);
}

async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0];
  if (command === undefined || command === '--help' || command === '-h') {
    print(usage('history-import'));
    return command === undefined ? 2 : 0;
  }
  let args: ParsedArgs;
  try {
    args = parseArgs(argv.slice(1));
  } catch (error) {
    if (error instanceof UsageError) {
      printError(`history-import: ${error.message}`);
      printError(usage('history-import'));
      return 2;
    }
    throw error;
  }

  switch (command) {
    case 'plan': {
      if (!args.source) {
        printError('history-import plan: --source <dir> is required');
        return 2;
      }
      const entries = await planHistoryImports(args.source);
      if (args.report) {
        writeFileSync(args.report, `${JSON.stringify(entries, null, 2)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        });
        printError(`import plan written to ${args.report}`);
      }
      if (args.json) {
        print(JSON.stringify(entries, null, 2));
        return 0;
      }
      if (entries.length === 0) {
        print(`no legacy v2 sessions under ${args.source}`);
        return 0;
      }
      print('SESSION  RECORDS  MALFORMED  BYTES  DIR');
      for (const entry of entries) {
        print(
          `${entry.sessionId}  ${String(entry.records)}  ${String(entry.malformedLines)}  ${String(entry.bytes)}  ${entry.dir}`,
        );
      }
      return 0;
    }
    case 'run':
    case 'resume': {
      if (!args.source || !args.root) {
        printError(`history-import ${command}: --source <sessionDir> and --root <durableRoot> are required (--root is mandatory, there is no default)`);
        return 2;
      }
      // §10.3: with --progress-jsonl every event is appended as one JSON line
      // (O_APPEND via flag 'a' — never truncates an existing artifact); the
      // stderr mirror stays so a human run keeps its live output.
      const onProgress = args.progressJsonl === undefined
        ? printProgress
        : (event: ImportProgressEvent): void => {
            writeFileSync(args.progressJsonl!, `${JSON.stringify(event)}\n`, {
              encoding: 'utf8',
              flag: 'a',
              mode: 0o600,
            });
            printProgress(event);
          };
      const options = {
        sourceDir: args.source,
        durableRoot: args.root,
        ...(args.receipt === undefined ? {} : { receipt: args.receipt }),
        keepImagesInline: args.keepImagesInline,
        ...(args.batchRecords === undefined ? {} : { batchRecords: args.batchRecords }),
        ...(args.chunkBytes === undefined ? {} : { chunkTargetBytes: args.chunkBytes }),
        onProgress,
      };
      const result =
        command === 'run' ? await runHistoryImport(options) : await resumeHistoryImport(options);
      printReceipt(result, args.json);
      return 0;
    }
    case 'verify': {
      if (!args.source || !args.root) {
        printError(`history-import verify: --source <sessionDir> and --root <durableRoot> are required (--root is mandatory, there is no default)`);
        return 2;
      }
      const report = await verifyHistoryImport({
        sourceDir: args.source,
        durableRoot: args.root,
        keepImagesInline: args.keepImagesInline,
      });
      if (args.report) {
        writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        printError(`verification report written to ${args.report}`);
      }
      printVerification(report, args.json);
      return report.ok ? 0 : 1;
    }
    default:
      printError(`history-import: unknown command ${command}`);
      printError(usage('history-import'));
      return 2;
  }
}

const exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof ImportConflictError) {
    printError(`history-import: import conflict: ${error.message}`);
    return 1;
  }
  if (error instanceof SourceDriftError) {
    printError(`history-import: source drift: ${error.message}`);
    return 1;
  }
  printError(
    `history-import: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  return 1;
});
process.exit(exitCode);
