import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { Context, MilvusVectorDatabase } from '@zilliz/claude-context-core';
import type { ContextMcpConfig } from '../config.js';
import { createEmbeddingInstance } from '../embedding.js';
import { acquireDaemonLock, isDaemonLockHeld } from './lock.js';
import { writeDaemonStatusFile, type DaemonStatusFile } from './status.js';
import { parsePositiveInt } from './utils.js';

const LOCK_FILE_PATH = path.join(os.homedir(), '.context', 'locks', 'indexer-daemon.lock');
const PID_FILE_PATH = path.join(os.homedir(), '.context', 'indexer-daemon.pid');
const SNAPSHOT_FILE_PATH = path.join(os.homedir(), '.context', 'mcp-codebase-snapshot.json');

function getIndexerEntryScriptPath(): string {
  // In dist builds, this module is at dist/daemon/indexer-daemon.js.
  // The executable entry is dist/index.js (same package).
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'index.js');
}

async function readSnapshotFile(): Promise<any | null> {
  try {
    const raw = await fs.readFile(SNAPSHOT_FILE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    console.error(`[DAEMON] Failed to read snapshot file '${SNAPSHOT_FILE_PATH}':`, error);
    return null;
  }
}

function getSnapshotCodebaseInfo(snapshot: any, codebasePath: string): any | null {
  if (!snapshot) return null;
  if (
    snapshot &&
    typeof snapshot === 'object' &&
    snapshot.codebases &&
    typeof snapshot.codebases === 'object'
  ) {
    return snapshot.codebases[codebasePath] || null;
  }
  // v1 fallback: no per-codebase metadata available
  if (
    Array.isArray(snapshot.indexedCodebases) &&
    snapshot.indexedCodebases.includes(codebasePath)
  ) {
    return { status: 'indexed' };
  }
  return null;
}

function normalizeCodebases(params: { allowlist: string[]; blocklist: string[] }): {
  codebases: string[];
  blocked: Set<string>;
} {
  const blocked = new Set(params.blocklist);
  const codebases = params.allowlist.filter((p) => !blocked.has(p));
  return { codebases, blocked };
}

export async function ensureIndexerDaemonRunning(_opts?: {
  intervalMinutes?: number;
}): Promise<void> {
  const held = await isDaemonLockHeld(LOCK_FILE_PATH);
  if (held.held) {
    console.log(`[DAEMON] Indexer daemon already running (pid ${held.pid})`);
    return;
  }

  const entryScript = getIndexerEntryScriptPath();
  const child = spawn(process.execPath, [entryScript, '--daemon'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, CONTEXT_READONLY_MODE: '' },
  });
  child.unref();
  console.log(`[DAEMON] Spawned indexer daemon (pid ${child.pid ?? 'unknown'})`);
}

