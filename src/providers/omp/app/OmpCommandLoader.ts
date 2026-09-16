import type { ProviderCommandDiscoveryResult } from '@/core/providers/commands/ProviderCommandDiscoveryResult';
import { loadRuntimeCommands } from '@/core/providers/commands/RuntimeCommandLoader';
import type {
  ProviderCommandLoader as ProviderCommandLoaderContract,
  ProviderCommandLoaderContext,
} from '@/core/providers/types';
import type { SlashCommand } from '@/core/types';
import { getVaultPath } from '@/utils/path';

import type { OmpCommandMetadataProbe } from '../execution/OmpCommandMetadataProbe';
import { getOmpProviderSettings } from '../settings';

export class OmpCommandLoader implements ProviderCommandLoaderContract {
  constructor(private readonly metadataProbe: OmpCommandMetadataProbe) {}

  getCacheFingerprint(settings: Record<string, unknown>): string {
    return `omp:commands:v1:${getOmpProviderSettings(settings).enabled ? 'enabled' : 'disabled'}`;
  }

  isAvailable(settings: Record<string, unknown>): boolean {
    return getOmpProviderSettings(settings).enabled;
  }

  async loadCommands(
    context: ProviderCommandLoaderContext,
  ): Promise<ProviderCommandDiscoveryResult<SlashCommand>> {
    return loadRuntimeCommands({
      allowIsolatedMetadataCreation: context.allowIsolatedMetadataCreation,
      discover: signal => this.metadataProbe.load(
        getVaultPath(context.plugin.app) ?? process.cwd(),
        signal,
      ),
      errorMessage: 'Could not load OMP commands.',
      projectItems: commands => commands,
      readyCommandSnapshot: context.readyCommandSnapshot,
      requiresSessionMessage: 'OMP command metadata has not been loaded for this tab.',
      signal: context.signal,
    });
  }
}
