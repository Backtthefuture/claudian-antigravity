import { createInterface } from 'node:readline';

import { ManagedStdioProcess } from '@/core/process/ManagedStdioProcess';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { getEnhancedPath, parseEnvironmentVariables } from '@/utils/env';

export async function createAntigravityProcess(host: ProviderHost, cwd: string, args: string[]): Promise<ManagedStdioProcess> {
  const command = await host.getResolvedProviderCliPath('antigravity');
  if (!command) throw new Error('Antigravity CLI was not found. Set the agy executable path in provider settings.');
  const env = { ...process.env, ...parseEnvironmentVariables(host.getActiveEnvironmentVariables('antigravity')) };
  env.PATH = getEnhancedPath(env.PATH, command);
  return new ManagedStdioProcess({ command, args, cwd, env });
}

export async function readAntigravityMetadata(host: ProviderHost, cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const proc = await createAntigravityProcess(host, cwd, args);
  if (signal?.aborted) throw new Error('Discovery cancelled');
  let timedOut = false;
  const abort = () => { void proc.shutdown(); };
  signal?.addEventListener('abort', abort, { once: true });
  const timer = window.setTimeout(() => { timedOut = true; abort(); }, 30_000);
  try {
    const completion = new Promise<{ code: number | null; error?: Error }>((resolve) => {
      proc.onError(error => resolve({ code: null, error }));
      proc.onClose(state => resolve(state));
    });
    proc.start();
    proc.stdin.end();
    let output = '';
    const lines = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    for await (const line of lines) {
      output += `${line}\n`;
      if (output.length > 2_000_000) throw new Error('Metadata response exceeds the size limit');
    }
    const { code, error } = await completion;
    if (error) throw error;
    if (signal?.aborted) throw new Error('Discovery cancelled');
    if (timedOut) throw new Error('Antigravity discovery timed out');
    if (code !== 0) throw new Error(proc.getStderrSnapshot() || `Antigravity exited with code ${code}`);
    return output;
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    await proc.shutdown();
  }
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
