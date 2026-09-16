import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import type {
  ProviderHost,
} from '../../../core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderTabWarmupPolicy,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { OmpCommandCatalog } from '../commands/OmpCommandCatalog';
import { OmpCommandMetadataProbe } from '../execution/OmpCommandMetadataProbe';
import { OmpCliResolver } from '../runtime/OmpCliResolver';
import { ompSettingsTabRenderer } from '../ui/OmpSettingsTab';
import { OmpCommandLoader } from './OmpCommandLoader';

export interface OmpWorkspaceServices extends ProviderWorkspaceServices {
  commandCatalog: ProviderCommandCatalog;
  dispose(): Promise<void>;
}

export interface OmpWorkspaceServicesOptions {
  readonly commandMetadataProbe?: OmpCommandMetadataProbe;
}

const ompTabWarmupPolicy: ProviderTabWarmupPolicy = {
  resolveMode() {
    return 'commands';
  },
};

export async function createOmpWorkspaceServices(
  plugin: ProviderHost,
  options: OmpWorkspaceServicesOptions = {},
): Promise<OmpWorkspaceServices> {
  const commandMetadataProbe = options.commandMetadataProbe
    ?? new OmpCommandMetadataProbe(plugin);
  const unregisterTransitionHook = plugin.executionLifecycleRegistry
    .registerTransitionHook('omp', {
      beforeTransition: () => {
        commandMetadataProbe.beginEnvironmentTransition();
        return commandMetadataProbe.quiesceForEnvironmentChange();
      },
      afterTransition: async () => {
        try {
          await commandMetadataProbe.quiesceForEnvironmentChange();
        } finally {
          commandMetadataProbe.endEnvironmentTransition();
        }
      },
    });

  return {
    cliResolver: new OmpCliResolver(),
    commandCatalog: new OmpCommandCatalog(),
    commandLoader: new OmpCommandLoader(commandMetadataProbe),
    settingsTabRenderer: ompSettingsTabRenderer,
    tabWarmupPolicy: ompTabWarmupPolicy,
    async dispose() {
      unregisterTransitionHook();
      await commandMetadataProbe.dispose();
    },
  };
}

export const ompWorkspaceRegistration: ProviderWorkspaceRegistration<OmpWorkspaceServices> = {
  initialize: async ({ plugin }) => createOmpWorkspaceServices(plugin),
};

export function maybeGetOmpWorkspaceServices(): OmpWorkspaceServices | null {
  return ProviderWorkspaceRegistry.getServices('omp') as OmpWorkspaceServices | null;
}

export function getOmpWorkspaceServices(): OmpWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices('omp') as OmpWorkspaceServices;
}
