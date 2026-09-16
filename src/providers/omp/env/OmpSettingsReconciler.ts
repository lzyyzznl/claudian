import {
  type CliPathFingerprintInputs,
  createCliPathFingerprintInputs,
  hasCliPathFingerprintInputs,
} from '../../../core/providers/cli/CliPathFingerprintInputs';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import {
  createRuntimeInputFingerprint,
  isVersionedRuntimeInputFingerprint,
} from '../../../core/providers/settings/RuntimeInputFingerprint';
import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { getHostnameKey, parseEnvironmentVariables } from '../../../utils/env';
import { sameStringList } from '../internal/compareCollections';
import {
  clampOmpThinkingLevel,
  decodeOmpModelId,
  encodeOmpModelId,
  findOmpModel,
  isOmpModelSelectionId,
  OMP_DEFAULT_THINKING_LEVEL,
} from '../models';
import {
  getOmpProviderSettings,
  normalizeOmpVisibleModels,
  updateOmpProviderSettings,
} from '../settings';
import { clearOmpResumeState } from '../types';

// Omp still honours these pi-era session/config keys, so they stay in the runtime fingerprint.
const LEGACY_OMP_ENV_HASH_KEYS = [
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
  'PI_CONFIG_FILES',
  'PI_OFFLINE',
  'PI_SKIP_VERSION_CHECK',
  'PI_TELEMETRY',
  'PI_CACHE_RETENTION',
] as const;

const OMP_ENV_HASH_KEYS = [
  'OMP_PROFILE',
  'PI_PROFILE',
  ...LEGACY_OMP_ENV_HASH_KEYS,
  'OMP_WORKTREE_DIR',
  'OMP_AUTH_BROKER_URL',
  'OMP_AUTH_BROKER_TOKEN',
  'PATH',
] as const;

function computeOmpRuntimeFingerprint(
  environmentText: string,
  cliPathInputs: CliPathFingerprintInputs,
): string {
  return createRuntimeInputFingerprint({
    additionalInputs: cliPathInputs,
    environmentKeys: OMP_ENV_HASH_KEYS,
    environmentText,
  });
}

function invalidateOmpConversationSessions(conversations: Conversation[]): Conversation[] {
  return conversations.filter(conversation => (
    conversation.providerId === 'omp' && clearOmpResumeState(conversation)
  ));
}

function isCurrentLegacyOmpFingerprint(
  environmentText: string,
  savedFingerprint: string,
  cliPathInputs: CliPathFingerprintInputs,
): boolean {
  if (
    !savedFingerprint
    || isVersionedRuntimeInputFingerprint(savedFingerprint)
    || hasCliPathFingerprintInputs(cliPathInputs)
  ) {
    return false;
  }

  const environment = parseEnvironmentVariables(environmentText);
  const legacyFingerprint = LEGACY_OMP_ENV_HASH_KEYS
    .filter(key => environment[key])
    .map(key => `${key}=${environment[key]}`)
    .sort()
    .join('|');
  return savedFingerprint === legacyFingerprint;
}

