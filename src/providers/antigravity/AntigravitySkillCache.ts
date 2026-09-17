import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { SlashCommand } from '@/core/types';
import { throwIfAborted, toAbortError } from '@/utils/abort';

import { parseAntigravitySkills } from './AntigravityMetadata';
import { record } from './AntigravityProcess';

const REVALIDATE_AFTER_MS = 5 * 60_000;

/** Workspace-owned native metadata, shared across chats and restored before revalidation. */
export class AntigravitySkillCache {
  private readonly path: string;
  private snapshot?: SlashCommand[];
  private key?: string;
  private restoration?: Promise<void>;
  private pending?: { controller: AbortController; promise: Promise<SlashCommand[]> };
  private readonly active = new Set<Promise<SlashCommand[]>>();
  private generation = 0;
  private lastAttempt = 0;
  private disposed = false;

  constructor(cwd: string, private readonly discover: (signal: AbortSignal) => Promise<SlashCommand[]>) {
    this.path = join(cwd, '.claudian', 'cache', 'antigravity-skills.json');
  }

  async load(key: string, signal?: AbortSignal): Promise<SlashCommand[]> {
    throwIfAborted(signal, 'Skill discovery cancelled');
    if (this.disposed) throw new Error('Skill cache disposed');
    if (this.key !== key) {
      this.invalidate();
      this.key = key;
    }
    const generation = this.generation;
    this.restoration ??= this.restore(key, generation);
    await this.wait(this.restoration, signal);
    throwIfAborted(signal, 'Skill discovery cancelled');
    if (this.disposed || generation !== this.generation) throw new Error('Skill discovery invalidated');
    if (this.snapshot !== undefined) {
      if (!this.pending && Date.now() - this.lastAttempt >= REVALIDATE_AFTER_MS) {
        // A failed refresh must not discard a usable native catalog.
        void this.refresh(key, generation).catch(() => {});
      }
      return this.clone(this.snapshot);
    }
    return this.clone(await this.wait(this.refresh(key, generation), signal));
  }

  invalidate(): void {
    this.generation++;
    this.key = undefined;
    this.snapshot = undefined;
    this.restoration = undefined;
    this.lastAttempt = 0;
    this.pending?.controller.abort();
    this.pending = undefined;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.invalidate();
    await Promise.allSettled([...this.active]);
  }

  private refresh(key: string, generation: number): Promise<SlashCommand[]> {
    if (this.pending) return this.pending.promise;
    const controller = new AbortController();
    this.lastAttempt = Date.now();
    const promise = this.discover(controller.signal).then(async items => {
      throwIfAborted(controller.signal, 'Skill discovery cancelled');
      if (generation !== this.generation) throw new Error('Skill discovery invalidated');
      await this.persist(key, items, generation);
      throwIfAborted(controller.signal, 'Skill discovery cancelled');
      if (generation !== this.generation) throw new Error('Skill discovery invalidated');
      this.snapshot = this.clone(items);
      return items;
    }).finally(() => {
      this.active.delete(promise);
      if (this.pending?.promise === promise) this.pending = undefined;
    });
    this.active.add(promise);
    this.pending = { controller, promise };
    return promise;
  }

  private async restore(key: string, generation: number): Promise<void> {
    try {
      if ((await stat(this.path)).size > 1_000_000) return;
      const text = await readFile(this.path, 'utf8');
      if (text.length > 1_000_000) return;
      const cache = record(JSON.parse(text));
      if (cache.version !== 1 || cache.fingerprint !== key || !Array.isArray(cache.skills)) return;
      const items = parseAntigravitySkills(JSON.stringify({ status: 'SUCCESS', command: { data: { skills: cache.skills } } }));
      // Treat a malformed or duplicate entry as a cache miss, never as an empty native list.
      if (items.length !== cache.skills.length || !cache.skills.every(raw => typeof record(raw).description === 'string')) return;
      if (generation === this.generation && !this.disposed) this.snapshot = items;
    } catch {
      // Missing, corrupt or unreadable cache: use native discovery.
    }
  }

  private async persist(key: string, items: SlashCommand[], generation: number): Promise<void> {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(temporary, JSON.stringify({
        version: 1, fingerprint: key,
        skills: items.map(({ name, description }) => ({ name, description })),
      }));
      if (generation === this.generation && !this.disposed) await rename(temporary, this.path);
    } catch {
      // Cache persistence is optional; it must not break native discovery.
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  private clone(items: readonly SlashCommand[]): SlashCommand[] {
    return items.map(item => ({ ...item }));
  }

  private async wait<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    throwIfAborted(signal, 'Skill discovery cancelled');
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(toAbortError(signal, 'Skill discovery cancelled'));
      signal.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([promise, cancelled]); }
    finally { signal.removeEventListener('abort', abort); }
  }
}
