import { NOOP_TASK_RESULT_INTERPRETER } from '@/core/providers/NoopTaskResultInterpreter';
import { getProviderConfig } from '@/core/providers/providerConfig';
import { hasStoredConfigNormalization } from '@/core/providers/settings/storedSettings';
import type { ProviderModule } from '@/core/providers/types';
import {
  getOmpWorkspaceServices,
  ompWorkspaceRegistration,
} from '@/providers/omp/app/OmpWorkspaceServices';
import { OMP_PROVIDER_CAPABILITIES } from '@/providers/omp/capabilities';
import { ompSettingsReconciler } from '@/providers/omp/env/OmpSettingsReconciler';
import { OmpExecutionBackend } from '@/providers/omp/execution/OmpExecutionBackend';
import { OmpConversationHistoryService } from '@/providers/omp/history/OmpConversationHistoryService';
import { getOmpProviderSettings, updateOmpProviderSettings } from '@/providers/omp/settings';
import { ObsidianOmpExtensionUiRenderer } from '@/providers/omp/ui/ObsidianOmpExtensionUiRenderer';
import { ompChatUIConfig } from '@/providers/omp/ui/OmpChatUIConfig';

export const ompProviderRegistration: ProviderModule = {
  id: 'omp',
  blankTabOrder: 12,
  capabilities: OMP_PROVIDER_CAPABILITIES,
  chatUIConfig: ompChatUIConfig,
  createExecutionBackend: (plugin) => new OmpExecutionBackend(
    plugin,
    getOmpWorkspaceServices(),
    { extensionUiRenderer: new ObsidianOmpExtensionUiRenderer(plugin.app) },
  ),
  resolveTitleGenerationModel: (plugin) => {
    const settings = plugin.settings as unknown as Record<string, unknown>;
    const titleModel = typeof settings.titleGenerationModel === 'string'
      ? settings.titleGenerationModel
      : '';
    return ompChatUIConfig.ownsModel(titleModel, settings) ? titleModel : undefined;
  },
  displayName: 'OMP',
  environmentKeyPatterns: [/^OMP_/i, /^PI_/i],
  historyService: new OmpConversationHistoryService(),
  isEnabled: (settings) => getOmpProviderSettings(settings).enabled,
  setEnabled: (settings, enabled) => updateOmpProviderSettings(settings, { enabled }),
  settingsReconciler: ompSettingsReconciler,
  settingsStorage: {
    hostScopedFields: ['cliPathsByHost'],
    normalizeStored(target, stored) {
      const storedConfig = getProviderConfig(stored, 'omp');
      updateOmpProviderSettings(target, getOmpProviderSettings(stored));
      return hasStoredConfigNormalization(
        storedConfig,
        getProviderConfig(target, 'omp'),
      );
    },
  },
  taskResultInterpreter: NOOP_TASK_RESULT_INTERPRETER,
  workspace: ompWorkspaceRegistration,
};
