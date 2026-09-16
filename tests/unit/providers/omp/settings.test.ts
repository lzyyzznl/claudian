const mockGetHostnameKey = jest.fn(() => 'host-a');

jest.mock('../../../../src/utils/env', () => ({
  ...jest.requireActual('../../../../src/utils/env'),
  getHostnameKey: () => mockGetHostnameKey(),
}));

import { ompSettingsReconciler } from '@/providers/omp/env/OmpSettingsReconciler';
import {
  DEFAULT_OMP_PROVIDER_SETTINGS,
  getOmpProviderSettings,
  normalizeOmpModelAliases,
  normalizeOmpPreferredThinkingByModel,
  normalizeOmpVisibleModels,
  updateOmpProviderSettings,
} from '@/providers/omp/settings';

describe('Omp settings normalization', () => {
  const discoveredModels = [
    {
      encodedId: 'omp:anthropic/claude-sonnet-4',
      id: 'claude-sonnet-4',
      input: ['text' as const],
      label: 'Claude Sonnet 4',
      provider: 'anthropic',
      reasoning: true,
      thinkingLevels: ['off' as const, 'medium' as const, 'high' as const],
    },
    {
      encodedId: 'omp:openai/gpt-5',
      id: 'gpt-5',
      input: ['text' as const, 'image' as const],
      label: 'GPT-5',
      provider: 'openai',
      reasoning: true,
      thinkingLevels: ['off' as const, 'low' as const, 'medium' as const],
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetHostnameKey.mockReturnValue('host-a');
  });

  it('defaults Omp to disabled all-tools mode', () => {
    expect(DEFAULT_OMP_PROVIDER_SETTINGS).toMatchObject({
      enabled: false,
      toolMode: 'all',
      visibleModels: [],
    });
  });

  it('preserves hostname-scoped CLI paths without assigning them to the current device', () => {
    mockGetHostnameKey.mockReturnValue('device:current');

    expect(getOmpProviderSettings({
      providerConfigs: {
        omp: {
          cliPathsByHost: {
            'host-a': '/host-a/omp',
            'host-b': '/host-b/omp',
          },
        },
      },
    }).cliPathsByHost).toEqual({
      'host-a': '/host-a/omp',
      'host-b': '/host-b/omp',
    });
  });

  it('rejects arrays and filters mixed hostname CLI maps', () => {
    expect(getOmpProviderSettings({
      providerConfigs: { omp: { cliPathsByHost: ['/array/omp'] } },
    }).cliPathsByHost).toEqual({});
    expect(getOmpProviderSettings({
      providerConfigs: {
        omp: {
          cliPathsByHost: { ' host-a ': ' /host-a/omp ', invalid: null },
        },
      },
    }).cliPathsByHost).toEqual({ 'host-a': '/host-a/omp' });
  });

  it('normalizes visible models to valid encoded ids', () => {
    expect(normalizeOmpVisibleModels([
      'omp:anthropic/claude-sonnet-4',
      'omp:anthropic/claude-sonnet-4',
      'omp:missing/model',
      'openai/gpt-5',
    ], discoveredModels)).toEqual(['omp:anthropic/claude-sonnet-4']);
  });

  it('normalizes aliases and clamps preferred thinking to model capabilities', () => {
    expect(normalizeOmpModelAliases({
      'omp:anthropic/claude-sonnet-4': '  Sonnet  ',
      'omp:missing/model': 'Missing',
    }, discoveredModels)).toEqual({
      'omp:anthropic/claude-sonnet-4': 'Sonnet',
    });
    expect(normalizeOmpPreferredThinkingByModel({
      'omp:anthropic/claude-sonnet-4': 'max',
      'omp:openai/gpt-5': 'xhigh',
    }, discoveredModels)).toEqual({
      'omp:anthropic/claude-sonnet-4': 'high',
      'omp:openai/gpt-5': 'medium',
    });
  });

  it('clamps max preferences to xhigh before high', () => {
    expect(normalizeOmpPreferredThinkingByModel({
      'omp:anthropic/claude-opus-4-7': 'max',
      'omp:anthropic/claude-sonnet-4': 'max',
    }, [
      {
        encodedId: 'omp:anthropic/claude-opus-4-7',
        id: 'claude-opus-4-7',
        input: ['text'],
        label: 'Claude Opus 4.7',
        provider: 'anthropic',
        reasoning: true,
        thinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh'],
      },
      discoveredModels[0],
    ])).toEqual({
      'omp:anthropic/claude-opus-4-7': 'xhigh',
      'omp:anthropic/claude-sonnet-4': 'high',
    });
  });

  it('keeps selected model metadata even when the selected model is no longer discovered', () => {
    const settings: Record<string, unknown> = {
      model: 'omp:old-provider/old-model',
      providerConfigs: {
        omp: {
          discoveredModels,
          modelAliases: {
            'omp:old-provider/old-model': 'Legacy model',
            'omp:missing/model': 'Missing',
          },
          preferredThinkingByModel: {
            'omp:old-provider/old-model': 'high',
            'omp:missing/model': 'low',
          },
          visibleModels: ['omp:anthropic/claude-sonnet-4'],
        },
      },
      savedProviderModel: {},
      titleGenerationModel: '',
    };

    expect(getOmpProviderSettings(settings).modelAliases).toEqual({
      'omp:old-provider/old-model': 'Legacy model',
    });
    expect(getOmpProviderSettings(settings).preferredThinkingByModel).toEqual({
      'omp:old-provider/old-model': 'high',
    });
  });

  it('preserves selected model metadata during model variant reconciliation when discovery is stale', () => {
    const settings: Record<string, unknown> = {
      model: 'omp:old-provider/old-model',
      providerConfigs: {
        omp: {
          discoveredModels,
          modelAliases: {
            'omp:old-provider/old-model': 'Legacy model',
          },
          preferredThinkingByModel: {
            'omp:old-provider/old-model': 'high',
          },
          visibleModels: ['omp:anthropic/claude-sonnet-4'],
        },
      },
      savedProviderModel: {},
      titleGenerationModel: '',
    };

    expect(ompSettingsReconciler.normalizeModelVariantSettings(settings)).toBe(false);
    expect(getOmpProviderSettings(settings).modelAliases).toEqual({
      'omp:old-provider/old-model': 'Legacy model',
    });
    expect(getOmpProviderSettings(settings).preferredThinkingByModel).toEqual({
      'omp:old-provider/old-model': 'high',
    });
  });

  it('retargets active and saved Omp selections when visible models change', () => {
    const settings: Record<string, unknown> = {
      effortLevel: 'high',
      model: 'omp:openai/gpt-5',
      providerConfigs: {
        omp: {
          discoveredModels,
          preferredThinkingByModel: {
            'omp:anthropic/claude-sonnet-4': 'high',
          },
          visibleModels: ['omp:openai/gpt-5', 'omp:anthropic/claude-sonnet-4'],
        },
      },
      savedProviderEffort: {
        omp: 'medium',
      },
      savedProviderModel: {
        omp: 'omp:openai/gpt-5',
      },
      titleGenerationModel: 'omp:openai/gpt-5',
    };

    updateOmpProviderSettings(settings, {
      visibleModels: ['omp:anthropic/claude-sonnet-4'],
    });

    expect(settings.model).toBe('omp:anthropic/claude-sonnet-4');
    expect(settings.effortLevel).toBe('high');
    expect((settings.savedProviderModel as Record<string, string>).omp).toBe('omp:anthropic/claude-sonnet-4');
    expect((settings.savedProviderEffort as Record<string, string>).omp).toBe('high');
    expect(settings.titleGenerationModel).toBe('omp:anthropic/claude-sonnet-4');
  });

  it('clears the Omp title model when all visible models are removed', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        omp: {
          discoveredModels,
          visibleModels: ['omp:openai/gpt-5'],
        },
      },
      titleGenerationModel: 'omp:openai/gpt-5',
    };

    updateOmpProviderSettings(settings, { visibleModels: [] });

    expect(settings.titleGenerationModel).toBe('');
  });

  it('clears stale discovery metadata on environment change without dropping visible model choices', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        omp: {
          discoveredModels,
          visibleModels: ['omp:anthropic/claude-sonnet-4'],
        },
      },
    };

    expect(ompSettingsReconciler.handleEnvironmentChange?.(settings)).toBe(true);

    expect(getOmpProviderSettings(settings).discoveredModels).toEqual([]);
    expect(getOmpProviderSettings(settings).visibleModels).toEqual(['omp:anthropic/claude-sonnet-4']);
  });

  it('normalizes blank Omp effort to a value supported by the selected model', () => {
    const nonReasoningSettings: Record<string, unknown> = {
      effortLevel: '',
      model: 'omp:openai/gpt-5',
      providerConfigs: {
        omp: {
          discoveredModels: [{
            encodedId: 'omp:openai/gpt-5',
            id: 'gpt-5',
            input: ['text'],
            label: 'GPT-5',
            provider: 'openai',
            reasoning: false,
            thinkingLevels: ['off'],
          }],
          visibleModels: ['omp:openai/gpt-5'],
        },
      },
    };

    expect(ompSettingsReconciler.normalizeModelVariantSettings(nonReasoningSettings)).toBe(true);
    expect(nonReasoningSettings.effortLevel).toBe('off');

  });
});