export const ompSettingsReconciler: ProviderSettingsReconciler = {
  handleEnvironmentChange(settings: Record<string, unknown>): boolean {
    const current = getOmpProviderSettings(settings);
    if (current.discoveredModels.length === 0) {
      return false;
    }
    updateOmpProviderSettings(settings, {
      discoveredModels: [],
    });
    return true;
  },

  invalidateConversationSessions: invalidateOmpConversationSessions,

  reconcileModelWithEnvironment(
    settings: Record<string, unknown>,
    conversations: Conversation[],
  ): { changed: boolean; invalidatedConversations: Conversation[] } {
    const envText = getRuntimeEnvironmentText(settings, 'omp');
    const ompSettings = getOmpProviderSettings(settings);
    const cliPathInputs = createCliPathFingerprintInputs(
      ompSettings.cliPathsByHost[getHostnameKey()],
      ompSettings.cliPath,
    );
    const currentHash = computeOmpRuntimeFingerprint(envText, cliPathInputs);
    const savedHash = ompSettings.environmentHash;

    const environment = parseEnvironmentVariables(envText);
    const hasFingerprintInputs = Boolean(
      hasCliPathFingerprintInputs(cliPathInputs)
      || OMP_ENV_HASH_KEYS.some(key => Object.prototype.hasOwnProperty.call(environment, key))
    );
    if (!savedHash && !hasFingerprintInputs) {
      return { changed: false, invalidatedConversations: [] };
    }
    if (currentHash === savedHash) {
      return { changed: false, invalidatedConversations: [] };
    }

    const invalidatedConversations = invalidateOmpConversationSessions(conversations);

    updateOmpProviderSettings(settings, { environmentHash: currentHash });
    return { changed: true, invalidatedConversations };
  },

  normalizeModelVariantSettings(settings: Record<string, unknown>): boolean {
    const ompSettings = getOmpProviderSettings(settings);
    let changed = false;

    const envText = getRuntimeEnvironmentText(settings, 'omp');
    const cliPathInputs = createCliPathFingerprintInputs(
      ompSettings.cliPathsByHost[getHostnameKey()],
      ompSettings.cliPath,
    );
    if (isCurrentLegacyOmpFingerprint(
      envText,
      ompSettings.environmentHash,
      cliPathInputs,
    )) {
      updateOmpProviderSettings(settings, {
        environmentHash: computeOmpRuntimeFingerprint(envText, cliPathInputs),
      });
      changed = true;
    }

    const normalizeSelection = (value: unknown): string | null => {
      if (typeof value !== 'string') {
        return null;
      }

      if (!isOmpModelSelectionId(value)) {
        return value === 'omp' || value.startsWith('omp:') ? '' : null;
      }

      const decoded = decodeOmpModelId(value);
      if (decoded) {
        return encodeOmpModelId(decoded.provider, decoded.modelId);
      }
      return null;
    };

    const modelSelection = normalizeSelection(settings.model);
    if (
      typeof settings.model === 'string'
      && modelSelection !== null
      && settings.model !== modelSelection
    ) {
      settings.model = modelSelection;
      changed = true;
    }

    const titleModelSelection = normalizeSelection(settings.titleGenerationModel);
    if (
      typeof settings.titleGenerationModel === 'string'
      && titleModelSelection !== null
      && settings.titleGenerationModel !== titleModelSelection
    ) {
      settings.titleGenerationModel = titleModelSelection;
      changed = true;
    }

    const savedProviderModelRaw = settings.savedProviderModel;
    if (savedProviderModelRaw && typeof savedProviderModelRaw === 'object' && !Array.isArray(savedProviderModelRaw)) {
      const savedProviderModel = savedProviderModelRaw as Record<string, unknown>;
      const savedSelection = normalizeSelection(savedProviderModel.omp);
      if (
        typeof savedProviderModel.omp === 'string'
        && savedSelection !== null
        && savedProviderModel.omp !== savedSelection
      ) {
        if (savedSelection) {
          savedProviderModel.omp = savedSelection;
        } else {
          delete savedProviderModel.omp;
        }
        changed = true;
      }
    }

    const normalizedVisibleModels = normalizeOmpVisibleModels(
      ompSettings.visibleModels,
      ompSettings.discoveredModels,
    );
    const shouldUpdateProviderSettings = !sameStringList(normalizedVisibleModels, ompSettings.visibleModels);
    if (shouldUpdateProviderSettings) {
      updateOmpProviderSettings(settings, {
        visibleModels: normalizedVisibleModels,
      });
      changed = true;
    }

    if (typeof settings.effortLevel === 'string' && !settings.effortLevel.trim()) {
      settings.effortLevel = getDefaultOmpEffortForSelection(settings.model, ompSettings);
      changed = true;
    }

    return changed;
  },
};

function getDefaultOmpEffortForSelection(
  selection: unknown,
  ompSettings: ReturnType<typeof getOmpProviderSettings>,
): string {
  if (typeof selection !== 'string') {
    return 'off';
  }

  const decoded = decodeOmpModelId(selection);
  if (!decoded) {
    return 'off';
  }

  const model = findOmpModel(ompSettings, encodeOmpModelId(decoded.provider, decoded.modelId));
  return model
    ? clampOmpThinkingLevel(OMP_DEFAULT_THINKING_LEVEL, model.thinkingLevels)
    : OMP_DEFAULT_THINKING_LEVEL;
}
