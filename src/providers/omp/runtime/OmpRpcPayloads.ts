import { decodeOmpModelId } from '@/providers/omp/models';

export interface OmpSetModelPayload extends Record<string, unknown> {
  modelId: string;
  provider: string;
}

export function buildOmpSetModelPayload(model: string): OmpSetModelPayload | null {
  const decoded = decodeOmpModelId(model);
  if (!decoded) {
    return null;
  }

  return {
    modelId: decoded.modelId,
    provider: decoded.provider,
  };
}
