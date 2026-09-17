import { getProviderConfig, setProviderConfig } from '@/core/providers/providerConfig';
import { normalizeHostnameStringMap } from '@/core/providers/settings/HostnameStringMap';

import { type AntigravityModel, isAntigravityModel } from './AntigravityMetadata';
import { record, string } from './AntigravityProcess';

export interface AntigravitySettings {
  enabled: boolean;
  cliPath: string;
  environmentHash: string;
  environmentVariables: string;
  cliPathsByHost: Record<string, string>;
  visibleModels: string[];
  discoveredModels: AntigravityModel[];
  modelAliases: Record<string, string>;
}

export function getAntigravitySettings(settings: Record<string, unknown>): AntigravitySettings {
  const config = getProviderConfig(settings, 'antigravity');
  return {
    enabled: config.enabled === true,
    cliPath: string(config.cliPath),
    environmentHash: string(config.environmentHash),
    environmentVariables: string(config.environmentVariables),
    cliPathsByHost: normalizeHostnameStringMap(config.cliPathsByHost),
    visibleModels: Array.isArray(config.visibleModels) ? [...new Set(config.visibleModels.filter(isAntigravityModel))] : [],
    discoveredModels: Array.isArray(config.discoveredModels) ? config.discoveredModels.flatMap(value => {
      const model = record(value);
      return isAntigravityModel(model.id) && string(model.name) ? [{ id: model.id, name: string(model.name) }] : [];
    }) : [],
    modelAliases: Object.fromEntries(Object.entries(record(config.modelAliases)).flatMap(([id, alias]) =>
      isAntigravityModel(id) && string(alias).trim() ? [[id, string(alias).trim()]] : [])),
  };
}

export function updateAntigravitySettings(settings: Record<string, unknown>, update: Partial<AntigravitySettings>): void {
  const config = getProviderConfig(settings, 'antigravity');
  const input = { providerConfigs: { antigravity: { ...config, ...getAntigravitySettings(settings), ...update } } };
  setProviderConfig(settings, 'antigravity', { ...config, ...getAntigravitySettings(input) });
}
