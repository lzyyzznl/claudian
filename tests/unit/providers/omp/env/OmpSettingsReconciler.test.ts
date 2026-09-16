import '@/providers';

import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { isVersionedRuntimeInputFingerprint } from '@/core/providers/settings/RuntimeInputFingerprint';
import type { Conversation } from '@/core/types';
import { ompSettingsReconciler } from '@/providers/omp/env/OmpSettingsReconciler';
import { getOmpProviderSettings, updateOmpProviderSettings } from '@/providers/omp/settings';

describe('ompSettingsReconciler', () => {
  it('invalidates Omp conversations when Omp session/config environment changes', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        omp: {
          enabled: true,
          environmentHash: 'OMP_PROFILE=old',
          environmentVariables: 'OMP_PROFILE=new\nOMP_AUTH_BROKER_TOKEN=secret',
        },
      },
    };
    const ompConversation = {
      id: 'omp-conversation',
      messages: [],
      providerId: 'omp',
      providerState: {
        futureResumeCursor: { token: 'keep-me' },
        leafEntryId: 'assistant-1',
        sessionFile: '/old/session.jsonl',
      },
      sessionId: 'session-1',
    } as unknown as Conversation;
    const claudeConversation = {
      id: 'claude-conversation',
      messages: [],
      providerId: 'claude',
      providerState: { providerSessionId: 'claude-session' },
      sessionId: 'claude-session',
    } as unknown as Conversation;

    const result = ompSettingsReconciler.reconcileModelWithEnvironment(
      settings,
      [ompConversation, claudeConversation],
    );

    expect(result.changed).toBe(true);
    expect(result.invalidatedConversations).toEqual([ompConversation]);
    expect(ompConversation.sessionId).toBeNull();
    expect(ompConversation.providerState).toEqual({
      futureResumeCursor: { token: 'keep-me' },
      previousSessions: [{
        leafEntryId: 'assistant-1',
        sessionFile: '/old/session.jsonl',
        sessionId: 'session-1',
      }],
    });
    expect(claudeConversation.sessionId).toBe('claude-session');
    const fingerprint = getOmpProviderSettings(settings).environmentHash;
    expect(isVersionedRuntimeInputFingerprint(fingerprint)).toBe(true);
    expect(fingerprint).not.toContain('new');
    expect(fingerprint).not.toContain('secret');
  });

  it('invalidates Omp conversations when a legacy pi-era environment key changes', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        omp: {
          enabled: true,
          environmentVariables: 'PI_CODING_AGENT_SESSION_DIR=/old',
        },
      },
    };

    expect(ompSettingsReconciler.reconcileModelWithEnvironment(settings, []).changed).toBe(true);
    expect(isVersionedRuntimeInputFingerprint(
      getOmpProviderSettings(settings).environmentHash,
    )).toBe(true);
    expect(ompSettingsReconciler.reconcileModelWithEnvironment(settings, []).changed).toBe(false);

    updateOmpProviderSettings(settings, {
      environmentVariables: 'PI_CODING_AGENT_SESSION_DIR=/new',
    });

    expect(ompSettingsReconciler.reconcileModelWithEnvironment(settings, []).changed).toBe(true);
  });

  it('migrates a matching legacy environment fingerprint before coordinator invalidation', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        omp: {
          enabled: true,
          environmentHash: 'PI_OFFLINE=1',
          environmentVariables: 'PI_OFFLINE=1',
        },
      },
    };
    const conversation = {
      id: 'omp-conversation',
      messages: [],
      providerId: 'omp',
      providerState: {
        leafEntryId: 'assistant-1',
        sessionFile: '/sessions/current.jsonl',
        sessionId: 'current-session',
      },
      sessionId: 'current-session',
    } as unknown as Conversation;

    expect(ompSettingsReconciler.normalizeModelVariantSettings(settings)).toBe(true);
    const result = ProviderSettingsCoordinator.reconcileProviders(
      settings,
      [conversation],
      ['omp'],
    );

    expect(result).toMatchObject({
      changed: false,
      environmentChangedProviderIds: [],
      invalidatedConversations: [],
      sessionInvalidationProviderIds: [],
    });
    expect(conversation.sessionId).toBe('current-session');
    expect(conversation.providerState).toMatchObject({
      leafEntryId: 'assistant-1',
      sessionFile: '/sessions/current.jsonl',
      sessionId: 'current-session',
    });
    expect(isVersionedRuntimeInputFingerprint(
      getOmpProviderSettings(settings).environmentHash,
    )).toBe(true);
  });

  it('converts pending forks into replayable previous sessions idempotently', () => {
    const conversation = {
      id: 'omp-pending-fork',
      messages: [],
      providerId: 'omp',
      providerState: {
        forkSource: {
          resumeAt: 'assistant-1',
          sessionId: 'source-session',
        },
        forkSourceSessionFile: '/sessions/source.jsonl',
        futureResumeCursor: { token: 'keep-me' },
      },
      sessionId: null,
    } as unknown as Conversation;

    expect(ompSettingsReconciler.invalidateConversationSessions([conversation])).toEqual([
      conversation,
    ]);
    expect(conversation.providerState).toEqual({
      futureResumeCursor: { token: 'keep-me' },
      previousSessions: [{
        leafEntryId: 'assistant-1',
        sessionFile: '/sessions/source.jsonl',
        sessionId: 'source-session',
      }],
    });
    expect(ompSettingsReconciler.invalidateConversationSessions([conversation])).toEqual([]);
  });

  it('normalizes malformed Omp model selections instead of preserving invalid ids', () => {
    const settings: Record<string, unknown> = {
      model: 'omp:missing-slash',
      providerConfigs: {
        omp: {},
      },
      savedProviderModel: {
        omp: 'omp:also-invalid',
      },
      titleGenerationModel: 'omp:invalid-title',
    };

    expect(ompSettingsReconciler.normalizeModelVariantSettings(settings)).toBe(true);
    expect(settings.model).toBe('');
    expect(settings.titleGenerationModel).toBe('');
    expect(settings.savedProviderModel).toEqual({});
  });
});
