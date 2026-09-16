import { formatReasoningValueLabel } from '../../../core/providers/reasoning';
import type {
  ProviderChatUIConfig,
  ProviderPermissionModeToggleConfig,
  ProviderReasoningOption,
  ProviderUIOption,
} from '../../../core/providers/types';
import { OMP_PROVIDER_ICON } from '../../../shared/icons';
import {
  clampOmpThinkingLevel,
  decodeOmpModelId,
  getOmpSupportedThinkingLevels,
  isOmpModelSelectionId,
  OMP_DEFAULT_THINKING_LEVEL,
  type OmpDiscoveredModel,
  type OmpThinkingLevel,
} from '../models';
import {
  getOmpProviderSettings,
  updateOmpProviderSettings,
} from '../settings';

const DEFAULT_OMP_REASONING_LEVELS = getOmpSupportedThinkingLevels({ reasoning: true });
const DEFAULT_CONTEXT_WINDOW = 200_000;
const OMP_PERMISSION_MODE_TOGGLE: ProviderPermissionModeToggleConfig = {
  inactiveValue: 'normal',
  inactiveLabel: 'Read-only',
  activeValue: 'yolo',
  activeLabel: 'All tools',
};

export const ompChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(settings): ProviderUIOption[] {
    const ompSettings = getOmpProviderSettings(settings);
    const discoveredModels = new Map(ompSettings.discoveredModels.map((model) => [
      model.encodedId,
      buildModelOption(model, ompSettings.modelAliases[model.encodedId]),
    ]));
    const options: ProviderUIOption[] = [];
    const seen = new Set<string>();
    for (const encodedId of [...ompSettings.visibleModels].reverse()) {
      pushOption(
        options,
        seen,
        encodedId,
        discoveredModels.get(encodedId)
          ?? {
            description: 'Configured model',
            label: ompSettings.modelAliases[encodedId] ?? formatFallbackLabel(encodedId),
            value: encodedId,
          },
      );
    }

    return options;
  },

  getDefaultModel(settings: Record<string, unknown>): string | null {
    return getOmpProviderSettings(settings).visibleModels[0] ?? null;
  },

  ownsModel(model: string): boolean {
    return isOmpModelSelectionId(model);
  },

  isAdaptiveReasoningModel(model: string, settings: Record<string, unknown>): boolean {
    const ompModel = getCachedModel(model, settings);
    if (ompModel) {
      return ompModel.thinkingLevels.some(level => level !== 'off');
    }

    return !!decodeOmpModelId(model);
  },

  getReasoningOptions(model: string, settings: Record<string, unknown>): ProviderReasoningOption[] {
    const ompModel = getCachedModel(model, settings);
    const levels = ompModel?.thinkingLevels
      ?? (decodeOmpModelId(model) ? DEFAULT_OMP_REASONING_LEVELS : ['off']);
    return levels.map((level) => ({
      label: formatReasoningValueLabel(level),
      value: level,
    }));
  },

  getDefaultReasoningValue: getOmpDefaultReasoningValue,

  getContextWindowSize(
    model: string,
    customLimits?: Record<string, number>,
    settings?: Record<string, unknown>,
  ): number {
    const metadataContextWindow = settings
      ? getCachedModel(model, settings)?.contextWindow
      : undefined;
    return metadataContextWindow ?? customLimits?.[model] ?? DEFAULT_CONTEXT_WINDOW;
  },

  isDefaultModel(model: string): boolean {
    return isOmpModelSelectionId(model);
  },

  applyModelDefaults: applyOmpModelDefaults,

  applyModelProjectionDefaults: applyOmpModelProjectionDefaults,

  applyReasoningSelection(model: string, value: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return;
    }

    const settingsBag = settings as Record<string, unknown>;
    const ompModel = getCachedModel(model, settingsBag);
    const encodedId = ompModel?.encodedId ?? (decodeOmpModelId(model) ? model : '');
    if (!encodedId) {
      return;
    }
    const supportedLevels = ompModel?.thinkingLevels ?? DEFAULT_OMP_REASONING_LEVELS;

    const nextPreferredThinkingByModel = {
      ...getOmpProviderSettings(settingsBag).preferredThinkingByModel,
    };
    const normalizedValue = value as OmpThinkingLevel;
    if (!supportedLevels.includes(normalizedValue)) {
      delete nextPreferredThinkingByModel[encodedId];
    } else {
      nextPreferredThinkingByModel[encodedId] = normalizedValue;
    }

    updateOmpProviderSettings(settingsBag, {
      preferredThinkingByModel: nextPreferredThinkingByModel,
    });
  },

  normalizeModelVariant(model: string): string {
    return decodeOmpModelId(model) ? model : model;
  },

  getCustomModelIds(): Set<string> {
    return new Set<string>();
  },

  getModeSelector(): null {
    return null;
  },

  getPermissionModeToggle(): ProviderPermissionModeToggleConfig {
    return OMP_PERMISSION_MODE_TOGGLE;
  },

  resolvePermissionMode(settings: Record<string, unknown>): string | null {
    return getOmpProviderSettings(settings).toolMode === 'readonly' ? 'normal' : 'yolo';
  },

  applyPermissionMode(value: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return;
    }

    const settingsBag = settings as Record<string, unknown>;
    settingsBag.permissionMode = value;
    updateOmpProviderSettings(settingsBag, {
      toolMode: value === 'normal' ? 'readonly' : 'all',
    });
  },

  getProviderIcon() {
    return OMP_PROVIDER_ICON;
  },
};

