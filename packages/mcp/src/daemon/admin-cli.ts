import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { Context, MilvusVectorDatabase } from '@zilliz/claude-context-core';
import type { ContextMcpConfig } from '../config.js';
import { createEmbeddingInstance } from '../embedding.js';
import { SnapshotManager } from '../snapshot.js';
import { parsePositiveInt } from './utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type AdminCommandResult = { handled: false } | { handled: true; exitCode: number };

function parseBooleanEnv(value: string | undefined): boolean {
  if (!value) return false;
  return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes';
}

function getRequestedAdminFlags(args: string[]): string[] {
  return [...new Set(args.filter((arg) => arg.startsWith('--admin-')))];
}

function getRequestedFullIndexFlags(args: string[]): string[] {
  const fullIndexFlags = new Set(['--admin-index', '--admin-reindex']);
  return [...new Set(args.filter((arg) => fullIndexFlags.has(arg)))];
}

function getArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function normalizeAbs(p: string): string {
  if (!path.isAbsolute(p)) {
    throw new Error(`Expected absolute path, got '${p}'`);
  }
  return path.resolve(p);
}

export function getSelfIndexScriptPath(): string {
  const script = process.argv[1];
  if (!script) return path.resolve(__dirname, '..', 'index.js');
  return path.isAbsolute(script) ? script : path.resolve(process.cwd(), script);
}

function getSelfCommandPrefix(): string {
  return `node ${JSON.stringify(getSelfIndexScriptPath())}`;
}

function parseExtensionsCsv(csv: string): string[] {
  const parts = csv
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const normalized = parts.map((ext) => (ext.startsWith('.') ? ext : `.${ext}`));
  return [...new Set(normalized)];
}

