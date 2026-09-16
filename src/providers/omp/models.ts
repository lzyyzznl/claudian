import {
  DEFAULT_REASONING_VALUE,
  resolvePreferredReasoningDefault,
} from '@/core/providers/reasoning';

/**
 * Single owner of the omp `--thinking` vocabulary; runtime, settings, and UI slices import this union.
 */
export const OMP_THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'auto',
] as const;

export type OmpThinkingLevel = typeof OMP_THINKING_LEVELS[number];

export interface OmpDiscoveredModel {
  api?: string;
  contextWindow?: number;
  encodedId: string;
  id: string;
  input: Array<'text' | 'image'>;
  label: string;
  maxTokens?: number;
  provider: string;
  reasoning: boolean;
  thinkingLevels: OmpThinkingLevel[];
}

export interface DecodedOmpModelId {
  modelId: string;
  provider: string;
}

export const OMP_MODEL_PREFIX = 'omp:';
export const OMP_DEFAULT_THINKING_LEVEL: OmpThinkingLevel = DEFAULT_REASONING_VALUE;

const VALID_THINKING_LEVELS: Readonly<Record<OmpThinkingLevel, true>> = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
  auto: true,
};
const DEFAULT_REASONING_LEVELS: OmpThinkingLevel[] = OMP_THINKING_LEVELS.filter(
  level => level !== 'xhigh' && level !== 'max' && level !== 'auto',
);

export function isOmpModelSelectionId(model: string): boolean {
  return decodeOmpModelId(model) !== null;
}

export function encodeOmpModelId(provider: string, modelId: string): string {
  const normalizedProvider = provider.trim();
  const normalizedModelId = modelId.trim();
  if (!normalizedProvider || !normalizedModelId) {
    return '';
  }

  return `${OMP_MODEL_PREFIX}${normalizedProvider}/${normalizedModelId}`;
}

export function decodeOmpModelId(model: string): DecodedOmpModelId | null {
  if (!model.startsWith(OMP_MODEL_PREFIX)) {
    return null;
  }

  const raw = model.slice(OMP_MODEL_PREFIX.length).trim();
  const slashIndex = raw.indexOf('/');
  if (slashIndex <= 0 || slashIndex >= raw.length - 1) {
    return null;
  }

  const provider = raw.slice(0, slashIndex).trim();
  const modelId = raw.slice(slashIndex + 1).trim();
  return provider && modelId ? { provider, modelId } : null;
}

export function normalizeOmpThinkingLevel(value: unknown): OmpThinkingLevel | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return Object.hasOwn(VALID_THINKING_LEVELS, normalized)
    ? normalized as OmpThinkingLevel
    : null;
}

export function getOmpSupportedThinkingLevels(value: unknown): OmpThinkingLevel[] {
  const record = isPlainObject(value) ? value : {};
  const explicitLevels = collectExplicitThinkingLevels(record);
  const mappedLevels = collectThinkingLevelMapLevels(record);
  const reasoning = record.reasoning === true
    || record.supportsReasoning === true
    || record.thinking === true
    || record.canReason === true
    || explicitLevels.length > 0
    || mappedLevels.levels.length > 0;
  if (!reasoning) {
    return ['off'];
  }

  if (explicitLevels.length === 0 && mappedLevels.levels.length === 0) {
    return [...DEFAULT_REASONING_LEVELS];
  }

  const result: OmpThinkingLevel[] = [];
  const seen = new Set<OmpThinkingLevel>();
  for (const level of [...explicitLevels, ...mappedLevels.levels]) {
    if (level === null || mappedLevels.disabledLevels.has(level)) {
      continue;
    }

    if (!seen.has(level)) {
      seen.add(level);
      result.push(level);
    }
  }

  return result.length > 0 ? sortThinkingLevels(result) : [...DEFAULT_REASONING_LEVELS];
}

