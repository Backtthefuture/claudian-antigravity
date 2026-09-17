import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compressToBase64 } from 'lz-string';

import type { ProviderExecutionEvent, ProviderExecutionSession, ProviderSessionConfig } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { AntigravityExecutionBackend } from '@/providers/antigravity/AntigravityExecutionBackend';
import { updateAntigravitySettings } from '@/providers/antigravity/settings';

const live = process.env.CLAUDIAN_AGY_LIVE_FULL_ACCESS_TEST === '1' ? describe : describe.skip;

live('Antigravity explicit full access', () => {
  it('resumes a denied command, decodes Excalidraw, and reads and writes an outside fixture', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'claudian-full-access-')));
    const vault = join(root, 'vault');
    await mkdir(vault);
    const nonce = randomUUID();
    const drawing = join(vault, 'scene.excalidraw.md');
    const proof = join(root, 'decoded.json');
    const written = join(root, 'outside-write.txt');
    const script = join(root, 'decode.cjs');
    const input = process.env.CLAUDIAN_AGY_EXCALIDRAW_SOURCE
      ? await readFile(process.env.CLAUDIAN_AGY_EXCALIDRAW_SOURCE, 'utf8')
      : '```compressed-json\n' + compressToBase64(JSON.stringify({ elements: [
        { type: 'text', text: '欢迎来到AgentWork' }, { type: 'arrow' }, { type: 'arrow' },
      ] })) + '\n```';
    await writeFile(drawing, input);
    await writeFile(script, `const fs = require('node:fs');
const lz = require(${JSON.stringify(require.resolve('lz-string'))});
const input = fs.readFileSync(process.argv[2], 'utf8');
const payload = input.match(/\x60\x60\x60compressed-json\\s*\\n([\\s\\S]*?)\x60\x60\x60/)[1].replace(/\\s/g, '');
const elements = JSON.parse(lz.decompressFromBase64(payload)).elements.filter(e => !e.isDeleted);
const result = { nonce: ${JSON.stringify(nonce)}, texts: elements.filter(e => e.type === 'text').map(e => e.text), arrows: elements.filter(e => e.type === 'arrow').length };
fs.writeFileSync(process.argv[3], JSON.stringify(result));
process.stdout.write(JSON.stringify(result));
`);
    const host = {
      settings: {}, getResolvedProviderCliPath: async () => process.env.CLAUDIAN_AGY_TEST_CLI,
      getActiveEnvironmentVariables: () => '',
    } as unknown as ProviderHost;
    const backend = new AntigravityExecutionBackend(host);
    const sessions: ProviderExecutionSession[] = [];
    const create = (id?: string) => {
      const session = backend.createSession({
        vaultWorkingDirectory: vault, lifecycle: 'persistent', nativePersistence: 'enabled',
        interactionPort: {} as ProviderSessionConfig['interactionPort'],
        resumeSeed: id ? { providerSessionId: id } : undefined,
      });
      sessions.push(session);
      return session;
    };
    const evidence: object[] = [];
    const run = async (session: ProviderExecutionSession, text: string) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 90_000);
      const events: ProviderExecutionEvent[] = [];
      try {
        for await (const event of session.execute({
          input: [{ type: 'text', text }], configuration: { model: 'antigravity:gemini-3.8-flash-high', systemInstructions: { kind: 'provider-default' } },
          toolPolicy: { kind: 'provider-default' }, signal: controller.signal,
        }).events) events.push(event);
        evidence.push({ terminal: events.at(-1), tools: events.filter(e => e.type === 'tool_started' || e.type === 'tool_completed'), response: events.flatMap(e => e.type === 'text_delta' ? [e.text] : []).join('') });
        return events;
      } finally { clearTimeout(timer); }
    };
    const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
    try {
      const initial = create();
      const denied = await run(initial, 'This is an isolated permission test. Use run_command to execute exactly: printf CLAUDIAN_PERMISSION_TEST. Do not run any other commands or access files. Stop if denied.');
      expect(denied.at(-1)).toMatchObject({ type: 'execution_error' });
      const id = initial.getSnapshot().providerSessionId;
      expect(id).toBeTruthy();
      await initial.dispose();
      updateAntigravitySettings(host.settings, { autoApproveAllTools: true });
      const resumed = create(id);
      const command = [process.execPath, script, drawing, proof].map(quote).join(' ');
      const decoded = await run(resumed, `Full access has now been explicitly enabled. Use run_command to execute this exact, prepared Excalidraw decoder: ${command}. It reads only the supplied drawing and library, writes only the supplied JSON proof, and prints its result. Do not inspect other files or change the drawing. Return the output.`);
      expect(decoded.at(-1)).toMatchObject({ type: 'turn_completed' });
      expect(decoded).toContainEqual(expect.objectContaining({ type: 'tool_started', name: 'run_command' }));
      expect(JSON.parse(await readFile(proof, 'utf8'))).toMatchObject({ nonce, texts: expect.arrayContaining(['欢迎来到AgentWork']), arrows: 2 });
      const files = await run(resumed, `Use view_file to read exactly ${proof}, then use write_to_file to create exactly ${written} containing the nonce from that JSON. Both are authorized isolated test files outside the vault. Do not run commands or touch any other files.`);
      expect(files.at(-1)).toMatchObject({ type: 'turn_completed' });
      expect(files).toContainEqual(expect.objectContaining({ type: 'tool_started', name: 'view_file' }));
      expect(files).toContainEqual(expect.objectContaining({ type: 'tool_started', name: 'write_to_file' }));
      expect((await readFile(written, 'utf8')).trim()).toBe(nonce);
      expect(await readFile(drawing, 'utf8')).toBe(input);
      expect(resumed.getSnapshot().providerSessionId).toBe(id);
    } finally {
      if (process.env.CLAUDIAN_AGY_FULL_ACCESS_EVIDENCE) await writeFile(process.env.CLAUDIAN_AGY_FULL_ACCESS_EVIDENCE, JSON.stringify(evidence, null, 2));
      await Promise.all(sessions.map(session => session.dispose()));
      await rm(root, { recursive: true, force: true });
    }
  }, 300_000);
});