function getCachedModel(model: string, settings: Record<string, unknown>): OmpDiscoveredModel | null {
  if (!decodeOmpModelId(model)) {
    return null;
  }

  return getOmpProviderSettings(settings).discoveredModels.find(entry => entry.encodedId === model) ?? null;
}

function applyOmpModelDefaults(model: string, settings: unknown): void {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return;
  }

  const settingsBag = settings as Record<string, unknown>;
  if (!decodeOmpModelId(model)) {
    settingsBag.effortLevel = 'off';
    return;
  }

  settingsBag.model = model;
  settingsBag.effortLevel = getOmpDefaultReasoningValue(model, settingsBag);
}

function applyOmpModelProjectionDefaults(model: string, settings: unknown): void {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return;
  }

  const settingsBag = settings as Record<string, unknown>;
  const preferredThinkingLevel = getOmpProviderSettings(settingsBag).preferredThinkingByModel[model];
  if (preferredThinkingLevel) {
    settingsBag.effortLevel = preferredThinkingLevel;
  }
}

function getOmpDefaultReasoningValue(model: string, settings: Record<string, unknown>): string {
  const ompModel = getCachedModel(model, settings);
  if (!ompModel) {
    return decodeOmpModelId(model) ? OMP_DEFAULT_THINKING_LEVEL : 'off';
  }

  const ompSettings = getOmpProviderSettings(settings);
  return clampOmpThinkingLevel(
    ompSettings.preferredThinkingByModel[ompModel.encodedId],
    ompModel.thinkingLevels,
  );
}

function buildModelOption(model: OmpDiscoveredModel, alias: string | undefined): ProviderUIOption {
  return {
    description: `${model.provider} runtime`,
    group: model.provider,
    label: alias ?? model.label,
    value: model.encodedId,
  };
}

function formatFallbackLabel(encodedId: string): string {
  const decoded = decodeOmpModelId(encodedId);
  return decoded ? `${decoded.provider}/${decoded.modelId}` : 'OMP';
}

function pushOption(
  target: ProviderUIOption[],
  seenValues: Set<string>,
  value: string,
  option: ProviderUIOption,
): void {
  if (seenValues.has(value)) {
    return;
  }

  seenValues.add(value);
  target.push(option);
}
