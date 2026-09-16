import { getOmpProviderSettings } from '@/providers/omp/settings';
import { ompChatUIConfig } from '@/providers/omp/ui/OmpChatUIConfig';

function getOmpConfig(settings: Record<string, unknown>): Record<string, unknown> {
  return (settings.providerConfigs as Record<string, Record<string, unknown>>).omp;
}

const settings: Record<string, unknown> = {
  providerConfigs: {
    omp: {
      discoveredModels: [
        {
          encodedId: 'omp:anthropic/claude-sonnet-4',
          id: 'claude-sonnet-4',
          input: ['text'],
          label: 'Claude Sonnet 4',
          provider: 'anthropic',
          reasoning: true,
          thinkingLevels: ['off', 'medium', 'high', 'xhigh', 'max'],
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
      ],
      modelAliases: {
        'omp:anthropic/claude-sonnet-4': 'Sonnet',
      },
      preferredThinkingByModel: {
        'omp:anthropic/claude-sonnet-4': 'high',
      },
      visibleModels: ['omp:anthropic/claude-sonnet-4'],
    },
  },
};

describe('OmpChatUIConfig', () => {
  it('returns visible model options in reverse order with aliases', () => {
    const ompSettings = (settings.providerConfigs as Record<string, Record<string, unknown>>).omp;
    const options = ompChatUIConfig.getModelOptions({
      ...settings,
      providerConfigs: {
        omp: {
          ...ompSettings,
          visibleModels: [
            'omp:anthropic/claude-sonnet-4',
            'omp:openai/gpt-5',
          ],
        },
      },
    });

    expect(options).toEqual([
      expect.objectContaining({
        label: 'GPT-5',
        value: 'omp:openai/gpt-5',
      }),
      expect.objectContaining({
        label: 'Sonnet',
        value: 'omp:anthropic/claude-sonnet-4',
      }),
    ]);
  });

  it('excludes saved selections that are not enabled', () => {
    const options = ompChatUIConfig.getModelOptions({
      ...settings,
      savedProviderModel: {
        omp: 'omp:openai/gpt-5',
      },
    });

    expect(options).toEqual([
      expect.objectContaining({
        label: 'Sonnet',
        value: 'omp:anthropic/claude-sonnet-4',
      }),
    ]);
  });

  it('has no model fallback when no models are enabled', () => {
    expect(ompChatUIConfig.getModelOptions({ providerConfigs: { omp: {} } })).toEqual([]);
    expect(ompChatUIConfig.getDefaultModel!({ providerConfigs: { omp: {} } })).toBeNull();
    expect(ompChatUIConfig.ownsModel('omp', { providerConfigs: { omp: {} } })).toBe(false);
    expect(ompChatUIConfig.ownsModel('omp:anthropic/claude-sonnet-4', { providerConfigs: { omp: {} } })).toBe(true);
    expect(ompChatUIConfig.ownsModel('omp:invalid', { providerConfigs: { omp: {} } })).toBe(false);
  });

  it('uses the first enabled model as the default', () => {
    const ompSettings = (settings.providerConfigs as Record<string, Record<string, unknown>>).omp;
    expect(ompChatUIConfig.getDefaultModel!({
      ...settings,
      providerConfigs: {
        omp: {
          ...ompSettings,
          visibleModels: [
            'omp:openai/gpt-5',
            'omp:anthropic/claude-sonnet-4',
          ],
        },
      },
    })).toBe('omp:openai/gpt-5');
  });

  it('maps reasoning options and defaults from cached model metadata', () => {
    expect(ompChatUIConfig.isAdaptiveReasoningModel('omp:anthropic/claude-sonnet-4', settings)).toBe(true);
    expect(ompChatUIConfig.getReasoningOptions('omp:anthropic/claude-sonnet-4', settings)).toEqual([
      { label: 'Off', value: 'off' },
      { label: 'Medium', value: 'medium' },
      { label: 'High', value: 'high' },
      { label: 'xHigh', value: 'xhigh' },
      { label: 'Max', value: 'max' },
    ]);
    expect(ompChatUIConfig.getDefaultReasoningValue('omp:anthropic/claude-sonnet-4', settings)).toBe('high');
  });

  it('defaults reasoning models to high without a saved preference', () => {
    const settingsWithoutPreference: Record<string, unknown> = {
      providerConfigs: {
        omp: {
          discoveredModels: getOmpConfig(settings).discoveredModels,
          preferredThinkingByModel: {},
          visibleModels: ['omp:anthropic/claude-sonnet-4'],
        },
      },
    };

    expect(ompChatUIConfig.getDefaultReasoningValue(
      'omp:anthropic/claude-sonnet-4',
      settingsWithoutPreference,
    )).toBe('high');
  });

  it('applies only an existing per-model preference to conversation projections', () => {
    const withPreference = structuredClone(settings);
    withPreference.effortLevel = 'medium';
    ompChatUIConfig.applyModelProjectionDefaults?.(
      'omp:anthropic/claude-sonnet-4',
      withPreference,
    );
    expect(withPreference.effortLevel).toBe('high');

    const withoutPreference = structuredClone(settings);
    getOmpConfig(withoutPreference).preferredThinkingByModel = {};
    withoutPreference.effortLevel = 'medium';
    ompChatUIConfig.applyModelProjectionDefaults?.(
      'omp:anthropic/claude-sonnet-4',
      withoutPreference,
    );
    expect(withoutPreference.effortLevel).toBe('medium');
  });

  it('resolves context windows from cached Omp model metadata before falling back', () => {
    const contextSettings: Record<string, unknown> = {
      providerConfigs: {
        omp: {
          discoveredModels: [{
            contextWindow: 1_000_000,
            encodedId: 'omp:anthropic/claude-sonnet-4',
            id: 'claude-sonnet-4',
            input: ['text'],
            label: 'Claude Sonnet 4',
            provider: 'anthropic',
            reasoning: true,
            thinkingLevels: ['off', 'medium', 'high'],
          }],
          visibleModels: ['omp:anthropic/claude-sonnet-4'],
        },
      },
    };

    expect(ompChatUIConfig.getContextWindowSize(
      'omp:anthropic/claude-sonnet-4',
      { 'omp:anthropic/claude-sonnet-4': 123_000 },
      contextSettings,
    )).toBe(1_000_000);
    expect(ompChatUIConfig.getContextWindowSize(
      'omp:missing/model',
      { 'omp:missing/model': 123_000 },
      contextSettings,
    )).toBe(123_000);
    expect(ompChatUIConfig.getContextWindowSize('omp:missing/model', undefined, contextSettings)).toBe(200_000);
  });

  it('keeps decoded models on Omp effort controls when discovery metadata is stale', () => {
    const staleSettings: Record<string, unknown> = {
      providerConfigs: {
        omp: {
          visibleModels: ['omp:custom/model'],
        },
      },
      savedProviderModel: {
        omp: 'omp:custom/model',
      },
    };

    expect(ompChatUIConfig.getModelOptions(staleSettings)).toEqual([
      expect.objectContaining({
        label: 'custom/model',
        value: 'omp:custom/model',
      }),
    ]);
    expect(ompChatUIConfig.isAdaptiveReasoningModel('omp:custom/model', staleSettings)).toBe(true);
    expect(ompChatUIConfig.getReasoningOptions('omp:custom/model', staleSettings)).toEqual([
      { label: 'Off', value: 'off' },
      { label: 'Minimal', value: 'minimal' },
      { label: 'Low', value: 'low' },
      { label: 'Medium', value: 'medium' },
      { label: 'High', value: 'high' },
    ]);
    expect(ompChatUIConfig.getDefaultReasoningValue('omp:custom/model', staleSettings)).toBe('high');

    ompChatUIConfig.applyReasoningSelection?.('omp:custom/model', 'high', staleSettings);
    expect(getOmpProviderSettings(staleSettings).preferredThinkingByModel).toEqual({
      'omp:custom/model': 'high',
    });
  });

  it('maps toolbar permission mode to Omp tool mode', () => {
    const mutableSettings: Record<string, unknown> = {
      providerConfigs: {
        omp: {
          toolMode: 'readonly',
        },
      },
    };

    expect(ompChatUIConfig.resolvePermissionMode?.(mutableSettings)).toBe('normal');
    ompChatUIConfig.applyPermissionMode?.('yolo', mutableSettings);
    expect(ompChatUIConfig.resolvePermissionMode?.(mutableSettings)).toBe('yolo');
  });
});
