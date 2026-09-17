import type { SlashCommand } from '@/core/types';

import { record, string } from './AntigravityProcess';

export interface AntigravityModel { id: string; name: string; }

export function isAntigravityModel(value: unknown): value is string {
  return typeof value === 'string' && /^antigravity:[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(value);
}

export function parseAntigravityModels(text: string): AntigravityModel[] {
  const models = new Map<string, AntigravityModel>();
  for (const line of text.split(/\r?\n/)) {
    const [slug, ...name] = line.split('\t');
    const id = `antigravity:${slug.trim()}`;
    if (!name.length || !isAntigravityModel(id)) continue;
    models.set(id, { id, name: name.join(' ').trim() || slug });
  }
  return [...models.values()];
}

export function parseAntigravitySkills(text: string): SlashCommand[] {
  const result = record(JSON.parse(text));
  if (result.status !== 'SUCCESS') throw new Error(string(result.error) || 'Antigravity Skill discovery failed');
  const skills = record(record(result.command).data).skills;
  if (!Array.isArray(skills)) throw new Error('Antigravity did not return a structured Skill catalog');
  const commands = new Map<string, SlashCommand>();
  for (const raw of skills) {
    const skill = record(raw);
    const name = string(skill.name);
    if (!/^[\p{L}\p{N}_][\p{L}\p{N}_.:-]*$/u.test(name) || skill.user_invocable === false) continue;
    commands.set(name, {
      id: `antigravity:skill:${name}`, name, description: string(skill.description),
      content: '', kind: 'skill', source: 'sdk', userInvocable: true,
    });
  }
  return [...commands.values()];
}