async function confirmDangerousAction(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.warn(
      '[ADMIN] Aborting: cannot prompt for confirmation in non-interactive mode. Use a terminal with TTY support.'
    );
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(prompt)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

async function ensureDirectoryExists(codebasePath: string): Promise<void> {
  const stat = await fs.stat(codebasePath);
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: '${codebasePath}'`);
  }
}

function buildContextForConfig(params: {
  config: ContextMcpConfig;
  embeddingProvider?: ContextMcpConfig['embeddingProvider'];
  embeddingModel?: string;
}): { context: Context; vectorDatabase: MilvusVectorDatabase; embeddingConfig: ContextMcpConfig } {
  const { config, embeddingProvider, embeddingModel } = params;
  const embeddingConfig: ContextMcpConfig = { ...config };
  if (embeddingProvider) embeddingConfig.embeddingProvider = embeddingProvider;
  if (embeddingModel) embeddingConfig.embeddingModel = embeddingModel;

  const embedding = createEmbeddingInstance(embeddingConfig);
  const vectorDatabase = new MilvusVectorDatabase({
    address: embeddingConfig.milvusAddress,
    ...(embeddingConfig.milvusToken && { token: embeddingConfig.milvusToken }),
  });
  const context = new Context({ embedding, vectorDatabase });
  return { context, vectorDatabase, embeddingConfig };
}

async function getIndexVectorDimension(params: {
  context: Context;
  vectorDatabase: MilvusVectorDatabase;
  codebasePath: string;
}): Promise<number | null> {
  const { context, vectorDatabase, codebasePath } = params;
  const collectionName = context.getCollectionName(codebasePath);
  try {
    const results = await vectorDatabase.query(collectionName, '', ['vector'], 1);
    const first = results?.[0] as any;
    const vector = first?.vector as unknown;
    if (!Array.isArray(vector)) return null;
    return vector.length;
  } catch (error) {
    console.warn(`[ADMIN] Failed to detect vector dimension from index; continuing.`, error);
    return null;
  }
}

async function setSnapshotIndexedWithEmbeddingMeta(params: {
  snapshotManager: SnapshotManager;
  codebasePath: string;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDimension: number;
  stats?: { indexedFiles: number; totalChunks: number; status: 'completed' | 'limit_reached' };
}): Promise<void> {
  const {
    snapshotManager,
    codebasePath,
    embeddingProvider,
    embeddingModel,
    embeddingDimension,
    stats,
  } = params;

  snapshotManager.loadCodebaseSnapshot();

  const existingInfo = snapshotManager.getCodebaseInfo(codebasePath) as any | undefined;
  const statsToUse =
    stats ||
    (existingInfo && existingInfo.status === 'indexed'
      ? {
          indexedFiles: existingInfo.indexedFiles || 0,
          totalChunks: existingInfo.totalChunks || 0,
          status: existingInfo.indexStatus || 'completed',
        }
      : { indexedFiles: 0, totalChunks: 0, status: 'completed' });

  snapshotManager.setCodebaseIndexed(codebasePath, statsToUse);

  const updatedInfo = snapshotManager.getCodebaseInfo(codebasePath) as any;
  if (updatedInfo && updatedInfo.status === 'indexed') {
    updatedInfo.embeddingProvider = embeddingProvider;
    updatedInfo.embeddingModel = embeddingModel;
    updatedInfo.embeddingDimension = embeddingDimension;
  }

  snapshotManager.saveCodebaseSnapshot();
}

async function purgeSubpathFromIndex(params: {
  config: ContextMcpConfig;
  codebaseRoot: string;
  relativeSubpath: string;
}): Promise<void> {
  const { config, codebaseRoot, relativeSubpath } = params;

  if (path.isAbsolute(relativeSubpath)) {
    throw new Error(`relativeSubpath must be relative, got '${relativeSubpath}'`);
  }
  if (relativeSubpath.split(path.sep).includes('..')) {
    throw new Error(`relativeSubpath must not include '..', got '${relativeSubpath}'`);
  }

  const codebasePath = normalizeAbs(codebaseRoot);
  const absoluteSubpath = path.resolve(path.join(codebasePath, relativeSubpath));

  const relCheck = path.relative(codebasePath, absoluteSubpath);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    throw new Error(`Resolved purge path escapes codebase root: '${absoluteSubpath}'`);
  }

  // Set up Context (embedding won't be used for deletion, but Context requires it).
  const embedding = createEmbeddingInstance(config);
  const vectorDatabase = new MilvusVectorDatabase({
    address: config.milvusAddress,
    ...(config.milvusToken && { token: config.milvusToken }),
  });
  const context = new Context({ embedding, vectorDatabase });

  const hasIndex = await context.hasIndex(codebasePath);
  if (!hasIndex) {
    console.log(`[ADMIN] No index found for '${codebasePath}'. Nothing to purge.`);
    return;
  }

  const collectionName = context.getCollectionName(codebasePath);
  const normalizedRelativeSubpath = relativeSubpath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!normalizedRelativeSubpath) {
    throw new Error(`relativeSubpath resolves to empty path`);
  }
  const escapedSubpath = normalizedRelativeSubpath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  // Escape % and _ which are wildcards in Milvus 'like' expressions to prevent
  // unintended broader matching when subpath contains these characters.
  const likeEscapedSubpath = escapedSubpath.replace(/%/g, '\\%').replace(/_/g, '\\_');
  const filterExpr =
    `relativePath like "${likeEscapedSubpath}/%"` + ` or relativePath == "${escapedSubpath}"`;

  const sample = await vectorDatabase.query(collectionName, filterExpr, ['id'], 16384);
  const sampleCount = Array.isArray(sample) ? sample.length : 0;
  console.log(
    `[ADMIN] Purging chunks where relativePath is under '${normalizedRelativeSubpath}' in '${codebasePath}'. ` +
      `Sample matched chunk count: ${sampleCount}${sampleCount === 16384 ? '+' : ''}`
  );

  let totalDeletedChunks = 0;
  const deleteBatchSize = 1000;
  while (true) {
    const results = await vectorDatabase.query(collectionName, filterExpr, ['id'], 16384);
    const ids = results.map((r) => r.id as string).filter((id) => id);
    if (ids.length === 0) {
      break;
    }
    for (let j = 0; j < ids.length; j += deleteBatchSize) {
      const deleteBatch = ids.slice(j, j + deleteBatchSize);
      if (deleteBatch.length === 0) continue;
      await vectorDatabase.delete(collectionName, deleteBatch);
      totalDeletedChunks += deleteBatch.length;
    }
  }

  console.log(`[ADMIN] Purge complete. Deleted ${totalDeletedChunks} chunk(s).`);
}

async function purgeExtensionsFromIndex(params: {
  config: ContextMcpConfig;
  codebasePath: string;
  extensions: string[];
}): Promise<void> {
  const { config, codebasePath, extensions } = params;
  const absolutePath = normalizeAbs(codebasePath);
  await ensureDirectoryExists(absolutePath);

  if (extensions.length === 0) {
    throw new Error(`No extensions provided`);
  }

  const { context, vectorDatabase } = buildContextForConfig({ config });

  const hasIndex = await context.hasIndex(absolutePath);
  if (!hasIndex) {
    console.log(`[ADMIN] No index found for '${absolutePath}'. Nothing to purge.`);
    return;
  }

  const collectionName = context.getCollectionName(absolutePath);
  const quoted = extensions.map((ext) => JSON.stringify(ext)).join(', ');
  const filterExpr = `fileExtension in [${quoted}]`;

  // Provide a minimal estimate (first batch only) before asking for confirmation.
  const sample = await vectorDatabase.query(collectionName, filterExpr, ['id'], 16384);
  const sampleCount = Array.isArray(sample) ? sample.length : 0;
  const estimateMessage =
    sampleCount < 16384
      ? `Found ${sampleCount} matching chunk(s).`
      : `Found at least ${sampleCount} matching chunk(s) (showing first batch).`;

  const ok = await confirmDangerousAction(
    `[ADMIN] This will DELETE ALL chunks where fileExtension in [${extensions.join(', ')}] from collection '${collectionName}'.\n` +
      `${estimateMessage}\n` +
      `Proceed? (y/N): `
  );
  if (!ok) {
    console.log('[ADMIN] Aborted.');
    return;
  }

  let totalDeleted = 0;
  while (true) {
    const results = await vectorDatabase.query(collectionName, filterExpr, ['id'], 16384);
    const ids = (results || [])
      .map((r: any) => r.id as string)
      .filter((id: any) => typeof id === 'string' && id.length > 0);
    if (ids.length === 0) break;

    // Delete in smaller batches to avoid request limits.
    const batchSize = 1000;
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      await vectorDatabase.delete(collectionName, batch);
      totalDeleted += batch.length;
    }
  }

  console.log(`[ADMIN] Purge complete. Deleted ${totalDeleted} chunk(s).`);
}

async function clearCodebaseIndex(params: {
  config: ContextMcpConfig;
  codebasePath: string;
}): Promise<void> {
  const { config, codebasePath } = params;
  const absolutePath = normalizeAbs(codebasePath);

  const embedding = createEmbeddingInstance(config);
  const vectorDatabase = new MilvusVectorDatabase({
    address: config.milvusAddress,
    ...(config.milvusToken && { token: config.milvusToken }),
  });
  const context = new Context({ embedding, vectorDatabase });

  console.log(`[ADMIN] Clearing index for '${absolutePath}'...`);
  await context.clearIndex(absolutePath);

  const snapshotManager = new SnapshotManager();
  snapshotManager.loadCodebaseSnapshot();
  snapshotManager.removeCodebaseCompletely(absolutePath);
  snapshotManager.saveCodebaseSnapshot();

  console.log(`[ADMIN] Cleared index and removed from snapshot: '${absolutePath}'`);
}

async function indexCodebaseAdmin(params: {
  config: ContextMcpConfig;
  codebasePath: string;
  forceReindex: boolean;
}): Promise<void> {
  const { config, codebasePath, forceReindex } = params;
  const absolutePath = normalizeAbs(codebasePath);
  await ensureDirectoryExists(absolutePath);

  const { context, embeddingConfig } = buildContextForConfig({ config });

  if (!forceReindex) {
    const hasIndex = await context.hasIndex(absolutePath);
    if (hasIndex) {
      throw new Error(
        `Index already exists for '${absolutePath}'. Refusing to index to avoid duplicate cost. ` +
          `Use '${getSelfCommandPrefix()} --admin-sync "${absolutePath}"' or '--admin-reindex'.`
      );
    }
  }

  const ok = forceReindex
    ? await confirmDangerousAction(
        `[ADMIN] This will DROP and fully rebuild the index for '${absolutePath}'. This can be expensive.\nProceed? (y/N): `
      )
    : true;
  if (!ok) {
    console.log('[ADMIN] Aborted.');
    return;
  }

  const snapshotManager = new SnapshotManager();
  snapshotManager.loadCodebaseSnapshot();
  snapshotManager.setCodebaseIndexing(absolutePath, 0);
  snapshotManager.saveCodebaseSnapshot();

  try {
    let lastSave = 0;
    const stats = await context.indexCodebase(
      absolutePath,
      (progress) => {
        snapshotManager.setCodebaseIndexing(absolutePath, progress.percentage);
        const now = Date.now();
        if (now - lastSave >= 2000) {
          snapshotManager.saveCodebaseSnapshot();
          lastSave = now;
        }
        console.log(`[ADMIN] ${progress.phase} ${progress.percentage}%`);
      },
      forceReindex
    );

    snapshotManager.setCodebaseIndexed(absolutePath, stats);

    const updatedInfo = snapshotManager.getCodebaseInfo(absolutePath) as any;
    if (updatedInfo && updatedInfo.status === 'indexed') {
      updatedInfo.embeddingProvider = context.getEmbedding().getProvider();
      updatedInfo.embeddingModel = embeddingConfig.embeddingModel;
      updatedInfo.embeddingDimension = context.getEmbedding().getDimension();
    }

    snapshotManager.saveCodebaseSnapshot();

    console.log(
      `[ADMIN] Indexing complete for '${absolutePath}'. Files: ${stats.indexedFiles}, Chunks: ${stats.totalChunks}, Status: ${stats.status}`
    );
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error);
    snapshotManager.setCodebaseIndexFailed(absolutePath, message);
    snapshotManager.saveCodebaseSnapshot();
    throw error;
  }
}

async function adoptExistingIndexIntoSnapshot(params: {
  config: ContextMcpConfig;
  codebasePath: string;
}): Promise<void> {
  const { config, codebasePath } = params;
  const absolutePath = normalizeAbs(codebasePath);
  await ensureDirectoryExists(absolutePath);

  const { context, vectorDatabase, embeddingConfig } = buildContextForConfig({ config });

  const hasIndex = await context.hasIndex(absolutePath);
  if (!hasIndex) {
    throw new Error(`No vector index found for '${absolutePath}'. Use --admin-index first.`);
  }

  // Dimension sanity check: compare index vector length with embedding dimension.
  const indexDim = await getIndexVectorDimension({
    context,
    vectorDatabase,
    codebasePath: absolutePath,
  });
  const embeddingDim = await context.getEmbedding().detectDimension();
  if (indexDim !== null && indexDim !== embeddingDim) {
    throw new Error(
      `Embedding dimension mismatch for '${absolutePath}': indexDim=${indexDim}, embeddingDim=${embeddingDim}.\n` +
        `Set EMBEDDING_PROVIDER/EMBEDDING_MODEL to match the existing index, then re-run:\n` +
        `  ${getSelfCommandPrefix()} --admin-adopt "${absolutePath}"`
    );
  }

  const snapshotManager = new SnapshotManager();
  await setSnapshotIndexedWithEmbeddingMeta({
    snapshotManager,
    codebasePath: absolutePath,
    embeddingProvider: context.getEmbedding().getProvider(),
    embeddingModel: embeddingConfig.embeddingModel,
    embeddingDimension: embeddingDim,
  });

  console.log(
    `[ADMIN] Adopted existing index into snapshot for '${absolutePath}' (${context.getEmbedding().getProvider()}/${embeddingConfig.embeddingModel}, ${embeddingDim}D).`
  );
}

async function syncCodebaseIncrementally(params: {
  config: ContextMcpConfig;
  codebasePath: string;
  bypassCaps: boolean;
}): Promise<void> {
  const { config, codebasePath, bypassCaps } = params;
  const absolutePath = normalizeAbs(codebasePath);
  await ensureDirectoryExists(absolutePath);

  const snapshotManager = new SnapshotManager();
  snapshotManager.loadCodebaseSnapshot();
  const info = snapshotManager.getCodebaseInfo(absolutePath) as any | undefined;

  if (!info || info.status !== 'indexed') {
    throw new Error(
      `Snapshot has no indexed entry for '${absolutePath}'.\n` +
        `Run one of:\n` +
        `  - ${getSelfCommandPrefix()} --admin-index "${absolutePath}"\n` +
        `  - ${getSelfCommandPrefix()} --admin-adopt "${absolutePath}"`
    );
  }

  const embeddingProvider = info.embeddingProvider as
    | ContextMcpConfig['embeddingProvider']
    | undefined;
  const embeddingModel = info.embeddingModel as string | undefined;
  if (!embeddingProvider || !embeddingModel) {
    throw new Error(
      `Snapshot is missing embeddingProvider/embeddingModel for '${absolutePath}'.\n` +
        `Set EMBEDDING_PROVIDER/EMBEDDING_MODEL to match the existing index, then run:\n` +
        `  ${getSelfCommandPrefix()} --admin-adopt "${absolutePath}"`
    );
  }

  const { context, vectorDatabase } = buildContextForConfig({
    config,
    embeddingProvider,
    embeddingModel,
  });

  const hasIndex = await context.hasIndex(absolutePath);
  if (!hasIndex) {
    throw new Error(
      `No vector index found for '${absolutePath}'. Use --admin-index or --admin-reindex.`
    );
  }

  // Dimension sanity check before embedding (prevents wasted spend).
  const indexDim = await getIndexVectorDimension({
    context,
    vectorDatabase,
    codebasePath: absolutePath,
  });
  const embeddingDim = await context.getEmbedding().detectDimension();
  if (indexDim !== null && indexDim !== embeddingDim) {
    throw new Error(
      `Embedding dimension mismatch for '${absolutePath}': indexDim=${indexDim}, embeddingDim=${embeddingDim}.\n` +
        `Refusing to sync. Fix snapshot/env to match the existing index embedding model.`
    );
  }

  const maxEmbedFiles = parsePositiveInt(process.env.CONTEXT_SYNC_MAX_EMBED_FILES, 200);
  const maxEmbedBytes = parsePositiveInt(process.env.CONTEXT_SYNC_MAX_EMBED_BYTES, 2_000_000);

  const stats = await context.reindexByChange(absolutePath, undefined, {
    maxEmbedFiles,
    maxEmbedBytes,
    includeModified: true,
    bypassCaps,
  });

  console.log(
    `[ADMIN] Sync complete for '${absolutePath}'. added=${stats.added}, removed=${stats.removed}, modified=${stats.modified}`
  );
}

export async function runAdminCommandFromArgs(
  args: string[],
  config: ContextMcpConfig
): Promise<AdminCommandResult> {
  const requestedAdminFlags = getRequestedAdminFlags(args);
  if (requestedAdminFlags.length > 0 && parseBooleanEnv(process.env.CONTEXT_DISABLE_ADMIN_CLI)) {
    console.error(
      `[ADMIN] Admin CLI is disabled by CONTEXT_DISABLE_ADMIN_CLI=true. ` +
        `Blocked flag(s): ${requestedAdminFlags.join(', ')}`
    );
    return { handled: true, exitCode: 1 };
  }

  const requestedFullIndexFlags = getRequestedFullIndexFlags(args);
  if (
    requestedFullIndexFlags.length > 0 &&
    parseBooleanEnv(process.env.CONTEXT_DISABLE_FULL_INDEX_COMMANDS)
  ) {
    console.error(
      `[ADMIN] Full indexing commands are disabled by CONTEXT_DISABLE_FULL_INDEX_COMMANDS=true. ` +
        `Blocked flag(s): ${requestedFullIndexFlags.join(', ')}`
    );
    return { handled: true, exitCode: 1 };
  }

  if (args.includes('--admin-index')) {
    const codebasePath = getArgValue(args, '--admin-index');
    if (!codebasePath) {
      console.error(`[ADMIN] Missing value for --admin-index <ABSOLUTE_PATH>`);
      return { handled: true, exitCode: 1 };
    }
    try {
      await indexCodebaseAdmin({ config, codebasePath, forceReindex: false });
      return { handled: true, exitCode: 0 };
    } catch (error) {
      console.error(`[ADMIN] Failed to index codebase:`, error);
      return { handled: true, exitCode: 1 };
    }
  }

  if (args.includes('--admin-reindex')) {
    const codebasePath = getArgValue(args, '--admin-reindex');
    if (!codebasePath) {
      console.error(`[ADMIN] Missing value for --admin-reindex <ABSOLUTE_PATH>`);
      return { handled: true, exitCode: 1 };
    }
    try {
      await indexCodebaseAdmin({ config, codebasePath, forceReindex: true });
      return { handled: true, exitCode: 0 };
    } catch (error) {
      console.error(`[ADMIN] Failed to reindex codebase:`, error);
      return { handled: true, exitCode: 1 };
    }
  }

  if (args.includes('--admin-adopt')) {
    const codebasePath = getArgValue(args, '--admin-adopt');
    if (!codebasePath) {
      console.error(`[ADMIN] Missing value for --admin-adopt <ABSOLUTE_PATH>`);
      return { handled: true, exitCode: 1 };
    }
    try {
      await adoptExistingIndexIntoSnapshot({ config, codebasePath });
      return { handled: true, exitCode: 0 };
    } catch (error) {
      console.error(`[ADMIN] Failed to adopt codebase into snapshot:`, error);
      return { handled: true, exitCode: 1 };
    }
  }

  if (args.includes('--admin-sync')) {
    const codebasePath = getArgValue(args, '--admin-sync');
    if (!codebasePath) {
      console.error(`[ADMIN] Missing value for --admin-sync <ABSOLUTE_PATH>`);
      return { handled: true, exitCode: 1 };
    }
    try {
      await syncCodebaseIncrementally({ config, codebasePath, bypassCaps: false });
      return { handled: true, exitCode: 0 };
    } catch (error) {
      console.error(`[ADMIN] Failed to sync codebase:`, error);
      return { handled: true, exitCode: 1 };
    }
  }

  if (args.includes('--admin-sync-force')) {
    const codebasePath = getArgValue(args, '--admin-sync-force');
    if (!codebasePath) {
      console.error(`[ADMIN] Missing value for --admin-sync-force <ABSOLUTE_PATH>`);
      return { handled: true, exitCode: 1 };
    }
    try {
      await syncCodebaseIncrementally({ config, codebasePath, bypassCaps: true });
      return { handled: true, exitCode: 0 };
    } catch (error) {
      console.error(`[ADMIN] Failed to sync-force codebase:`, error);
      return { handled: true, exitCode: 1 };
    }
  }

  if (args.includes('--admin-purge-ext')) {
    const idx = args.indexOf('--admin-purge-ext');
    const codebasePath = args[idx + 1];
    const csvExts = args[idx + 2];
    if (!codebasePath || !csvExts) {
      console.error(`[ADMIN] Usage: --admin-purge-ext <CODEBASE_ROOT_ABS> <CSV_EXTS>`);
      return { handled: true, exitCode: 1 };
    }
    try {
      const extensions = parseExtensionsCsv(csvExts);
      await purgeExtensionsFromIndex({ config, codebasePath, extensions });
      return { handled: true, exitCode: 0 };
    } catch (error) {
      console.error(`[ADMIN] Failed to purge extensions:`, error);
      return { handled: true, exitCode: 1 };
    }
  }

  if (args.includes('--admin-clear-codebase')) {
    const codebasePath = getArgValue(args, '--admin-clear-codebase');
    if (!codebasePath) {
      console.error(`[ADMIN] Missing value for --admin-clear-codebase <ABSOLUTE_PATH>`);
      return { handled: true, exitCode: 1 };
    }
    try {
      await clearCodebaseIndex({ config, codebasePath });
      return { handled: true, exitCode: 0 };
    } catch (error) {
      console.error(`[ADMIN] Failed to clear codebase index:`, error);
      return { handled: true, exitCode: 1 };
    }
  }

  if (args.includes('--admin-purge-subpath')) {
    const idx = args.indexOf('--admin-purge-subpath');
    const codebaseRoot = args[idx + 1];
    const relativeSubpath = args[idx + 2];
    if (!codebaseRoot || !relativeSubpath) {
      console.error(`[ADMIN] Usage: --admin-purge-subpath <CODEBASE_ROOT_ABS> <RELATIVE_SUBPATH>`);
      return { handled: true, exitCode: 1 };
    }
    try {
      await purgeSubpathFromIndex({ config, codebaseRoot, relativeSubpath });
      return { handled: true, exitCode: 0 };
    } catch (error) {
      console.error(`[ADMIN] Failed to purge subpath:`, error);
      return { handled: true, exitCode: 1 };
    }
  }

  return { handled: false };
}
