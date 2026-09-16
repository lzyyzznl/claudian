import {
  clampOmpThinkingLevel,
  decodeOmpModelId,
  encodeOmpModelId,
  getOmpSupportedThinkingLevels,
  normalizeOmpDiscoveredModels,
  normalizeOmpThinkingLevel,
} from '@/providers/omp/models';

describe('Omp model helpers', () => {
  it('encodes and decodes provider/model ids', () => {
    expect(encodeOmpModelId('anthropic', 'claude/sonnet')).toBe('omp:anthropic/claude/sonnet');
    expect(decodeOmpModelId('omp:anthropic/claude/sonnet')).toEqual({
      modelId: 'claude/sonnet',
      provider: 'anthropic',
    });
  });

  it('rejects invalid Omp model ids', () => {
    expect(encodeOmpModelId('', '')).toBe('');
    expect(decodeOmpModelId('')).toBeNull();
    expect(decodeOmpModelId('omp:')).toBeNull();
    expect(decodeOmpModelId('omp:anthropic')).toBeNull();
    expect(decodeOmpModelId('claude')).toBeNull();
  });

  it('normalizes thinking levels with Omp reasoning rules', () => {
    expect(normalizeOmpThinkingLevel(' MAX ')).toBe('max');
    expect(getOmpSupportedThinkingLevels({ reasoning: false })).toEqual(['off']);
    expect(getOmpSupportedThinkingLevels({ reasoning: true })).toEqual([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
    ]);
    expect(getOmpSupportedThinkingLevels({
      reasoning: true,
      thinkingLevels: ['max', 'low', null, 'xhigh', 'invalid', 'low'],
    })).toEqual(['low', 'xhigh', 'max']);
    expect(getOmpSupportedThinkingLevels({
      reasoning: {
        levels: ['minimal', 'high'],
      },
    })).toEqual(['minimal', 'high']);
    expect(getOmpSupportedThinkingLevels({
      reasoning: true,
      thinkingLevelMap: {
        high: null,
        max: 'max',
        minimal: 'low',
        xhigh: 'xhigh',
      },
    })).toEqual(['off', 'minimal', 'low', 'medium', 'xhigh', 'max']);
    expect(getOmpSupportedThinkingLevels({
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: 'low',
        medium: null,
        high: 'high',
        xhigh: null,
        max: 'max',
      },
    })).toEqual(['low', 'high', 'max']);
  });

  it('clamps supported thinking levels with Omp ladder semantics', () => {
    expect(clampOmpThinkingLevel(
      'max',
      ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    )).toBe('max');
    expect(clampOmpThinkingLevel(
      'max',
      ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
    )).toBe('xhigh');
    expect(clampOmpThinkingLevel('max', ['off', 'high'])).toBe('high');
    expect(clampOmpThinkingLevel('medium', ['low', 'high', 'max'])).toBe('high');
    expect(clampOmpThinkingLevel('auto', ['off', 'low', 'high'])).toBe('high');
  });

  it('accepts the omp thinking vocabulary including auto', () => {
    expect(normalizeOmpThinkingLevel(' auto ')).toBe('auto');
    expect(getOmpSupportedThinkingLevels({
      reasoning: true,
      thinkingLevels: ['auto', 'max', 'low'],
    })).toEqual(['low', 'max', 'auto']);
  });

  it('normalizes discovered model records', () => {
    expect(normalizeOmpDiscoveredModels([
      {
        contextWindow: 100_000,
        id: 'claude/sonnet',
        input: ['text', 'image', 'audio'],
        label: '  Sonnet  ',
        provider: 'anthropic',
        reasoning: true,
        thinkingLevels: ['off', 'medium'],
      },
      {
        id: 'claude/sonnet',
        label: 'Duplicate',
        provider: 'anthropic',
      },
      {
        id: 'gpt-5',
        name: 'GPT-5',
        provider: 'openai',
        reasoning: false,
      },
    ])).toEqual([
      {
        contextWindow: 100_000,
        encodedId: 'omp:anthropic/claude/sonnet',
        id: 'claude/sonnet',
        input: ['text', 'image'],
        label: 'Sonnet',
        provider: 'anthropic',
        reasoning: true,
        thinkingLevels: ['off', 'medium'],
      },
      {
        encodedId: 'omp:openai/gpt-5',
        id: 'gpt-5',
        input: ['text'],
        label: 'GPT-5',
        provider: 'openai',
        reasoning: false,
        thinkingLevels: ['off'],
      },
    ]);
  });

  it('accepts omp model entries with effort levels and ignores extra cost fields', () => {
    expect(normalizeOmpDiscoveredModels([
      {
        api: 'anthropic',
        contextWindow: 200_000,
        cost: { cacheRead: 0.3, cacheWrite: 3.75, input: 3, output: 15, timeBased: 1 },
        id: 'claude-sonnet-4',
        input: ['text', 'image'],
        maxTokens: 64_000,
        name: 'Claude Sonnet 4',
        provider: 'anthropic',
        reasoning: true,
        thinking: { efforts: ['low', 'high', 'max'], mode: 'effort' },
      },
    ])).toEqual([
      {
        api: 'anthropic',
        contextWindow: 200_000,
        encodedId: 'omp:anthropic/claude-sonnet-4',
        id: 'claude-sonnet-4',
        input: ['text', 'image'],
        label: 'Claude Sonnet 4',
        maxTokens: 64_000,
        provider: 'anthropic',
        reasoning: true,
        thinkingLevels: ['low', 'high', 'max'],
      },
    ]);
  });
});