export async function runIndexerDaemon(config: ContextMcpConfig): Promise<void> {
  const lock = await acquireDaemonLock({
    lockFilePath: LOCK_FILE_PATH,
    pidFilePath: PID_FILE_PATH,
  });
  if (!lock.acquired) {
    console.log(`[DAEMON] Another indexer daemon is already running.`);
    return;
  }

  console.log(`[DAEMON] Indexer daemon started (pid ${lock.handle.pid})`);

  const status: DaemonStatusFile = {
    pid: lock.handle.pid,
    startedAt: new Date().toISOString(),
    intervalMinutes: config.daemonIntervalMinutes,
    codebases: {},
  };

  const { codebases } = normalizeCodebases({
    allowlist: config.daemonCodebaseAllowlist,
    blocklist: config.daemonCodebaseBlocklist,
  });

  if (codebases.length === 0) {
    const errorMessage =
      `CONTEXT_DAEMON_CODEBASE_ALLOWLIST is empty (or fully blocked). ` +
      `Refusing to run to avoid unintended indexing.`;
    status.lastError = errorMessage;
    await writeDaemonStatusFile(status);
    console.error(`[DAEMON] ${errorMessage}`);
    await lock.handle.release();
    process.exit(1);
  }

  // Shared vector database connection.
  const vectorDatabase = new MilvusVectorDatabase({
    address: config.milvusAddress,
    ...(config.milvusToken && { token: config.milvusToken }),
  });

  const contextCache = new Map<string, Context>();
  const getContextForEmbedding = (
    embeddingProvider: ContextMcpConfig['embeddingProvider'],
    embeddingModel: string
  ): Context => {
    const cacheKey = `${embeddingProvider}:${embeddingModel}`;
    const cached = contextCache.get(cacheKey);
    if (cached) return cached;

    const embedding = createEmbeddingInstance({
      ...config,
      embeddingProvider,
      embeddingModel,
    });
    const ctx = new Context({ embedding, vectorDatabase });
    contextCache.set(cacheKey, ctx);
    return ctx;
  };

  let isRunning = false;

  const runOnce = async () => {
    if (isRunning) {
      console.warn(`[DAEMON] Previous run still in progress; skipping this tick.`);
      return;
    }
    isRunning = true;

    const startedAt = Date.now();
    try {
      status.lastRunAt = new Date().toISOString();
      status.lastError = undefined;

      const snapshot = await readSnapshotFile();

      for (const codebasePath of codebases) {
        const perCodebaseStartedAt = Date.now();

        try {
          const info = getSnapshotCodebaseInfo(snapshot, codebasePath);
          const snapshotStatus = info?.status;
          if (snapshotStatus === 'indexing') {
            status.codebases[codebasePath] = {
              added: 0,
              removed: 0,
              modified: 0,
              lastRunAt: new Date().toISOString(),
              lastRunDurationMs: Date.now() - perCodebaseStartedAt,
              lastError: `Skipped: full indexing in progress`,
            };
            continue;
          }

          const embeddingProvider = info?.embeddingProvider as
            | ContextMcpConfig['embeddingProvider']
            | undefined;
          const embeddingModel = info?.embeddingModel as string | undefined;

          if (!embeddingProvider || !embeddingModel) {
            status.codebases[codebasePath] = {
              added: 0,
              removed: 0,
              modified: 0,
              lastRunAt: new Date().toISOString(),
              lastRunDurationMs: Date.now() - perCodebaseStartedAt,
              lastError: `Skipped: missing embeddingProvider/embeddingModel for codebase in snapshot (${SNAPSHOT_FILE_PATH}).`,
            };
            continue;
          }

          const ctx = getContextForEmbedding(embeddingProvider, embeddingModel);

          const hasIndex = await ctx.hasIndex(codebasePath);
          if (!hasIndex) {
            status.codebases[codebasePath] = {
              added: 0,
              removed: 0,
              modified: 0,
              lastRunAt: new Date().toISOString(),
              lastRunDurationMs: Date.now() - perCodebaseStartedAt,
              lastError: `Skipped: no vector index found for this codebase`,
            };
            continue;
          }

          const maxEmbedFiles = parsePositiveInt(process.env.CONTEXT_SYNC_MAX_EMBED_FILES, 200);
          const maxEmbedBytes = parsePositiveInt(
            process.env.CONTEXT_SYNC_MAX_EMBED_BYTES,
            2_000_000
          );

          const stats = await ctx.reindexByChange(codebasePath, undefined, {
            maxEmbedFiles,
            maxEmbedBytes,
            includeModified: true,
          });
          status.codebases[codebasePath] = {
            added: stats.added,
            removed: stats.removed,
            modified: stats.modified,
            lastRunAt: new Date().toISOString(),
            lastRunDurationMs: Date.now() - perCodebaseStartedAt,
          };
        } catch (error: any) {
          const message = error instanceof Error ? error.message : String(error);
          const friendlyMessage =
            typeof message === 'string' && message.startsWith('SYNC_CAP_EXCEEDED')
              ? `${message}\nRun terminal admin sync-force to proceed intentionally:\n  node ${JSON.stringify(
                  getIndexerEntryScriptPath()
                )} --admin-sync-force ${JSON.stringify(codebasePath)}`
              : message;
          status.codebases[codebasePath] = {
            added: 0,
            removed: 0,
            modified: 0,
            lastRunAt: new Date().toISOString(),
            lastRunDurationMs: Date.now() - perCodebaseStartedAt,
            lastError: friendlyMessage,
          };
          status.lastError = friendlyMessage;
          console.error(`[DAEMON] Error updating '${codebasePath}':`, error);
        }
      }

      status.lastRunDurationMs = Date.now() - startedAt;
      await writeDaemonStatusFile(status);
    } finally {
      isRunning = false;
    }
  };

  const shutdown = async (reason: string) => {
    console.error(`[DAEMON] Shutting down (${reason})...`);
    try {
      await writeDaemonStatusFile({
        ...status,
        lastError: status.lastError || `Stopped: ${reason}`,
      });
    } catch (e) {
      console.error('[DAEMON] Failed to write status on shutdown:', e);
    }
    await lock.handle.release();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Run once immediately, then schedule.
  await runOnce();
  const intervalMs = config.daemonIntervalMinutes * 60 * 1000;
  setInterval(() => {
    runOnce().catch((error) => console.error('[DAEMON] runOnce failed:', error));
  }, intervalMs);

  console.log(
    `[DAEMON] Scheduled incremental sync every ${config.daemonIntervalMinutes} minute(s).`
  );
}
