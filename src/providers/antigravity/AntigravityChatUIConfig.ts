import type { ProviderChatUIConfig } from '@/core/providers/types';

import { isAntigravityModel } from './AntigravityMetadata';
import { getAntigravitySettings } from './settings';

export const antigravityChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(settings) {
    const config = getAntigravitySettings(settings);
    return config.visibleModels.map(id => ({ value: id, label: config.modelAliases[id] || config.discoveredModels.find(model => model.id === id)?.name || id.slice(12) }));
  },
  getDefaultModel: settings => getAntigravitySettings(settings).visibleModels[0] ?? null,
  ownsModel: isAntigravityModel,
  isAdaptiveReasoningModel: () => false,
  getReasoningOptions: () => [],
  getDefaultReasoningValue: () => 'off',
  getContextWindowSize: (model, limits) => limits?.[model] ?? 200_000,
  isDefaultModel: isAntigravityModel,
  applyModelDefaults(model, settings) {
    if (settings && typeof settings === 'object') Object.assign(settings, { model, effortLevel: 'off' });
  },
  normalizeModelVariant: model => model,
  getCustomModelIds: () => new Set(),
  getPermissionModeToggle: () => null,
  resolvePermissionMode: () => 'normal',
};
