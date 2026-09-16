import { OMP_PROVIDER_CAPABILITIES } from '@/providers/omp/capabilities';

describe('OMP_PROVIDER_CAPABILITIES', () => {
  it('exposes the Omp capability contract', () => {
    expect(OMP_PROVIDER_CAPABILITIES).toEqual({
      providerId: 'omp',
      commandDiscoveryDeadline: 'provider-owned',
      supportsNativeHistory: true,
      supportsRewind: false,
      supportsFork: true,
      supportsProviderCommands: true,
      supportsImageAttachments: true,
      supportsInstructionMode: true,
      supportsTurnSteer: true,
      reasoningControl: 'effort',
    });
  });
});
