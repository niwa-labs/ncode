import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { MavisBuildEnv, MavisRegion } from '@mavis/config';
import {
  activateMcodeToolsHostEnvironment,
  classifyMcodeToolsReadinessFailure,
  ensureMcodeToolsPrivateDirectory,
  resolveBundledMcodeToolsCommandBinDir,
  resolveBundledMcodeToolsResourceDir,
  startMcodeToolsAuthLeaseBroker,
  validateMcodeToolsResource,
  type McodeToolsAuthLeaseBroker,
  type McodeToolsBuildEnv,
  type McodeToolsHostAuthSession,
  type McodeToolsHostEnvironmentActivation,
  type McodeToolsHostLogger,
  type McodeToolsReadinessCategory,
  type ValidatedMcodeToolsResource,
} from '@mavis/mcode-tools-host';

export type { McodeToolsReadinessCategory } from '@mavis/mcode-tools-host';

export interface McodeToolsReadiness {
  readonly requested: boolean;
  readonly ready: boolean;
  readonly category: McodeToolsReadinessCategory;
  readonly buildEnv: McodeToolsBuildEnv;
  readonly version?: string;
  ensureCommandPath(): void;
  dispose(): Promise<void>;
}

export interface PrepareTuiMcodeToolsIntegrationOptions {
  requested: boolean;
  dataDir: string;
  buildEnv: MavisBuildEnv;
  region: MavisRegion;
  session: McodeToolsHostAuthSession;
  entryUrl: string;
  bedrockLane?: string;
  environment?: Record<string, string | undefined>;
  logger?: McodeToolsHostLogger;
}

export interface PrepareTuiMcodeToolsIntegrationDependencies {
  validateResource?: typeof validateMcodeToolsResource;
  startBroker?: typeof startMcodeToolsAuthLeaseBroker;
  createRuntimeDir?: typeof createTuiMcodeToolsRuntimeDir;
  removeRuntimeDir?: typeof removeTuiMcodeToolsRuntimeDir;
  activateEnvironment?: typeof activateMcodeToolsHostEnvironment;
}

const NOOP_DISPOSE = async (): Promise<void> => undefined;
const NOOP = (): void => undefined;

export async function prepareTuiMcodeToolsIntegration(
  options: PrepareTuiMcodeToolsIntegrationOptions,
  dependencies: PrepareTuiMcodeToolsIntegrationDependencies = {},
): Promise<McodeToolsReadiness> {
  const buildEnv = normalizeMcodeToolsHostBuildEnv(options.buildEnv);
  if (!options.requested) return inactiveReadiness(false, 'disabled', buildEnv);

  const logger = options.logger ?? { info: () => undefined, warn: () => undefined };
  const environment = options.environment ?? process.env;
  const removeRuntimeDir = dependencies.removeRuntimeDir ?? removeTuiMcodeToolsRuntimeDir;
  let runtimeDir: string | undefined;
  let broker: McodeToolsAuthLeaseBroker | undefined;
  let activation: McodeToolsHostEnvironmentActivation | undefined;
  try {
    const resource = (dependencies.validateResource ?? validateMcodeToolsResource)({
      resourceDir: resolveBundledMcodeToolsResourceDir(options.entryUrl, environment),
      expectedBuildEnv: buildEnv,
    });
    runtimeDir = await (dependencies.createRuntimeDir ?? createTuiMcodeToolsRuntimeDir)();
    broker = await (dependencies.startBroker ?? startMcodeToolsAuthLeaseBroker)({
      dataDir: runtimeDir,
      session: options.session,
      logger,
    });
    const configDir = path.join(options.dataDir, 'integrations', 'mcode-tools', options.region);
    await ensureMcodeToolsPrivateDirectory(configDir);
    activation = (dependencies.activateEnvironment ?? activateMcodeToolsHostEnvironment)(
      environment,
      {
        runtimeExecutable: process.execPath,
        brokerEndpoint: broker.endpoint,
        brokerCapabilityFile: broker.capabilityFile,
        configDir,
        region: options.region,
        commandBinDir: resolveBundledMcodeToolsCommandBinDir(options.entryUrl),
        ...(options.bedrockLane ? { bedrockLane: options.bedrockLane } : {}),
      },
    );
    const readiness = activeReadiness({
      buildEnv,
      resource,
      broker,
      runtimeDir,
      removeRuntimeDir,
      activation,
    });
    logger.info(
      `mcode-tools readiness category=${readiness.category} buildEnv=${buildEnv} region=${options.region} version=${resource.manifest.version}`,
    );
    return readiness;
  } catch (error) {
    activation?.restore();
    await broker?.dispose().catch(() => undefined);
    if (runtimeDir) await removeRuntimeDir(runtimeDir).catch(() => undefined);
    const category = classifyMcodeToolsReadinessFailure(error);
    logger.warn(
      `mcode-tools readiness category=${category} buildEnv=${buildEnv} region=${options.region}`,
    );
    return inactiveReadiness(true, category, buildEnv);
  }
}

export { resolveBundledMcodeToolsResourceDir, resolveBundledMcodeToolsCommandBinDir };

export function normalizeMcodeToolsHostBuildEnv(buildEnv: MavisBuildEnv): McodeToolsBuildEnv {
  return buildEnv === 'dev' ? 'test' : buildEnv;
}

export async function createTuiMcodeToolsRuntimeDir(): Promise<string> {
  // macOS Unix-domain sockets have a short path limit. `/tmp` keeps the
  // process-private broker endpoint bounded even when the user's dataDir is long.
  const parent = process.platform === 'win32' ? tmpdir() : '/tmp';
  const runtimeDir = await mkdtemp(path.join(parent, `mcode-tools-tui-${process.pid}-`));
  if (process.platform !== 'win32') await chmod(runtimeDir, 0o700);
  return runtimeDir;
}

export function removeTuiMcodeToolsRuntimeDir(runtimeDir: string): Promise<void> {
  return rm(runtimeDir, { recursive: true, force: true });
}

function activeReadiness(options: {
  buildEnv: McodeToolsBuildEnv;
  resource: ValidatedMcodeToolsResource;
  broker: McodeToolsAuthLeaseBroker;
  runtimeDir: string;
  removeRuntimeDir: (runtimeDir: string) => Promise<void>;
  activation: McodeToolsHostEnvironmentActivation;
}): McodeToolsReadiness {
  let disposed = false;
  return {
    requested: true,
    ready: true,
    category: 'ready',
    buildEnv: options.buildEnv,
    version: options.resource.manifest.version,
    ensureCommandPath: options.activation.ensureCommandPath,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      options.activation.restore();
      const errors: unknown[] = [];
      try {
        await options.broker.dispose();
      } catch (error) {
        errors.push(error);
      }
      try {
        await options.removeRuntimeDir(options.runtimeDir);
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'mcode-tools TUI cleanup failed');
    },
  };
}

function inactiveReadiness(
  requested: boolean,
  category: Exclude<McodeToolsReadinessCategory, 'ready'>,
  buildEnv: McodeToolsBuildEnv,
): McodeToolsReadiness {
  return {
    requested,
    ready: false,
    category,
    buildEnv,
    ensureCommandPath: NOOP,
    dispose: NOOP_DISPOSE,
  };
}
