import * as fs from 'fs';
import * as path from 'path';

import { OmpCliResolver } from '@/providers/omp/runtime/OmpCliResolver';

jest.mock('fs');
jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'),
  getHostnameKey: () => 'current-host',
}));

const mockedStat = fs.statSync as jest.Mock;

describe('OmpCliResolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (fs.existsSync as jest.Mock).mockReturnValue(false);
  });

  it('resolves the current host path before the legacy omp CLI path', () => {
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === '/current/omp') {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });

    const resolver = new OmpCliResolver();

    expect(resolver.resolve({
      'current-host': '/current/omp',
      'other-host': '/other/omp',
    }, '/legacy/omp')).toBe('/current/omp');
  });

  it('falls back to cliPath and returns null for invalid paths', () => {
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === '/legacy/omp') {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });

    const resolver = new OmpCliResolver();
    expect(resolver.resolve({ 'other-host': '/other/omp' }, '/legacy/omp')).toBe('/legacy/omp');

    mockedStat.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    resolver.reset();
    expect(resolver.resolve({ 'other-host': '/other/omp' }, '/legacy/omp')).toBeNull();
  });

  it('falls back to PATH lookup when no omp CLI path is configured', () => {
    const pathDir = '/custom/bin';
    const pathBinary = path.join(pathDir, 'omp');
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === pathBinary) {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });

    const resolver = new OmpCliResolver();

    expect(resolver.resolve({}, '', `PATH=${pathDir}`)).toBe(pathBinary);
  });

  it('invalidates cached resolutions when provider environment changes', () => {
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === '/current/omp') {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });

    const resolver = new OmpCliResolver();
    const firstSettings = {
      providerConfigs: {
        omp: {
          cliPathsByHost: {
            'current-host': '/current/omp',
          },
          environmentVariables: 'OMP_PROFILE=runtime-a',
        },
      },
    };
    const secondSettings = {
      providerConfigs: {
        omp: {
          cliPathsByHost: {
            'current-host': '/current/omp',
          },
          environmentVariables: 'OMP_PROFILE=runtime-b',
        },
      },
    };

    expect(resolver.resolveFromSettings(firstSettings)).toBe('/current/omp');
    expect(resolver.resolveFromSettings(firstSettings)).toBe('/current/omp');
    expect(mockedStat).toHaveBeenCalledTimes(1);

    expect(resolver.resolveFromSettings(secondSettings)).toBe('/current/omp');
    expect(mockedStat).toHaveBeenCalledTimes(2);
  });

  it('caches null settings resolutions until reset', () => {
    mockedStat.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const resolver = new OmpCliResolver();
    const settings = { providerConfigs: { omp: {} } };

    expect(resolver.resolveFromSettings(settings)).toBeNull();
    const firstCallCount = mockedStat.mock.calls.length;
    expect(firstCallCount).toBeGreaterThan(0);
    expect(resolver.resolveFromSettings(settings)).toBeNull();
    expect(mockedStat).toHaveBeenCalledTimes(firstCallCount);

    resolver.reset();
    expect(resolver.resolveFromSettings(settings)).toBeNull();
    expect(mockedStat.mock.calls.length).toBeGreaterThan(firstCallCount);
  });
});
