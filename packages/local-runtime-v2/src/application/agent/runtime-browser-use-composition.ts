import {
  initializeBrowserUseService,
  type BrowserUseService,
} from '../../service/browser-use/index.js';
import { parseRequestMediaConfig, type RequestMediaSettings } from '@mavis/config';

type BrowserUseServiceOptions = Parameters<typeof initializeBrowserUseService>[0];

interface RuntimeBrowserUseBetaConfig {
  readonly filePanelBrowser?: boolean;
  readonly browserUseTooling?: boolean;
}

export interface RuntimeBrowserUseOptions {
  readonly browserUse?: Pick<BrowserUseServiceOptions, 'adapter' | 'toolExposure'>;
  readonly runtimeOwnerKind?: string;
  readonly compatibility: {
    readonly agentHost: {
      readonly preparation: {
        readonly configBuilder: {
          config(): {
            readonly beta?: RuntimeBrowserUseBetaConfig;
            /** М1: parsed `requestMedia` block; the screenshot encoder reads its image limits. */
            readonly requestMedia?: RequestMediaSettings;
          };
        };
      };
    };
    readonly generatedAssets: {
      readonly registerGeneratedAsset: BrowserUseServiceOptions['registerGeneratedAsset'];
    };
    readonly questionnaires: {
      bindRequestAdmission(admission: BrowserUseService['admitQuestionnaireRequest']): void;
    };
  };
}

export interface RuntimeBrowserUseComposition {
  readonly service: BrowserUseService;
  close(): void;
}

export function ownsElectronRuntimeCapabilities(runtimeOwnerKind: string | undefined): boolean {
  return runtimeOwnerKind === undefined || runtimeOwnerKind === 'electron';
}

export function createRuntimeBrowserUseComposition(
  options: RuntimeBrowserUseOptions,
): RuntimeBrowserUseComposition {
  const service = initializeBrowserUseService({
    ...(options.browserUse?.adapter ? { adapter: options.browserUse.adapter } : {}),
    ...(options.browserUse?.toolExposure ? { toolExposure: options.browserUse.toolExposure } : {}),
    readConfig: () => {
      const beta = options.compatibility.agentHost.preparation.configBuilder.config().beta;
      return {
        ...(beta?.filePanelBrowser === undefined
          ? {}
          : { filePanelBrowserEnabled: beta.filePanelBrowser }),
        // OUR b3ae3514 decision (owner bug 2026-11-07), reverted by the sync
        // wholesale: Browser tooling is available UNLESS explicitly disabled —
        // an absent `beta.browserUseTooling` is not an opt-out. The e2e
        // "daemon-shape catalog carries the browser tool" pin depends on it.
        browserUseToolingEnabled: beta?.browserUseTooling !== false,
      };
    },
    // М1: the user's `requestMedia` block (parsed into the conversation
    // config) drives the screenshot encoding; unset keys fall back to the
    // strictest known provider limits inside parseRequestMediaConfig.
    getImageEncoding: () => {
      const { image } = parseRequestMediaConfig(
        options.compatibility.agentHost.preparation.configBuilder.config().requestMedia,
      );
      return {
        maxWidth: image.max_width,
        maxHeight: image.max_height,
        maxBase64Bytes: image.max_base64_bytes,
      };
    },
    registerGeneratedAsset: options.compatibility.generatedAssets.registerGeneratedAsset,
    activationMode: ownsElectronRuntimeCapabilities(options.runtimeOwnerKind)
      ? 'desktop-plugin'
      : 'explicit-config',
  });
  options.compatibility.questionnaires.bindRequestAdmission((input) =>
    service.admitQuestionnaireRequest(input),
  );
  return {
    service,
    close(): void {
      service.close();
    },
  };
}
