import { buildOmpSetModelPayload } from '@/providers/omp/runtime/OmpRpcPayloads';

describe('OMP RPC payload builders', () => {
  it('uses OMP RPC modelId field for set_model payloads', () => {
    expect(buildOmpSetModelPayload('omp:openai-codex/gpt-5.2')).toEqual({
      modelId: 'gpt-5.2',
      provider: 'openai-codex',
    });
  });

  it('rejects invalid OMP model ids', () => {
    expect(buildOmpSetModelPayload('openai-codex/gpt-5.2')).toBeNull();
    expect(buildOmpSetModelPayload('omp:openai-codex')).toBeNull();
  });
});
