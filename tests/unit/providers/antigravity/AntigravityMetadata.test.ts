import { antigravityChatUIConfig } from '@/providers/antigravity/AntigravityChatUIConfig';
import { parseAntigravityModels, parseAntigravitySkills } from '@/providers/antigravity/AntigravityMetadata';
import { getAntigravitySettings, updateAntigravitySettings } from '@/providers/antigravity/settings';

it('discovers native model IDs but only exposes explicitly selected models', () => {
  const models = parseAntigravityModels('Fetching available models...\ngemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n');
  expect(models).toEqual([
    { id: 'antigravity:gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)' },
    { id: 'antigravity:claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
  ]);
  const settings = {};
  updateAntigravitySettings(settings, { discoveredModels: models });
  expect(antigravityChatUIConfig.getModelOptions(settings)).toEqual([]);
  updateAntigravitySettings(settings, { visibleModels: [models[1].id], modelAliases: { [models[1].id]: 'My Sonnet' } });
  expect(antigravityChatUIConfig.getModelOptions(settings)).toEqual([{ value: models[1].id, label: 'My Sonnet' }]);
});

it('uses native Skill metadata including symlink-backed entries without expanding their contents', () => {
  const skills = parseAntigravitySkills(JSON.stringify({ status: 'SUCCESS', command: { name: 'skills', data: { skills: [
    { name: 'laoming-module-segmentation', description: 'Block segmentation', path: '/home/user/.gemini/antigravity-cli/skills/laoming-module-segmentation/SKILL.md', model_invocable: true },
    { name: '../bad', description: 'invalid' },
  ] } } }));
  expect(skills).toEqual([{ id: 'antigravity:skill:laoming-module-segmentation', name: 'laoming-module-segmentation', description: 'Block segmentation', content: '', kind: 'skill', source: 'sdk', userInvocable: true }]);
  expect(() => parseAntigravitySkills('{"status":"ERROR","error":"authentication required"}')).toThrow('authentication required');
});

it('normalizes malformed settings and preserves unknown provider fields on updates', () => {
  const settings = { providerConfigs: { antigravity: { enabled: 'yes', visibleModels: [42, 'antigravity:a'], modelAliases: null, future: 'keep' } } };
  expect(getAntigravitySettings(settings).enabled).toBe(false);
  updateAntigravitySettings(settings, { enabled: true });
  expect(settings.providerConfigs.antigravity.future).toBe('keep');
  expect(getAntigravitySettings(settings).visibleModels).toEqual(['antigravity:a']);
});
