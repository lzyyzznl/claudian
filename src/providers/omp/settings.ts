import { getProviderConfig, setProviderConfig } from '@/core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '@/core/providers/providerEnvironment';
import { normalizeHostnameStringMap } from '@/core/providers/settings/HostnameStringMap';
import {
  readStoredBoolean,
  readStoredString,
} from '@/core/providers/settings/storedSettings';
import type { HostnameCliPaths } from '@/core/types/settings';
import {
  clampOmpThinkingLevel,
  decodeOmpModelId,
  findOmpModel,
  isOmpModelSelectionId,
  normalizeOmpDiscoveredModels,
  normalizeOmpThinkingLevel,
  OMP_DEFAULT_THINKING_LEVEL,
  type OmpDiscoveredModel,
  type OmpThinkingLevel,
} from '@/providers/omp/models';
import { getHostnameKey } from '@/utils/env';

import { ensureProviderProjectionMap } from './internal/providerProjection';

export type OmpToolMode = 'all' | 'readonly';

export interface PersistedOmpProviderSettings {
  cliPath: string;
  cliPathsByHost: HostnameCliPaths;
  discoveredModels: OmpDiscoveredModel[];
  enabled: boolean;
  environmentHash: string;
  environmentVariables: string;
  modelAliases: Record<string, string>;
  preferredThinkingByModel: Record<string, OmpThinkingLevel>;
  toolMode: OmpToolMode;
  visibleModels: string[];
}

export type OmpProviderSettings = PersistedOmpProviderSettings;

export const DEFAULT_OMP_PROVIDER_SETTINGS: Readonly<PersistedOmpProviderSettings> = Object.freeze({
  cliPath: '',
  cliPathsByHost: {},
  discoveredModels: [],
  enabled: false,
  environmentHash: '',
  environmentVariables: '',
  modelAliases: {},
  preferredThinkingByModel: {},
  toolMode: 'all',
  visibleModels: [],
});

export function normalizeOmpVisibleModels(
  value: unknown,
  discoveredModels: OmpDiscoveredModel[] = [],
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const knownIds = new Set(discoveredModels.map(model => model.encodedId));
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }

    const trimmed = entry.trim();
    if (!trimmed || !decodeOmpModelId(trimmed)) {
      continue;
    }
    if (knownIds.size > 0 && !knownIds.has(trimmed)) {
      continue;
    }
    if (seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

export function normalizeOmpModelAliases(
  value: unknown,
  discoveredModels: OmpDiscoveredModel[] = [],
): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalized: Record<string, string> = {};
  for (const [encodedId, alias] of Object.entries(value as Record<string, unknown>)) {
    if (typeof alias !== 'string') {
      continue;
    }

    const normalizedEncodedId = normalizeOmpEncodedId(encodedId, discoveredModels);
    const normalizedAlias = alias.trim();
    if (!normalizedEncodedId || !normalizedAlias) {
      continue;
    }

    normalized[normalizedEncodedId] = normalizedAlias;
  }

  return normalized;
}

export function normalizeOmpPreferredThinkingByModel(
  value: unknown,
  discoveredModels: OmpDiscoveredModel[] = [],
): Record<string, OmpThinkingLevel> {
  return normalizeOmpPreferredThinkingEntries(
    value,
    discoveredModels,
    encodedId => normalizeOmpEncodedId(encodedId, discoveredModels),
  );
}

export function getOmpProviderSettings(settings: Record<string, unknown>): OmpProviderSettings {
  const config = getProviderConfig(settings, 'omp');
  const cliPathsByHost = normalizeHostnameStringMap(config.cliPathsByHost);
  const discoveredModels = normalizeOmpDiscoveredModels(config.discoveredModels);
  const visibleModels = normalizeOmpVisibleModels(config.visibleModels, discoveredModels);
  const persistableIds = getPersistableOmpModelIds(settings, visibleModels);

  return {
    cliPath: readStoredString(config.cliPath, DEFAULT_OMP_PROVIDER_SETTINGS.cliPath),
    cliPathsByHost,
    discoveredModels,
    enabled: readStoredBoolean(config.enabled, DEFAULT_OMP_PROVIDER_SETTINGS.enabled),
    environmentHash: readStoredString(
      config.environmentHash,
      DEFAULT_OMP_PROVIDER_SETTINGS.environmentHash,
    ),
    environmentVariables: readStoredString(
      config.environmentVariables,
      getProviderEnvironmentVariables(settings, 'omp')
        ?? DEFAULT_OMP_PROVIDER_SETTINGS.environmentVariables,
    ),
    modelAliases: normalizeOmpModelAliasesForPersistableIds(
      config.modelAliases,
      discoveredModels,
      persistableIds,
    ),
    preferredThinkingByModel: normalizeOmpPreferredThinkingForPersistableIds(
      config.preferredThinkingByModel,
      discoveredModels,
      persistableIds,
    ),
    toolMode: normalizeOmpToolMode(config.toolMode),
    visibleModels,
  };
}

