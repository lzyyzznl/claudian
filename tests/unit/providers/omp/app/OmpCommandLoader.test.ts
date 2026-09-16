import type { ProviderCommandLoaderContext } from '@/core/providers/types';
import { OmpCommandLoader } from '@/providers/omp/app/OmpCommandLoader';
import type { OmpCommandMetadataProbe } from '@/providers/omp/execution/OmpCommandMetadataProbe';

function createContext(
  overrides: Partial<ProviderCommandLoaderContext> = {},
): ProviderCommandLoaderContext {
  // The loader only reads the vault path from the host app.
  const plugin = {
    app: { vault: { adapter: { basePath: '/vault' } } },
  } as unknown as ProviderCommandLoaderContext['plugin'];
  return {
    allowIsolatedMetadataCreation: false,
    conversation: null,
    plugin,
    ...overrides,
  };
}

/** The loader only calls `load`, so a partial probe stands in for the real one. */
function createProbe(load: jest.Mock): OmpCommandMetadataProbe {
  return { load } as unknown as OmpCommandMetadataProbe;
}

describe('OmpCommandLoader', () => {
  it('uses a ready command snapshot without starting a metadata probe', async () => {
    const metadataProbe = { load: jest.fn() };
    const loader = new OmpCommandLoader(createProbe(metadataProbe.load));

    await expect(loader.loadCommands(createContext({
      readyCommandSnapshot: [{
        content: '',
        id: 'omp:test',
        kind: 'command',
        name: 'test',
        source: 'sdk',
      }],
    }))).resolves.toMatchObject({
      items: [expect.objectContaining({ name: 'test' })],
      status: 'ready',
    });
    expect(metadataProbe.load).not.toHaveBeenCalled();
  });

  it('does not probe metadata unless isolated creation is allowed', async () => {
    const metadataProbe = { load: jest.fn() };
    const loader = new OmpCommandLoader(createProbe(metadataProbe.load));

    await expect(loader.loadCommands(createContext())).resolves.toMatchObject({
      status: 'requires-session',
    });
    expect(metadataProbe.load).not.toHaveBeenCalled();
  });

  it('loads commands through a no-session metadata probe', async () => {
    const metadataProbe = {
      load: jest.fn().mockResolvedValue([{
        content: '',
        id: 'omp:skill',
        kind: 'skill',
        name: 'skill',
        source: 'sdk',
      }]),
    };
    const loader = new OmpCommandLoader(createProbe(metadataProbe.load));

    await expect(loader.loadCommands(createContext({
      allowIsolatedMetadataCreation: true,
    }))).resolves.toMatchObject({
      items: [expect.objectContaining({ name: 'skill' })],
      status: 'ready',
    });
    expect(metadataProbe.load).toHaveBeenCalledWith('/vault', undefined);
  });
});