export function normalizeOmpDiscoveredModels(value: unknown): OmpDiscoveredModel[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: OmpDiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isPlainObject(entry)) {
      continue;
    }

    const provider = firstString(entry.provider, entry.providerId, entry.api)?.trim() ?? '';
    const id = firstString(entry.id, entry.modelId, entry.model, entry.name)?.trim() ?? '';
    if (!provider || !id) {
      continue;
    }

    const key = `${provider}\0${id}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    const label = firstString(entry.label, entry.displayName, entry.name)?.trim()
      || `${provider}/${id}`;
    const api = firstString(entry.api)?.trim();
    const contextWindow = firstFinitePositiveNumber(
      entry.contextWindow,
      entry.context_window,
      entry.context,
      entry.maxContextTokens,
      entry.max_context_tokens,
    );
    const maxTokens = firstFinitePositiveNumber(
      entry.maxTokens,
      entry.max_tokens,
      entry.outputTokens,
      entry.output_tokens,
    );
    const input = normalizeModelInputs(
      entry.input ?? entry.inputs ?? entry.modalities ?? entry.supportedInputs,
    );
    const thinkingLevels = getOmpSupportedThinkingLevels(entry);
    const reasoning = thinkingLevels.some(level => level !== 'off');

    normalized.push({
      ...(api ? { api } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      encodedId: encodeOmpModelId(provider, id),
      id,
      input,
      label,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      provider,
      reasoning,
      thinkingLevels,
    });
  }

  return normalized;
}

export function findOmpModel(
  settings: { discoveredModels: OmpDiscoveredModel[] },
  encodedId: string,
): OmpDiscoveredModel | null {
  return settings.discoveredModels.find(model => model.encodedId === encodedId) ?? null;
}

export function clampOmpThinkingLevel(
  level: string | undefined,
  supportedLevels: OmpThinkingLevel[],
): OmpThinkingLevel {
  const normalized = normalizeOmpThinkingLevel(level);
  if (normalized && supportedLevels.includes(normalized)) {
    return normalized;
  }

  if (supportedLevels.length === 0) {
    return 'off';
  }

  if (normalized) {
    const requestedIndex = OMP_THINKING_LEVELS.indexOf(normalized);
    for (let index = requestedIndex + 1; index < OMP_THINKING_LEVELS.length; index++) {
      const candidate = OMP_THINKING_LEVELS[index];
      if (supportedLevels.includes(candidate)) {
        return candidate;
      }
    }
    for (let index = requestedIndex - 1; index >= 0; index--) {
      const candidate = OMP_THINKING_LEVELS[index];
      if (supportedLevels.includes(candidate)) {
        return candidate;
      }
    }
  }

  return resolvePreferredReasoningDefault(supportedLevels, 'medium') as OmpThinkingLevel;
}

function collectExplicitThinkingLevels(record: Record<string, unknown>): Array<OmpThinkingLevel | null> {
  const rawLevels = [
    record.thinkingLevels,
    record.thinking_levels,
    record.reasoningLevels,
    record.reasoning_levels,
    isPlainObject(record.thinking) ? record.thinking.levels : undefined,
    isPlainObject(record.thinking) ? record.thinking.efforts : undefined,
    isPlainObject(record.reasoning) ? record.reasoning.levels : undefined,
    isPlainObject(record.reasoning) ? record.reasoning.efforts : undefined,
  ].find(Array.isArray);

  if (!Array.isArray(rawLevels)) {
    return [];
  }

  return rawLevels
    .map((level): OmpThinkingLevel | null | undefined => {
      if (level === null) {
        return null;
      }
      return normalizeOmpThinkingLevel(level) ?? undefined;
    })
    .filter((level): level is OmpThinkingLevel | null => level !== undefined);
}

function collectThinkingLevelMapLevels(record: Record<string, unknown>): {
  disabledLevels: Set<OmpThinkingLevel>;
  levels: OmpThinkingLevel[];
} {
  const rawMap = isPlainObject(record.thinkingLevelMap)
    ? record.thinkingLevelMap
    : isPlainObject(record.thinking_level_map)
    ? record.thinking_level_map
    : null;
  if (!rawMap) {
    return { disabledLevels: new Set<OmpThinkingLevel>(), levels: [] };
  }

  const disabledLevels = new Set<OmpThinkingLevel>();
  const levels: OmpThinkingLevel[] = [...DEFAULT_REASONING_LEVELS];
  for (const [rawLevel, mappedLevel] of Object.entries(rawMap)) {
    const level = normalizeOmpThinkingLevel(rawLevel);
    if (!level) {
      continue;
    }
    if (mappedLevel === null) {
      disabledLevels.add(level);
    } else {
      levels.push(level);
    }
  }
  return { disabledLevels, levels };
}

function sortThinkingLevels(levels: OmpThinkingLevel[]): OmpThinkingLevel[] {
  const rank = new Map(OMP_THINKING_LEVELS.map((level, index) => [level, index] as const));
  return [...levels].sort((left, right) => (rank.get(left) ?? 99) - (rank.get(right) ?? 99));
}

function normalizeModelInputs(value: unknown): Array<'text' | 'image'> {
  const rawInputs = Array.isArray(value) ? value : ['text'];
  const inputs: Array<'text' | 'image'> = [];
  const seen = new Set<'text' | 'image'>();

  for (const entry of rawInputs) {
    const normalized = typeof entry === 'string' ? entry.trim().toLowerCase() : '';
    const input = normalized === 'image' || normalized === 'images'
      ? 'image'
      : normalized === 'text'
      ? 'text'
      : null;
    if (input && !seen.has(input)) {
      seen.add(input);
      inputs.push(input);
    }
  }

  return inputs.length > 0 ? inputs : ['text'];
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

function firstFinitePositiveNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