export function updateOmpProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<OmpProviderSettings>,
): OmpProviderSettings {
  const current = getOmpProviderSettings(settings);
  const hostnameKey = getHostnameKey();
  const nextDiscoveredModels = normalizeOmpDiscoveredModels(
    updates.discoveredModels ?? current.discoveredModels,
  );
  const nextVisibleModels = normalizeOmpVisibleModels(
    updates.visibleModels ?? current.visibleModels,
    nextDiscoveredModels,
  );
  const persistableIds = getPersistableOmpModelIds(settings, nextVisibleModels);
  const nextModelAliases = pruneMapToPersistableIds(
    normalizeOmpModelAliasesForPersistableIds(
      updates.modelAliases ?? current.modelAliases,
      nextDiscoveredModels,
      persistableIds,
    ),
    persistableIds,
  );
  const nextPreferredThinkingByModel = pruneMapToPersistableIds(
    normalizeOmpPreferredThinkingForPersistableIds(
      updates.preferredThinkingByModel ?? current.preferredThinkingByModel,
      nextDiscoveredModels,
      persistableIds,
    ),
    persistableIds,
  );
  const nextCliPathsByHost = 'cliPathsByHost' in updates
    ? normalizeHostnameStringMap(updates.cliPathsByHost)
    : { ...current.cliPathsByHost };
  let nextCliPath = 'cliPathsByHost' in updates
    ? (
      typeof updates.cliPath === 'string'
        ? updates.cliPath.trim()
        : DEFAULT_OMP_PROVIDER_SETTINGS.cliPath
    )
    : current.cliPath.trim();

  if ('cliPath' in updates && !('cliPathsByHost' in updates)) {
    const trimmedCliPath = typeof updates.cliPath === 'string' ? updates.cliPath.trim() : '';
    if (trimmedCliPath) {
      nextCliPathsByHost[hostnameKey] = trimmedCliPath;
    } else {
      delete nextCliPathsByHost[hostnameKey];
    }
    nextCliPath = DEFAULT_OMP_PROVIDER_SETTINGS.cliPath;
  }

  const next: OmpProviderSettings = {
    ...current,
    ...updates,
    cliPath: nextCliPath,
    cliPathsByHost: nextCliPathsByHost,
    discoveredModels: nextDiscoveredModels,
    modelAliases: nextModelAliases,
    preferredThinkingByModel: nextPreferredThinkingByModel,
    toolMode: normalizeOmpToolMode(updates.toolMode ?? current.toolMode),
    visibleModels: nextVisibleModels,
  };

  if (updates.visibleModels !== undefined) {
    retargetRemovedOmpSelections(settings, next);
    const retargetedPersistableIds = getPersistableOmpModelIds(settings, next.visibleModels);
    next.modelAliases = pruneMapToPersistableIds(next.modelAliases, retargetedPersistableIds);
    next.preferredThinkingByModel = pruneMapToPersistableIds(
      next.preferredThinkingByModel,
      retargetedPersistableIds,
    );
  }

  setProviderConfig(settings, 'omp', {
    cliPath: next.cliPath,
    cliPathsByHost: next.cliPathsByHost,
    discoveredModels: next.discoveredModels,
    enabled: next.enabled,
    environmentHash: next.environmentHash,
    environmentVariables: next.environmentVariables,
    modelAliases: next.modelAliases,
    preferredThinkingByModel: next.preferredThinkingByModel,
    toolMode: next.toolMode,
    visibleModels: next.visibleModels,
  });

  return next;
}

function normalizeOmpModelAliasesForPersistableIds(
  value: unknown,
  discoveredModels: OmpDiscoveredModel[],
  persistableIds: Set<string>,
): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalized: Record<string, string> = {};
  for (const [encodedId, alias] of Object.entries(value as Record<string, unknown>)) {
    if (typeof alias !== 'string') {
      continue;
    }

    const normalizedEncodedId = normalizeOmpPersistableEncodedId(
      encodedId,
      discoveredModels,
      persistableIds,
    );
    const normalizedAlias = alias.trim();
    if (!normalizedEncodedId || !normalizedAlias) {
      continue;
    }

    normalized[normalizedEncodedId] = normalizedAlias;
  }

  return normalized;
}

function normalizeOmpPreferredThinkingForPersistableIds(
  value: unknown,
  discoveredModels: OmpDiscoveredModel[],
  persistableIds: Set<string>,
): Record<string, OmpThinkingLevel> {
  return normalizeOmpPreferredThinkingEntries(
    value,
    discoveredModels,
    encodedId => normalizeOmpPersistableEncodedId(
      encodedId,
      discoveredModels,
      persistableIds,
    ),
  );
}

