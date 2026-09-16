import type {
  ProviderExecutionBackend,
  ProviderExecutionSession,
  ProviderSessionConfig,
} from '../../../core/execution';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { OmpWorkspaceServices } from '../app/OmpWorkspaceServices';
import {
  createOmpForkSessionFile,
  rollbackCreatedOmpForkSessionFile,
} from '../history/OmpHistoryStore';
import type { OmpExtensionUiRenderer } from '../runtime/OmpExtensionUiBridge';
import {
  createOmpExecutionKernel,
  type OmpExecutionKernelFactory,
} from './OmpExecutionKernel';
import { OmpExecutionSession } from './OmpExecutionSession';

type OmpExecutionServices = Pick<OmpWorkspaceServices, 'commandCatalog'>;

export interface OmpExecutionBackendOptions {
  readonly createForkSessionFile?: typeof createOmpForkSessionFile;
  readonly createKernel?: OmpExecutionKernelFactory;
  readonly extensionUiRenderer?: OmpExtensionUiRenderer | null;
  readonly rollbackForkSessionFile?: typeof rollbackCreatedOmpForkSessionFile;
}

export class OmpExecutionBackend implements ProviderExecutionBackend {
  readonly providerId = 'omp' as const;

  constructor(
    private readonly host: ProviderHost,
    private readonly services: OmpExecutionServices,
    private readonly options: OmpExecutionBackendOptions = {},
  ) {}

  createSession(config: ProviderSessionConfig): ProviderExecutionSession {
    return new OmpExecutionSession(
      this.host,
      this.services,
      config,
      {
        createForkSessionFile: this.options.createForkSessionFile
          ?? createOmpForkSessionFile,
        createKernel: this.options.createKernel ?? createOmpExecutionKernel,
        extensionUiRenderer: this.options.extensionUiRenderer ?? null,
        rollbackForkSessionFile: this.options.rollbackForkSessionFile
          ?? rollbackCreatedOmpForkSessionFile,
      },
    );
  }
}
