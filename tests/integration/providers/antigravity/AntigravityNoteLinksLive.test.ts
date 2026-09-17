import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProviderExecutionEvent, ProviderSessionConfig } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { AntigravityExecutionBackend } from '@/providers/antigravity/AntigravityExecutionBackend';

const live = process.env.CLAUDIAN_AGY_LIVE_LINK_TEST === '1' ? describe : describe.skip;

live('Antigravity native note linking', () => {
  it('finds related notes and writes valid wikilinks without command permissions', async () => {
    // macOS /var is a symlink; agy checks writes against the canonical path.
    const root = await realpath(await mkdtemp(join(tmpdir(), 'claudian-link-test-')));
    const source = '# Voice notes\n\nTalking to an AI while walking helps me develop ideas.\n';
    const related = '# Thinking together\n\nVoice conversations help develop unfinished ideas while walking.\n';
    const unrelated = '# Kitchen\n\nA recipe for bread.\n';
    await writeFile(join(root, 'Voice.md'), source);
    await writeFile(join(root, 'Thinking.md'), related);
    await writeFile(join(root, 'Kitchen.md'), unrelated);
    const host = {
      settings: {}, getResolvedProviderCliPath: async () => process.env.CLAUDIAN_AGY_TEST_CLI,
      getActiveEnvironmentVariables: () => '',
    } as unknown as ProviderHost;
    const session = new AntigravityExecutionBackend(host).createSession({
      vaultWorkingDirectory: root, lifecycle: 'persistent', nativePersistence: 'enabled',
      interactionPort: {} as ProviderSessionConfig['interactionPort'],
    });
    const events: ProviderExecutionEvent[] = [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      for await (const event of session.execute({
        input: [{ type: 'text', text: '请为 Voice.md 在当前知识库里找到内容相关的笔记，并在 Voice.md 文末加上对应的 Obsidian 双链和今天的日期。保留原文，不修改其他笔记。只处理这个临时测试知识库。' }],
        configuration: { model: 'antigravity:gemini-3.8-flash-high', systemInstructions: { kind: 'provider-default' } },
        context: { linkedContent: { path: join(root, 'Voice.md') } },
        toolPolicy: { kind: 'provider-default' }, signal: controller.signal,
      }).events) events.push(event);
      if (process.env.CLAUDIAN_AGY_LINK_EVIDENCE) {
        await writeFile(process.env.CLAUDIAN_AGY_LINK_EVIDENCE, JSON.stringify({
          terminal: events.at(-1),
          tools: events.filter(e => e.type === 'tool_started' || e.type === 'tool_completed'),
          notices: events.filter(e => e.type === 'notice'),
          response: events.flatMap(e => e.type === 'text_delta' ? [e.text] : []).join(''),
          note: await readFile(join(root, 'Voice.md'), 'utf8'),
        }, null, 2));
      }
      expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
      expect(events).not.toContainEqual(expect.objectContaining({ type: 'tool_started', name: 'run_command' }));
      expect(events.some(e => e.type === 'tool_started' && ['list_dir', 'find_by_name', 'grep_search'].includes(e.name))).toBe(true);
      const result = await readFile(join(root, 'Voice.md'), 'utf8');
      expect(result).toContain(source.trim());
      expect(result).toMatch(/\[\[Thinking(?:\.md)?(?:\|[^\]]+)?\]\]/);
      expect(result).not.toMatch(/\[\[Kitchen/);
      expect(await readFile(join(root, 'Thinking.md'), 'utf8')).toBe(related);
      expect(await readFile(join(root, 'Kitchen.md'), 'utf8')).toBe(unrelated);
    } finally {
      clearTimeout(timer);
      await session.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 140_000);
});
