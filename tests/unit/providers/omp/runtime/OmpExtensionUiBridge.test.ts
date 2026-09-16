import type { JsonlRpcTransport } from '@/core/rpc/JsonlRpcTransport';
import { OmpExtensionUiBridge, type OmpExtensionUiRenderer } from '@/providers/omp/runtime/OmpExtensionUiBridge';

function createBridge(
  renderer: Partial<OmpExtensionUiRenderer>,
  admitDialog: () => boolean = () => true,
) {
  const transport = {
    send: jest.fn(),
  } as unknown as JsonlRpcTransport;
  const bridge = new OmpExtensionUiBridge(
    transport,
    renderer as OmpExtensionUiRenderer,
    undefined,
    admitDialog,
  );
  return { bridge, transport };
}

describe('OmpExtensionUiBridge', () => {
  it('sends dialog responses through the transport', async () => {
    const renderer = {
      select: jest.fn().mockResolvedValue({ value: 'choice-a' }),
    };
    const { bridge, transport } = createBridge(renderer);

    expect(bridge.handleRequest({ id: 'ui-1', method: 'select', type: 'extension_ui_request' })).toBe(true);
    await Promise.resolve();

    expect(renderer.select).toHaveBeenCalled();
    expect(transport.send).toHaveBeenCalledWith({
      id: 'ui-1',
      type: 'extension_ui_response',
      value: 'choice-a',
    });
  });

  it('cancels dialog requests when no renderer is available', () => {
    const transport = {
      send: jest.fn(),
    } as unknown as JsonlRpcTransport;
    const bridge = new OmpExtensionUiBridge(transport, null);

    bridge.handleRequest({ id: 'ui-1', method: 'confirm', type: 'extension_ui_request' });

    expect(transport.send).toHaveBeenCalledWith({
      cancelled: true,
      id: 'ui-1',
      type: 'extension_ui_response',
    });
  });

  it('cancels a denied dialog before invoking the renderer', () => {
    const renderer = {
      input: jest.fn().mockResolvedValue({ value: 'must-not-be-sent' }),
    };
    const { bridge, transport } = createBridge(renderer, () => false);

    bridge.handleRequest({ id: 'ui-1', method: 'input', type: 'extension_ui_request' });

    expect(renderer.input).not.toHaveBeenCalled();
    expect(transport.send).toHaveBeenCalledWith({
      cancelled: true,
      id: 'ui-1',
      type: 'extension_ui_response',
    });
  });

  it('handles notify without sending a response', () => {
    const renderer = {
      notify: jest.fn(),
    };
    const { bridge, transport } = createBridge(renderer);

    bridge.handleRequest({ message: 'hello', method: 'notify', type: 'extension_ui_request' });

    expect(renderer.notify).toHaveBeenCalledWith({
      message: 'hello',
      method: 'notify',
      type: 'extension_ui_request',
    });
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('answers an unknown extension UI method with a cancellation', () => {
    const { bridge, transport } = createBridge({});

    expect(bridge.handleRequest({
      id: 'ui-unknown',
      method: 'open_url',
      type: 'extension_ui_request',
      url: 'https://example.test/oauth',
    })).toBe(true);

    expect(transport.send).toHaveBeenCalledWith({
      cancelled: true,
      id: 'ui-unknown',
      type: 'extension_ui_response',
    });
  });

  it('abandons the pending dialog named by an OMP cancel request', async () => {
    let observedSignal: AbortSignal | null = null;
    const renderer = {
      input: jest.fn((_request: unknown, signal: AbortSignal) => {
        observedSignal = signal;
        return new Promise<{ cancelled?: boolean }>(() => {});
      }),
    };
    const { bridge, transport } = createBridge(renderer);

    bridge.handleRequest({ id: 'ui-1', method: 'input', type: 'extension_ui_request' });
    await Promise.resolve();
    bridge.handleRequest({
      id: 'ui-2',
      method: 'cancel',
      targetId: 'ui-1',
      type: 'extension_ui_request',
    });

    expect((observedSignal as AbortSignal | null)?.aborted).toBe(true);
    expect(transport.send).toHaveBeenCalledWith({
      cancelled: true,
      id: 'ui-1',
      type: 'extension_ui_response',
    });
    expect(transport.send).toHaveBeenCalledWith({
      cancelled: true,
      id: 'ui-2',
      type: 'extension_ui_response',
    });

    bridge.cleanup();
    expect(transport.send).toHaveBeenCalledTimes(2);
  });

  it('cancels pending dialogs on cleanup', () => {
    const renderer = {
      input: jest.fn((_request: unknown, signal: AbortSignal) => new Promise<{ cancelled?: boolean }>((resolve) => {
        signal.addEventListener('abort', () => resolve({ cancelled: true }));
      })),
    };
    const { bridge, transport } = createBridge(renderer);

    bridge.handleRequest({ id: 'ui-1', method: 'input', type: 'extension_ui_request' });
    bridge.cleanup();

    expect(transport.send).toHaveBeenCalledWith({
      cancelled: true,
      id: 'ui-1',
      type: 'extension_ui_response',
    });
  });

  it('does not send duplicate cancellation responses when cleanup aborts a rejecting renderer', async () => {
    const renderer = {
      input: jest.fn((_request: unknown, signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      })),
    };
    const { bridge, transport } = createBridge(renderer);

    bridge.handleRequest({ id: 'ui-1', method: 'input', type: 'extension_ui_request' });
    bridge.cleanup();
    await Promise.resolve();

    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(transport.send).toHaveBeenCalledWith({
      cancelled: true,
      id: 'ui-1',
      type: 'extension_ui_response',
    });
  });
});
