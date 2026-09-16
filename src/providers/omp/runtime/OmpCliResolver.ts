import { CachedProviderCliResolver } from '@/core/providers/cli/CachedProviderCliResolver';
import { getRuntimeEnvironmentText } from '@/core/providers/providerEnvironment';
import { getOmpProviderSettings } from '@/providers/omp/settings';

export class OmpCliResolver {
  private readonly resolver = new CachedProviderCliResolver({
    binaryName: 'omp',
    getSettingsProjection: (settings) => {
      const providerSettings = getOmpProviderSettings(settings);
      return {
        cliPathsByHost: providerSettings.cliPathsByHost,
        environmentText: getRuntimeEnvironmentText(settings, 'omp'),
        legacyCliPath: providerSettings.cliPath,
      };
    },
    providerId: 'omp',
  });

  resolveFromSettings(settings: Record<string, unknown>): string | null {
    return this.resolver.resolveFromSettings(settings);
  }

  resolve(
    hostnamePaths: Record<string, string> | undefined,
    legacyPath: string,
    envText = '',
  ): string | null {
    return this.resolver.resolve({
      cliPathsByHost: hostnamePaths,
      environmentText: envText,
      legacyCliPath: legacyPath,
    });
  }

  reset(): void {
    this.resolver.reset();
  }
}