function normalizeOmpPreferredThinkingEntries(
  value: unknown,
  discoveredModels: OmpDiscoveredModel[],
  normalizeEncodedId: (encodedId: string) => string,
): Record<string, OmpThinkingLevel> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalized: Record<string, OmpThinkingLevel> = {};
  for (const [encodedId, thinkingLevel] of Object.entries(value as Record<string, unknown>)) {
    const normalizedEncodedId = normalizeEncodedId(encodedId);
    const normalizedThinkingLevel = normalizeOmpThinkingLevel(thinkingLevel);
    if (!normalizedEncodedId || !normalizedThinkingLevel) {
      continue;
    }

    const discoveredModel = discoveredModels.find(model => model.encodedId === normalizedEncodedId);
    normalized[normalizedEncodedId] = discoveredModel
      ? clampOmpThinkingLevel(normalizedThinkingLevel, discoveredModel.thinkingLevels)
      : normalizedThinkingLevel;
  }

  return normalized;
}

export function resolveOmpModelAlias(
  settings: OmpProviderSettings,
  encodedId: string,
): string | null {
  return settings.modelAliases[encodedId] ?? null;
}

function normalizeOmpToolMode(value: unknown): OmpToolMode {
  if (value === undefined) {
    return 'all';
  }
  return value === 'all' || value === 'readonly' ? value : 'readonly';
}

function normalizeOmpEncodedId(
  value: string,
  discoveredModels: OmpDiscoveredModel[],
): string {
  const trimmed = value.trim();
  const decoded = decodeOmpModelId(trimmed);
  if (!decoded) {
    return '';
  }

  if (discoveredModels.length === 0) {
    return trimmed;
  }

  const discoveredModel = findOmpModel({ discoveredModels }, trimmed);
  return discoveredModel ? discoveredModel.encodedId : '';
}

function normalizeOmpPersistableEncodedId(
  value: string,
  discoveredModels: OmpDiscoveredModel[],
  persistableIds: Set<string>,
): string {
  const trimmed = value.trim();
  const decoded = decodeOmpModelId(trimmed);
  if (!decoded) {
    return '';
  }

  const discoveredModel = findOmpModel({ discoveredModels }, trimmed);
  if (discoveredModel) {
    return discoveredModel.encodedId;
  }

  return persistableIds.has(trimmed) ? trimmed : '';
}

function getPersistableOmpModelIds(
  settings: Record<string, unknown>,
  visibleModels: string[],
): Set<string> {
  const persistableIds = new Set(visibleModels);
  addPersistableSelection(persistableIds, settings.model);
  addPersistableSelection(persistableIds, settings.titleGenerationModel);

  const savedProviderModel = settings.savedProviderModel;
  if (savedProviderModel && typeof savedProviderModel === 'object' && !Array.isArray(savedProviderModel)) {
    addPersistableSelection(persistableIds, (savedProviderModel as Record<string, unknown>).omp);
  }

  return persistableIds;
}

function addPersistableSelection(target: Set<string>, value: unknown): void {
  if (typeof value === 'string' && decodeOmpModelId(value)) {
    target.add(value);
  }
}

function pruneMapToPersistableIds<T extends string>(
  value: Record<string, T>,
  persistableIds: Set<string>,
): Record<string, T> {
  const pruned: Record<string, T> = {};
  for (const [encodedId, entry] of Object.entries(value)) {
    if (persistableIds.has(encodedId)) {
      pruned[encodedId] = entry;
    }
  }
  return pruned;
}

function retargetRemovedOmpSelections(
  settings: Record<string, unknown>,
  next: OmpProviderSettings,
): void {
  if (next.visibleModels.length === 0) {
    if (typeof settings.titleGenerationModel === 'string' && isOmpModelSelectionId(settings.titleGenerationModel)) {
      settings.titleGenerationModel = '';
    }
    return;
  }

  const visibleSet = new Set(next.visibleModels);
  const fallbackModelId = next.visibleModels[0];
  const fallbackModel = findOmpModel(next, fallbackModelId);
  const fallbackEffort = next.preferredThinkingByModel[fallbackModelId]
    ?? (fallbackModel
      ? clampOmpThinkingLevel(OMP_DEFAULT_THINKING_LEVEL, fallbackModel.thinkingLevels)
      : OMP_DEFAULT_THINKING_LEVEL);

  const maybeRetargetModel = (value: unknown): string | null => {
    if (typeof value !== 'string' || !isOmpModelSelectionId(value)) {
      return null;
    }

    return visibleSet.has(value) ? null : fallbackModelId;
  };

  const savedProviderModel = ensureProviderProjectionMap(settings, 'savedProviderModel');
  const nextSavedModel = maybeRetargetModel(savedProviderModel.omp);
  if (nextSavedModel) {
    savedProviderModel.omp = nextSavedModel;
    ensureProviderProjectionMap(settings, 'savedProviderEffort').omp = fallbackEffort;
  }

  const nextTopLevelModel = maybeRetargetModel(settings.model);
  if (nextTopLevelModel) {
    settings.model = nextTopLevelModel;
    settings.effortLevel = fallbackEffort;
  }

  const nextTitleGenerationModel = maybeRetargetModel(settings.titleGenerationModel);
  if (nextTitleGenerationModel) {
    settings.titleGenerationModel = nextTitleGenerationModel;
  }
}
