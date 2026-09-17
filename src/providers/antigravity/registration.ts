import { NOOP_TASK_RESULT_INTERPRETER } from '@/core/providers/NoopTaskResultInterpreter';
import { getProviderConfig } from '@/core/providers/providerConfig';
import { hasStoredConfigNormalization } from '@/core/providers/settings/storedSettings';
import type { ProviderModule } from '@/core/providers/types';

import { antigravityChatUIConfig } from './AntigravityChatUIConfig';
import { AntigravityExecutionBackend } from './AntigravityExecutionBackend';
import { antigravityHistory } from './AntigravityHistory';
import { antigravityWorkspace } from './AntigravityWorkspace';
import { getAntigravitySettings, updateAntigravitySettings } from './settings';

export const antigravityProviderRegistration: ProviderModule = {
  id: 'antigravity', displayName: 'Antigravity', blankTabOrder: 12,
  capabilities: {
    providerId: 'antigravity', supportsNativeHistory: false, supportsRewind: false, supportsFork: false,
    supportsProviderCommands: true, commandDiscoveryDeadline: 'provider-owned', supportsImageAttachments: false,
    supportsInstructionMode: false, supportsTurnSteer: false, reasoningControl: 'none',
  },
  chatUIConfig: antigravityChatUIConfig,
  createExecutionBackend: host => new AntigravityExecutionBackend(host),
  environmentKeyPatterns: [/^AGY_/i, /^GEMINI_/i],
  historyService: antigravityHistory,
  isEnabled: settings => getAntigravitySettings(settings).enabled,
  setEnabled: (settings, enabled) => updateAntigravitySettings(settings, { enabled }),
  settingsReconciler: {
    environmentSessionPolicy: 'reload',
    invalidateConversationSessions: () => [],
    reconcileModelWithEnvironment: () => ({ changed: false, invalidatedConversations: [] }),
    normalizeModelVariantSettings: () => false,
  },
  settingsStorage: {
    hostScopedFields: ['cliPathsByHost'],
    normalizeStored(target, stored) {
      updateAntigravitySettings(target, getAntigravitySettings(stored));
      return hasStoredConfigNormalization(getProviderConfig(stored, 'antigravity'), getProviderConfig(target, 'antigravity'));
    },
  },
  taskResultInterpreter: NOOP_TASK_RESULT_INTERPRETER,
  workspace: antigravityWorkspace,
};
