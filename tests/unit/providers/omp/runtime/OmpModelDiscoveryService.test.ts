import type { ProviderHost } from '@/core/providers/ProviderHost';

const mockTransportRequest = jest.fn();
const mockTransportSend = jest.fn();
const mockTransportStart = jest.fn();
const mockTransportDispose = jest.fn();
const mockTransportOnEvent = jest.fn();
const mockRemoveEventListener = jest.fn();
const mockProcessStart = jest.fn();
const mockProcessShutdown = jest.fn().mockResolvedValue(undefined);
const mockProcessOnClose = jest.fn();
const mockGetStderrSnapshot = jest.fn(() => '');
let mockEventHandler: ((event: Record<string, unknown>) => void) | null = null;

jest.mock('@/core/rpc/JsonlRpcTransport', () => ({
  JsonlRpcTransport: jest.fn().mockImplementation(() => ({
    dispose: mockTransportDispose,
    onEvent: mockTransportOnEvent,
    request: mockTransportRequest,
    send: mockTransportSend,
    start: mockTransportStart,
  })),
}));

jest.mock('@/providers/omp/runtime/OmpSubprocess', () => ({
  OmpSubprocess: jest.fn().mockImplementation(() => ({
    getStderrSnapshot: mockGetStderrSnapshot,
    onClose: mockProcessOnClose,
    shutdown: mockProcessShutdown,
    start: mockProcessStart,
    stdin: {},
    stdout: {},
  })),
}));

import { OmpModelDiscoveryService } from '@/providers/omp/runtime/OmpModelDiscoveryService';

function createPlugin(overrides: { enabled?: boolean } = {}): ProviderHost {
  return {
    app: {
      vault: {
        adapter: {
          basePath: '/tmp/vault',
        },
      },
    },
    getResolvedProviderCliPath: jest.fn(() => '/usr/local/bin/omp'),
    settings: {
      providerConfigs: {
        omp: {
          enabled: overrides.enabled ?? true,
        },
      },
    },
  } as unknown as ProviderHost;
}

describe('OmpModelDiscoveryService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEventHandler = null;
    mockGetStderrSnapshot.mockReturnValue('');
    mockTransportOnEvent.mockImplementation((handler: (event: Record<string, unknown>) => void) => {
      mockEventHandler = handler;
      return mockRemoveEventListener;
    });
  });

  it('does not launch OMP when the provider is disabled', async () => {
    const plugin = createPlugin({ enabled: false });

    const result = await new OmpModelDiscoveryService(plugin).discoverModels();

    expect(result).toEqual({ kind: 'skipped', reason: 'provider-disabled' });
    expect(plugin.getResolvedProviderCliPath).not.toHaveBeenCalled();
    expect(mockProcessStart).not.toHaveBeenCalled();
    expect(mockTransportStart).not.toHaveBeenCalled();
    expect(mockTransportRequest).not.toHaveBeenCalled();
  });

  it('discovers and normalizes OMP models through a short-lived no-session runtime', async () => {
    mockTransportRequest.mockResolvedValue({
      models: [{
        contextWindow: 200000,
        id: 'gpt-5',
        input: ['text', 'image'],
        maxTokens: 8192,
        name: 'GPT-5',
        provider: 'openai',
        reasoning: true,
        thinking: {
          efforts: ['low', 'high', 'max'],
          mode: 'effort',
        },
      }],
    });

    const result = await new OmpModelDiscoveryService(createPlugin()).discoverModels();

    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') {
      throw new Error('Expected completed OMP model discovery');
    }
    expect(result.diagnostics).toBeUndefined();
    expect(result.models).toEqual([{
      contextWindow: 200000,
      encodedId: 'omp:openai/gpt-5',
      id: 'gpt-5',
      input: ['text', 'image'],
      label: 'GPT-5',
      maxTokens: 8192,
      provider: 'openai',
      reasoning: true,
      thinkingLevels: ['low', 'high', 'max'],
    }]);
    expect(mockProcessStart).toHaveBeenCalled();
    expect(mockTransportStart).toHaveBeenCalled();
    expect(mockTransportRequest).toHaveBeenCalledWith('get_available_models', {}, 20_000);
    expect(mockRemoveEventListener).toHaveBeenCalled();
    expect(mockTransportDispose).toHaveBeenCalled();
    expect(mockProcessShutdown).toHaveBeenCalled();
  });

  it('cancels extension UI requests during discovery', async () => {
    mockTransportRequest.mockImplementation(async () => {
      mockEventHandler?.({
        id: 'ui-1',
        type: 'extension_ui_request',
      });
      return { models: [] };
    });

    await new OmpModelDiscoveryService(createPlugin()).discoverModels();

    expect(mockTransportSend).toHaveBeenCalledWith({
      cancelled: true,
      id: 'ui-1',
      type: 'extension_ui_response',
    });
  });

  it('returns diagnostics and still shuts down when discovery fails', async () => {
    mockTransportRequest.mockRejectedValue(new Error('not logged in'));
    mockGetStderrSnapshot.mockReturnValue('OMP stderr');

    const result = await new OmpModelDiscoveryService(createPlugin()).discoverModels();

    expect(result).toEqual({
      diagnostics: 'not logged in\n\nOMP stderr',
      kind: 'completed',
      models: [],
    });
    expect(mockTransportDispose).toHaveBeenCalled();
    expect(mockProcessShutdown).toHaveBeenCalled();
  });
});
