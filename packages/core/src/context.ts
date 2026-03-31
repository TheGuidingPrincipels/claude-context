import { Splitter, CodeChunk, AstCodeSplitter } from './splitter';
import { Embedding, EmbeddingVector, OpenAIEmbedding } from './embedding';
import {
  VectorDatabase,
  VectorDocument,
  VectorSearchResult,
  HybridSearchRequest,
  HybridSearchOptions,
  HybridSearchResult,
} from './vectordb';
import { SemanticSearchResult } from './types';
import { envManager } from './utils/env-manager';
import { resolveCanonicalPath } from './utils/path-remap';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { FileSynchronizer } from './sync/synchronizer';

const DEFAULT_SUPPORTED_EXTENSIONS = [
  // Programming languages
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.java',
  '.cpp',
  '.c',
  '.h',
  '.hpp',
  '.cs',
  '.go',
  '.rs',
  '.php',
  '.rb',
  '.swift',
  '.kt',
  '.scala',
  '.m',
  '.mm',
];

const DOC_EXTENSIONS = new Set(['.md', '.markdown', '.ipynb']);

function normalizeExtension(ext: string): string {
  const trimmed = ext.trim();
  if (!trimmed) return '';
  const withDot = trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
  return withDot.toLowerCase();
}

const DEFAULT_IGNORE_PATTERNS = [
  // Common build output and dependency directories
  'node_modules/**',
  'dist/**',
  'build/**',
  'out/**',
  'target/**',
  'coverage/**',
  '.nyc_output/**',

  // IDE and editor files
  '.vscode/**',
  '.idea/**',
  '*.swp',
  '*.swo',

  // Version control
  '.git/**',
  '.svn/**',
  '.hg/**',

  // Cache directories
  '.cache/**',
  '__pycache__/**',
  '.pytest_cache/**',

  // Logs and temporary files
  'logs/**',
  'tmp/**',
  'temp/**',
  '*.log',

  // Environment and config files
  '.env',
  '.env.*',
  '*.local',

  // Minified and bundled files
  '*.min.js',
  '*.min.css',
  '*.min.map',
  '*.bundle.js',
  '*.bundle.css',
  '*.chunk.js',
  '*.vendor.js',
  '*.polyfills.js',
  '*.runtime.js',
  '*.map', // source map files
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'build',
  'dist',
  'out',
  'target',
  '.vscode',
  '.idea',
  '__pycache__',
  '.pytest_cache',
  'coverage',
  '.nyc_output',
  'logs',
  'tmp',
  'temp',
];

export interface ContextConfig {
  embedding?: Embedding;
  vectorDatabase?: VectorDatabase;
  codeSplitter?: Splitter;
  supportedExtensions?: string[];
  ignorePatterns?: string[];
  customExtensions?: string[]; // New: custom extensions from MCP
  customIgnorePatterns?: string[]; // New: custom ignore patterns from MCP
}

export interface ReindexByChangeOptions {
  /**
   * Safety cap: maximum number of eligible files to embed in a single incremental sync.
   * Defaults to 200.
   */
  maxEmbedFiles?: number;
  /**
   * Safety cap: maximum total bytes across eligible files to embed in a single incremental sync.
   * Defaults to 2_000_000 bytes (2MB).
   */
  maxEmbedBytes?: number;
  /**
   * Whether to include modified files (in addition to added). Defaults to true.
   */
  includeModified?: boolean;
  /**
   * Bypass safety caps entirely (explicit "I accept cost"). Defaults to false.
   */
  bypassCaps?: boolean;
}

export class Context {
  private embedding: Embedding;
  private vectorDatabase: VectorDatabase;
  private codeSplitter: Splitter;
  private supportedExtensions: string[];
  private ignorePatterns: string[];
  private synchronizers = new Map<string, FileSynchronizer>();
  private maxFileSize: number;

  constructor(config: ContextConfig = {}) {
    // Initialize services
    // IMPORTANT: Embedding must be explicitly provided - no silent fallback to OpenAI
    if (!config.embedding) {
      throw new Error(
        'Embedding provider is required. Please configure EMBEDDING_PROVIDER environment variable ' +
          '(VoyageAI, Gemini, Ollama) or provide an embedding instance in the config. ' +
          'OpenAI fallback has been disabled to prevent accidental API usage.'
      );
    }
    this.embedding = config.embedding;

    if (!config.vectorDatabase) {
      throw new Error(
        'VectorDatabase is required. Please provide a vectorDatabase instance in the config.'
      );
    }
    this.vectorDatabase = config.vectorDatabase;

    this.codeSplitter = config.codeSplitter || new AstCodeSplitter(2500, 300);

    // Load custom extensions from environment variables
    const envCustomExtensions = this.getCustomExtensionsFromEnv();

    const supportedFromConfig = this.normalizeAndFilterExtensions(
      config.supportedExtensions || [],
      'supportedExtensions config'
    );
    const customFromConfig = this.normalizeAndFilterExtensions(
      config.customExtensions || [],
      'customExtensions config'
    );

    // Combine default extensions with config extensions and env extensions
    // Note: All sources are already lowercased (DEFAULT_SUPPORTED_EXTENSIONS is defined lowercase,
    // and all dynamic sources go through normalizeExtension() which calls toLowerCase())
    const allSupportedExtensions = [
      ...DEFAULT_SUPPORTED_EXTENSIONS,
      ...supportedFromConfig,
      ...customFromConfig,
      ...envCustomExtensions,
    ];
    // Remove duplicates
    this.supportedExtensions = [...new Set(allSupportedExtensions)];

    // Load custom ignore patterns from environment variables
    const envCustomIgnorePatterns = this.getCustomIgnorePatternsFromEnv();

    // Start with default ignore patterns
    const allIgnorePatterns = [
      ...DEFAULT_IGNORE_PATTERNS,
      ...(config.ignorePatterns || []),
      ...(config.customIgnorePatterns || []),
      ...envCustomIgnorePatterns,
    ];
    // Remove duplicates
    this.ignorePatterns = [...new Set(allIgnorePatterns)];

    this.maxFileSize = parseInt(envManager.get('CONTEXT_MAX_FILE_SIZE_BYTES') || '1000000', 10);

    console.log(
      `[Context] 🔧 Initialized with ${this.supportedExtensions.length} supported extensions and ${this.ignorePatterns.length} ignore patterns`
    );
    if (envCustomExtensions.length > 0) {
      console.log(
        `[Context] 📎 Loaded ${envCustomExtensions.length} custom extensions from environment: ${envCustomExtensions.join(', ')}`
      );
    }
    if (envCustomIgnorePatterns.length > 0) {
      console.log(
        `[Context] 🚫 Loaded ${envCustomIgnorePatterns.length} custom ignore patterns from environment: ${envCustomIgnorePatterns.join(', ')}`
      );
    }
  }

  /**
   * Get embedding instance
   */
  getEmbedding(): Embedding {
    return this.embedding;
  }

  /**
   * Get vector database instance
   */
  getVectorDatabase(): VectorDatabase {
    return this.vectorDatabase;
  }

  /**
   * Get code splitter instance
   */
  getCodeSplitter(): Splitter {
    return this.codeSplitter;
  }

  /**
   * Get supported extensions
   */
  getSupportedExtensions(): string[] {
    return [...this.supportedExtensions];
  }

  /**
   * Get ignore patterns
   */
  getIgnorePatterns(): string[] {
    return [...this.ignorePatterns];
  }

  /**
   * Get synchronizers map
   */
  getSynchronizers(): Map<string, FileSynchronizer> {
    return new Map(this.synchronizers);
  }

  /**
   * Set synchronizer for a collection
   */
  setSynchronizer(collectionName: string, synchronizer: FileSynchronizer): void {
    this.synchronizers.set(collectionName, synchronizer);
  }

  /**
   * Public wrapper for loadIgnorePatterns private method
   */
  async getLoadedIgnorePatterns(codebasePath: string): Promise<void> {
    return this.loadIgnorePatterns(codebasePath);
  }

  /**
   * Public wrapper for prepareCollection private method
   */
  async getPreparedCollection(codebasePath: string): Promise<void> {
    return this.prepareCollection(codebasePath);
  }

  /**
   * Get isHybrid setting from environment variable with default true
   */
  private getIsHybrid(): boolean {
    const isHybridEnv = envManager.get('HYBRID_MODE');
    if (isHybridEnv === undefined || isHybridEnv === null) {
      return true; // Default to true
    }
    return isHybridEnv.toLowerCase() === 'true';
  }

  /**
   * Generate collection name based on codebase path and hybrid mode
   */
  public getCollectionName(codebasePath: string): string {
    const isHybrid = this.getIsHybrid();
    const canonicalPath = resolveCanonicalPath(codebasePath);
    const hash = crypto.createHash('md5').update(canonicalPath).digest('hex');
    const prefix = isHybrid === true ? 'hybrid_code_chunks' : 'code_chunks';
    return `${prefix}_${hash.substring(0, 8)}`;
  }

  /**
   * Index a codebase for semantic search
   * @param codebasePath Codebase root path
   * @param progressCallback Optional progress callback function
   * @param forceReindex Whether to recreate the collection even if it exists
   * @returns Indexing statistics
   */
  async indexCodebase(
    codebasePath: string,
    progressCallback?: (progress: {
      phase: string;
      current: number;
      total: number;
      percentage: number;
    }) => void,
    forceReindex: boolean = false
  ): Promise<{ indexedFiles: number; totalChunks: number; status: 'completed' | 'limit_reached' }> {
    const readonlyMode = process.env.CONTEXT_READONLY_MODE;
    if (readonlyMode === '1' || readonlyMode === 'true') {
      throw new Error(
        'CONTEXT_READONLY_MODE is enabled. Indexing is disabled in this process. ' +
          'Use the singleton indexer daemon (--daemon) for indexing operations.'
      );
    }

    const isHybrid = this.getIsHybrid();
    const searchType = isHybrid === true ? 'hybrid search' : 'semantic search';
    console.log(`[Context] 🚀 Starting to index codebase with ${searchType}: ${codebasePath}`);

    // 1. Load ignore patterns from various ignore files
    await this.loadIgnorePatterns(codebasePath);

    // 1.5 Guardrail: refuse to index into an existing collection unless forceReindex is explicitly set.
    // This prevents accidental full re-indexing that would duplicate embeddings and increase costs.
    const collectionName = this.getCollectionName(codebasePath);
    const collectionExists = await this.vectorDatabase.hasCollection(collectionName);
    if (collectionExists && !forceReindex) {
      const message =
        `Index already exists for '${codebasePath}' (collection '${collectionName}'). ` +
        `Refusing to re-index to avoid duplicate embedding cost. ` +
        `Use reindexByChange(...) for incremental updates, or pass forceReindex=true to rebuild.`;
      console.warn(`[Context] ⚠️  ${message}`);
      throw new Error(message);
    }

    // 2. Check and prepare vector collection
    progressCallback?.({ phase: 'Preparing collection...', current: 0, total: 100, percentage: 0 });
    console.log(
      `Debug2: Preparing vector collection for codebase${forceReindex ? ' (FORCE REINDEX)' : ''}`
    );
    await this.prepareCollection(codebasePath, forceReindex);

    // 3. Recursively traverse codebase to get all supported files
    progressCallback?.({ phase: 'Scanning files...', current: 5, total: 100, percentage: 5 });
    const codeFiles = await this.getCodeFiles(codebasePath);
    console.log(`[Context] 📁 Found ${codeFiles.length} code files`);

    if (codeFiles.length === 0) {
      progressCallback?.({ phase: 'No files to index', current: 100, total: 100, percentage: 100 });
      return { indexedFiles: 0, totalChunks: 0, status: 'completed' };
    }

    // 3. Process each file with streaming chunk processing
    // Reserve 10% for preparation, 90% for actual indexing
    const indexingStartPercentage = 10;
    const indexingEndPercentage = 100;
    const indexingRange = indexingEndPercentage - indexingStartPercentage;

    const result = await this.processFileList(
      codeFiles,
      codebasePath,
      (filePath, fileIndex, totalFiles) => {
        // Calculate progress percentage
        const progressPercentage =
          indexingStartPercentage + (fileIndex / totalFiles) * indexingRange;

        console.log(`[Context] 📊 Processed ${fileIndex}/${totalFiles} files`);
        progressCallback?.({
          phase: `Processing files (${fileIndex}/${totalFiles})...`,
          current: fileIndex,
          total: totalFiles,
          percentage: Math.round(progressPercentage),
        });
      }
    );

    console.log(
      `[Context] ✅ Codebase indexing completed! Processed ${result.processedFiles} files in total, generated ${result.totalChunks} code chunks`
    );

    progressCallback?.({
      phase: 'Indexing complete!',
      current: result.processedFiles,
      total: codeFiles.length,
      percentage: 100,
    });

    return {
      indexedFiles: result.processedFiles,
      totalChunks: result.totalChunks,
      status: result.status,
    };
  }

  async reindexByChange(
    codebasePath: string,
    progressCallback?: (progress: {
      phase: string;
      current: number;
      total: number;
      percentage: number;
    }) => void,
    options: ReindexByChangeOptions = {}
  ): Promise<{ added: number; removed: number; modified: number }> {
    const readonlyMode = process.env.CONTEXT_READONLY_MODE;
    if (readonlyMode === '1' || readonlyMode === 'true') {
      console.warn(
        '[Context] CONTEXT_READONLY_MODE is enabled. Skipping reindexByChange(). ' +
          'Use the singleton indexer daemon (--daemon) for incremental sync.'
      );
      return { added: 0, removed: 0, modified: 0 };
    }

    const collectionName = this.getCollectionName(codebasePath);
    const synchronizer = this.synchronizers.get(collectionName);

    if (!synchronizer) {
      // Load project-specific ignore patterns before creating FileSynchronizer
      await this.loadIgnorePatterns(codebasePath);

      // To be safe, let's initialize if it's not there.
      const newSynchronizer = new FileSynchronizer(codebasePath, this.ignorePatterns);
      await newSynchronizer.initialize();
      this.synchronizers.set(collectionName, newSynchronizer);
    }

    const currentSynchronizer = this.synchronizers.get(collectionName)!;

    progressCallback?.({
      phase: 'Checking for file changes...',
      current: 0,
      total: 100,
      percentage: 0,
    });
    const { added, removed, modified } = await currentSynchronizer.checkForChanges();
    const totalDetectedChanges = added.length + removed.length + modified.length;

    if (totalDetectedChanges === 0) {
      progressCallback?.({
        phase: 'No changes detected',
        current: 100,
        total: 100,
        percentage: 100,
      });
      console.log('[Context] ✅ No file changes detected.');
      return { added: 0, removed: 0, modified: 0 };
    }

    console.log(
      `[Context] 🔄 Found changes: ${added.length} added, ${removed.length} removed, ${modified.length} modified.`
    );

    const includeModified = options.includeModified !== false;
    const candidateRelativePaths = includeModified ? [...added, ...modified] : [...added];
    const candidateAbsolutePaths = candidateRelativePaths.map((f) => path.join(codebasePath, f));

    const filesToIndex: string[] = [];
    let skippedUnsupported = 0;
    let skippedIgnored = 0;

    for (const fullPath of candidateAbsolutePaths) {
      const ext = path.extname(fullPath).toLowerCase();
      if (!this.supportedExtensions.includes(ext)) {
        skippedUnsupported++;
        continue;
      }
      if (this.matchesIgnorePattern(fullPath, codebasePath)) {
        skippedIgnored++;
        continue;
      }
      if (this.maxFileSize > 0) {
        try {
          const stat = await fs.promises.stat(fullPath);
          if (stat.size > this.maxFileSize) {
            skippedUnsupported++;
            continue;
          }
        } catch {
          /* file may have been deleted */
        }
      }
      filesToIndex.push(fullPath);
    }

    if (skippedUnsupported > 0 || skippedIgnored > 0) {
      console.log(
        `[Context] 🔎 Filtered changed files before embedding: candidates=${candidateAbsolutePaths.length}, eligible=${filesToIndex.length}, skippedUnsupported=${skippedUnsupported}, skippedIgnored=${skippedIgnored}`
      );
    }

    // Safety caps (token/cost guardrails): refuse to embed too many/too-large files in one run.
    const maxEmbedFiles =
      typeof options.maxEmbedFiles === 'number' && options.maxEmbedFiles > 0
        ? options.maxEmbedFiles
        : 200;
    const maxEmbedBytes =
      typeof options.maxEmbedBytes === 'number' && options.maxEmbedBytes > 0
        ? options.maxEmbedBytes
        : 2_000_000;
    const bypassCaps = options.bypassCaps === true;

    let eligibleBytes = 0;
    for (const filePath of filesToIndex) {
      try {
        const stat = fs.statSync(filePath);
        eligibleBytes += stat.size;
      } catch {
        // If we can't stat a file, treat it as 0 bytes for cap accounting; actual read will still fail later.
      }
    }

    if (!bypassCaps && (filesToIndex.length > maxEmbedFiles || eligibleBytes > maxEmbedBytes)) {
      const message =
        `SYNC_CAP_EXCEEDED: eligibleFiles=${filesToIndex.length}, eligibleBytes=${eligibleBytes}, ` +
        `maxEmbedFiles=${maxEmbedFiles}, maxEmbedBytes=${maxEmbedBytes}. ` +
        `Refusing to embed to avoid surprise costs. Increase caps or run with bypassCaps=true (admin-sync-force).`;
      console.warn(`[Context] ⚠️  ${message}`);
      throw new Error(message);
    }

    // Progress tracking: count actual work items (deletes + embeds), not raw change detections.
    // - Always delete for removed paths (even if unsupported/ignored) to prevent stale chunks.
    // - For modified paths:
    //   - includeModified=true: delete all modified paths (then eligible ones will be re-embedded).
    //   - includeModified=false: delete only those that are now ineligible (unsupported or ignored),
    //     so we don't intentionally stale out eligible code when the caller asked to skip modified.
    const removedToDelete = removed;
    const modifiedToDelete = includeModified
      ? modified
      : modified.filter((rel) => {
          const ext = path.extname(rel).toLowerCase();
          if (!this.supportedExtensions.includes(ext)) {
            return true;
          }
          const fullPath = path.join(codebasePath, rel);
          return this.matchesIgnorePattern(fullPath, codebasePath);
        });

    const totalWorkItems = removedToDelete.length + modifiedToDelete.length + filesToIndex.length;
    let processedWorkItems = 0;
    const updateProgress = (phase: string) => {
      processedWorkItems++;
      const percentage =
        totalWorkItems > 0 ? Math.round((processedWorkItems / totalWorkItems) * 100) : 100;
      progressCallback?.({
        phase,
        current: processedWorkItems,
        total: totalWorkItems,
        percentage: Math.min(100, Math.max(0, percentage)),
      });
    };

    // Handle removed files (delete all to prevent stale chunks, regardless of eligibility)
    for (const file of removedToDelete) {
      await this.deleteFileChunks(collectionName, file);
      updateProgress(`Removed ${file}`);
    }

    // Handle modified files (only those we are going to re-index)
    for (const file of modifiedToDelete) {
      await this.deleteFileChunks(collectionName, file);
      updateProgress(`Deleted old chunks for ${file}`);
    }

    // Handle added/modified files (eligible only)
    if (filesToIndex.length > 0) {
      await this.processFileList(filesToIndex, codebasePath, (filePath, fileIndex, totalFiles) => {
        updateProgress(`Indexed ${filePath} (${fileIndex}/${totalFiles})`);
      });
    } else if (candidateAbsolutePaths.length > 0) {
      console.log(`[Context] ℹ️  No eligible changed files to (re)index after filtering.`);
    }

    console.log(
      `[Context] ✅ Re-indexing complete. Added: ${added.length}, Removed: ${removed.length}, Modified: ${modified.length}`
    );
    progressCallback?.({
      phase: 'Re-indexing complete!',
      current: totalWorkItems,
      total: totalWorkItems,
      percentage: 100,
    });

    return { added: added.length, removed: removed.length, modified: modified.length };
  }

  private async deleteFileChunks(collectionName: string, relativePath: string): Promise<void> {
    // Escape backslashes for Milvus query expression (Windows path compatibility)
    const escapedPath = relativePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const results = await this.vectorDatabase.query(
      collectionName,
      `relativePath == "${escapedPath}"`,
      ['id']
    );

    if (results.length > 0) {
      const ids = results.map((r) => r.id as string).filter((id) => id);
      if (ids.length > 0) {
        await this.vectorDatabase.delete(collectionName, ids);
        console.log(`[Context] Deleted ${ids.length} chunks for file ${relativePath}`);
      }
    }
  }

  /**
   * Semantic search with unified implementation
   * @param codebasePath Codebase path to search in
   * @param query Search query
   * @param topK Number of results to return
   * @param threshold Similarity threshold
   */
  async semanticSearch(
    codebasePath: string,
    query: string,
    topK: number = 5,
    threshold: number = 0.5,
    filterExpr?: string
  ): Promise<SemanticSearchResult[]> {
    const isHybrid = this.getIsHybrid();
    const searchType = isHybrid === true ? 'hybrid search' : 'semantic search';
    console.log(`[Context] 🔍 Executing ${searchType}: "${query}" in ${codebasePath}`);

    const collectionName = this.getCollectionName(codebasePath);
    console.log(`[Context] 🔍 Using collection: ${collectionName}`);

    // Check if collection exists and has data
    const hasCollection = await this.vectorDatabase.hasCollection(collectionName);
    if (!hasCollection) {
      console.log(
        `[Context] ⚠️  Collection '${collectionName}' does not exist. Please index the codebase first.`
      );
      return [];
    }

    if (isHybrid === true) {
      try {
        // Check collection stats to see if it has data
        const stats = await this.vectorDatabase.query(collectionName, '', ['id'], 1);
        console.log(`[Context] 🔍 Collection '${collectionName}' exists and appears to have data`);
      } catch (error) {
        console.log(
          `[Context] ⚠️  Collection '${collectionName}' exists but may be empty or not properly indexed:`,
          error
        );
      }

      // 1. Generate query vector
      console.log(`[Context] 🔍 Generating embeddings for query: "${query}"`);
      const queryEmbedding: EmbeddingVector = await this.embedding.embed(query);
      console.log(
        `[Context] ✅ Generated embedding vector with dimension: ${queryEmbedding.vector.length}`
      );
      console.log(
        `[Context] 🔍 First 5 embedding values: [${queryEmbedding.vector.slice(0, 5).join(', ')}]`
      );

      // 2. Prepare hybrid search requests
      const searchRequests: HybridSearchRequest[] = [
        {
          data: queryEmbedding.vector,
          anns_field: 'vector',
          param: { nprobe: 10 },
          limit: topK,
        },
        {
          data: query,
          anns_field: 'sparse_vector',
          param: { drop_ratio_search: 0.2 },
          limit: topK,
        },
      ];

      console.log(
        `[Context] 🔍 Search request 1 (dense): anns_field="${searchRequests[0].anns_field}", vector_dim=${queryEmbedding.vector.length}, limit=${searchRequests[0].limit}`
      );
      console.log(
        `[Context] 🔍 Search request 2 (sparse): anns_field="${searchRequests[1].anns_field}", query_text="${query}", limit=${searchRequests[1].limit}`
      );

      // 3. Execute hybrid search
      console.log(`[Context] 🔍 Executing hybrid search with RRF reranking...`);
      const searchResults: HybridSearchResult[] = await this.vectorDatabase.hybridSearch(
        collectionName,
        searchRequests,
        {
          rerank: {
            strategy: 'rrf',
            params: { k: 100 },
          },
          limit: topK,
          filterExpr,
        }
      );

      console.log(`[Context] 🔍 Raw search results count: ${searchResults.length}`);

      // 4. Convert to semantic search result format
      const results: SemanticSearchResult[] = searchResults.map((result) => ({
        content: result.document.content,
        relativePath: result.document.relativePath,
        startLine: result.document.startLine,
        endLine: result.document.endLine,
        language: result.document.metadata.language || 'unknown',
        score: result.score,
      }));

      console.log(`[Context] ✅ Found ${results.length} relevant hybrid results`);
      if (results.length > 0) {
        console.log(
          `[Context] 🔍 Top result score: ${results[0].score}, path: ${results[0].relativePath}`
        );
      }

      return results;
    } else {
      // Regular semantic search
      // 1. Generate query vector
      const queryEmbedding: EmbeddingVector = await this.embedding.embed(query);

      // 2. Search in vector database
      const searchResults: VectorSearchResult[] = await this.vectorDatabase.search(
        collectionName,
        queryEmbedding.vector,
        { topK, threshold, filterExpr }
      );

      // 3. Convert to semantic search result format
      const results: SemanticSearchResult[] = searchResults.map((result) => ({
        content: result.document.content,
        relativePath: result.document.relativePath,
        startLine: result.document.startLine,
        endLine: result.document.endLine,
        language: result.document.metadata.language || 'unknown',
        score: result.score,
      }));

      console.log(`[Context] ✅ Found ${results.length} relevant results`);
      return results;
    }
  }

  /**
   * Check if index exists for codebase
   * @param codebasePath Codebase path to check
   * @returns Whether index exists
   */
  async hasIndex(codebasePath: string): Promise<boolean> {
    const collectionName = this.getCollectionName(codebasePath);
    return await this.vectorDatabase.hasCollection(collectionName);
  }

  /**
   * Clear index
   * @param codebasePath Codebase path to clear index for
   * @param progressCallback Optional progress callback function
   */
  async clearIndex(
    codebasePath: string,
    progressCallback?: (progress: {
      phase: string;
      current: number;
      total: number;
      percentage: number;
    }) => void
  ): Promise<void> {
    console.log(`[Context] 🧹 Cleaning index data for ${codebasePath}...`);

    progressCallback?.({
      phase: 'Checking existing index...',
      current: 0,
      total: 100,
      percentage: 0,
    });

    const collectionName = this.getCollectionName(codebasePath);
    const collectionExists = await this.vectorDatabase.hasCollection(collectionName);

    progressCallback?.({
      phase: 'Removing index data...',
      current: 50,
      total: 100,
      percentage: 50,
    });

    if (collectionExists) {
      await this.vectorDatabase.dropCollection(collectionName);
    }

    // Delete snapshot file
    await FileSynchronizer.deleteSnapshot(codebasePath);

    progressCallback?.({ phase: 'Index cleared', current: 100, total: 100, percentage: 100 });
    console.log('[Context] ✅ Index data cleaned');
  }

  /**
   * Update ignore patterns (merges with default patterns and existing patterns)
   * @param ignorePatterns Array of ignore patterns to add to defaults
   */
  updateIgnorePatterns(ignorePatterns: string[]): void {
    // Merge with default patterns and any existing custom patterns, avoiding duplicates
    const mergedPatterns = [...DEFAULT_IGNORE_PATTERNS, ...ignorePatterns];
    const uniquePatterns: string[] = [];
    const patternSet = new Set(mergedPatterns);
    patternSet.forEach((pattern) => uniquePatterns.push(pattern));
    this.ignorePatterns = uniquePatterns;
    console.log(
      `[Context] 🚫 Updated ignore patterns: ${ignorePatterns.length} new + ${DEFAULT_IGNORE_PATTERNS.length} default = ${this.ignorePatterns.length} total patterns`
    );
  }

  /**
   * Add custom ignore patterns (from MCP or other sources) without replacing existing ones
   * @param customPatterns Array of custom ignore patterns to add
   */
  addCustomIgnorePatterns(customPatterns: string[]): void {
    if (customPatterns.length === 0) return;

    // Merge current patterns with new custom patterns, avoiding duplicates
    const mergedPatterns = [...this.ignorePatterns, ...customPatterns];
    const uniquePatterns: string[] = [];
    const patternSet = new Set(mergedPatterns);
    patternSet.forEach((pattern) => uniquePatterns.push(pattern));
    this.ignorePatterns = uniquePatterns;
    console.log(
      `[Context] 🚫 Added ${customPatterns.length} custom ignore patterns. Total: ${this.ignorePatterns.length} patterns`
    );
  }

  /**
   * Reset ignore patterns to defaults only
   */
  resetIgnorePatternsToDefaults(): void {
    this.ignorePatterns = [...DEFAULT_IGNORE_PATTERNS];
    console.log(
      `[Context] 🔄 Reset ignore patterns to defaults: ${this.ignorePatterns.length} patterns`
    );
  }

  /**
   * Update embedding instance
   * @param embedding New embedding instance
   */
  updateEmbedding(embedding: Embedding): void {
    this.embedding = embedding;
    console.log(`[Context] 🔄 Updated embedding provider: ${embedding.getProvider()}`);
  }

  /**
   * Update vector database instance
   * @param vectorDatabase New vector database instance
   */
  updateVectorDatabase(vectorDatabase: VectorDatabase): void {
    this.vectorDatabase = vectorDatabase;
    console.log(`[Context] 🔄 Updated vector database`);
  }

  /**
   * Update splitter instance
   * @param splitter New splitter instance
   */
  updateSplitter(splitter: Splitter): void {
    this.codeSplitter = splitter;
    console.log(`[Context] 🔄 Updated splitter instance`);
  }

  /**
   * Prepare vector collection
   */
  private async prepareCollection(
    codebasePath: string,
    forceReindex: boolean = false
  ): Promise<void> {
    const isHybrid = this.getIsHybrid();
    const collectionType = isHybrid === true ? 'hybrid vector' : 'vector';
    console.log(
      `[Context] 🔧 Preparing ${collectionType} collection for codebase: ${codebasePath}${forceReindex ? ' (FORCE REINDEX)' : ''}`
    );
    const collectionName = this.getCollectionName(codebasePath);

    // Check if collection already exists
    const collectionExists = await this.vectorDatabase.hasCollection(collectionName);

    if (collectionExists && !forceReindex) {
      console.log(`📋 Collection ${collectionName} already exists, skipping creation`);
      return;
    }

    if (collectionExists && forceReindex) {
      console.log(
        `[Context] 🗑️  Dropping existing collection ${collectionName} for force reindex...`
      );
      await this.vectorDatabase.dropCollection(collectionName);
      console.log(`[Context] ✅ Collection ${collectionName} dropped successfully`);
    }

    console.log(
      `[Context] 🔍 Detecting embedding dimension for ${this.embedding.getProvider()} provider...`
    );
    const dimension = await this.embedding.detectDimension();
    console.log(
      `[Context] 📏 Detected dimension: ${dimension} for ${this.embedding.getProvider()}`
    );
    const dirName = path.basename(codebasePath);

    if (isHybrid === true) {
      await this.vectorDatabase.createHybridCollection(
        collectionName,
        dimension,
        `Hybrid Index for ${dirName}`
      );
    } else {
      await this.vectorDatabase.createCollection(collectionName, dimension, `Index for ${dirName}`);
    }

    console.log(
      `[Context] ✅ Collection ${collectionName} created successfully (dimension: ${dimension})`
    );
  }

  /**
   * Recursively get all code files in the codebase
   */
  private async getCodeFiles(codebasePath: string): Promise<string[]> {
    const files: string[] = [];

    const traverseDirectory = async (currentPath: string) => {
      const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        // Align with FileSynchronizer: never traverse hidden files/directories.
        if (entry.name.startsWith('.')) {
          continue;
        }

        const fullPath = path.join(currentPath, entry.name);

        // Check if path matches ignore patterns
        if (this.matchesIgnorePattern(fullPath, codebasePath)) {
          continue;
        }

        if (entry.isDirectory()) {
          await traverseDirectory(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (this.supportedExtensions.includes(ext)) {
            if (this.maxFileSize > 0) {
              try {
                const stat = await fs.promises.stat(fullPath);
                if (stat.size > this.maxFileSize) {
                  console.warn(
                    `[Context] ⚠️ Skipping oversized file (${Math.round(stat.size / 1024)}KB): ${fullPath}`
                  );
                  continue;
                }
              } catch (error) {
                console.warn(`[Context] ⚠️ Could not stat file, skipping: ${fullPath}`, error);
                continue;
              }
            }
            files.push(fullPath);
          }
        }
      }
    };

    await traverseDirectory(codebasePath);
    return files;
  }

  /**
   * Process a list of files with streaming chunk processing
   * @param filePaths Array of file paths to process
   * @param codebasePath Base path for the codebase
   * @param onFileProcessed Callback called when each file is processed
   * @returns Object with processed file count and total chunk count
   */
  private async processFileList(
    filePaths: string[],
    codebasePath: string,
    onFileProcessed?: (filePath: string, fileIndex: number, totalFiles: number) => void
  ): Promise<{
    processedFiles: number;
    totalChunks: number;
    status: 'completed' | 'limit_reached';
  }> {
    const isHybrid = this.getIsHybrid();
    const EMBEDDING_BATCH_SIZE = Math.max(
      1,
      parseInt(envManager.get('EMBEDDING_BATCH_SIZE') || '100', 10)
    );
    const CHUNK_LIMIT = 450000;
    const EMBEDDING_BATCH_DELAY_MS = Math.max(
      0,
      parseInt(envManager.get('EMBEDDING_BATCH_DELAY_MS') || '0', 10)
    );
    console.log(`[Context] 🔧 Using EMBEDDING_BATCH_SIZE: ${EMBEDDING_BATCH_SIZE}`);

    let chunkBuffer: Array<{ chunk: CodeChunk; codebasePath: string }> = [];
    let processedFiles = 0;
    let totalChunks = 0;
    let failedChunks = 0;
    let limitReached = false;

    for (let i = 0; i < filePaths.length; i++) {
      const filePath = filePaths[i];

      try {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        const language = this.getLanguageFromExtension(path.extname(filePath));
        const chunks = await this.codeSplitter.split(content, language, filePath);

        // Log files with many chunks or large content
        if (chunks.length > 50) {
          console.warn(
            `[Context] ⚠️  File ${filePath} generated ${chunks.length} chunks (${Math.round(content.length / 1024)}KB)`
          );
        } else if (content.length > 100000) {
          console.log(
            `📄 Large file ${filePath}: ${Math.round(content.length / 1024)}KB -> ${chunks.length} chunks`
          );
        }

        // Add chunks to buffer
        for (const chunk of chunks) {
          chunkBuffer.push({ chunk, codebasePath });

          // Process batch when buffer reaches EMBEDDING_BATCH_SIZE
          if (chunkBuffer.length >= EMBEDDING_BATCH_SIZE) {
            const batchToProcess = [...chunkBuffer];
            chunkBuffer = [];
            try {
              const successful = await this.processChunkBufferWithRetry(batchToProcess);
              totalChunks += successful;
              if (successful < batchToProcess.length) {
                failedChunks += batchToProcess.length - successful;
              }
            } catch (error) {
              failedChunks += batchToProcess.length;
              const searchType = isHybrid === true ? 'hybrid' : 'regular';
              console.error(
                `[Context] ❌ Permanently failed batch of ${batchToProcess.length} chunks for ${searchType}:`,
                error
              );
            }
            if (EMBEDDING_BATCH_DELAY_MS > 0) {
              await new Promise((resolve) => setTimeout(resolve, EMBEDDING_BATCH_DELAY_MS));
            }
          }

          // Check if chunk limit is reached
          if (totalChunks + failedChunks >= CHUNK_LIMIT) {
            console.warn(`[Context] ⚠️  Chunk limit of ${CHUNK_LIMIT} reached. Stopping indexing.`);
            limitReached = true;
            break; // Exit the inner loop (over chunks)
          }
        }

        processedFiles++;
        onFileProcessed?.(filePath, i + 1, filePaths.length);

        if (limitReached) {
          break; // Exit the outer loop (over files)
        }
      } catch (error) {
        console.warn(`[Context] ⚠️  Skipping file ${filePath}: ${error}`);
      }
    }

    // Process any remaining chunks in the buffer
    if (chunkBuffer.length > 0) {
      const searchType = isHybrid === true ? 'hybrid' : 'regular';
      console.log(`📝 Processing final batch of ${chunkBuffer.length} chunks for ${searchType}`);
      try {
        const successful = await this.processChunkBufferWithRetry(chunkBuffer);
        totalChunks += successful;
        if (successful < chunkBuffer.length) {
          failedChunks += chunkBuffer.length - successful;
        }
      } catch (error) {
        failedChunks += chunkBuffer.length;
        console.error(
          `[Context] ❌ Permanently failed final batch of ${chunkBuffer.length} chunks:`,
          error
        );
      }
    }

    if (failedChunks > 0) {
      console.error(`[Context] ⚠️ ${failedChunks} chunks failed permanently and were not indexed`);
    }

    return {
      processedFiles,
      totalChunks,
      status: limitReached ? 'limit_reached' : 'completed',
    };
  }

  /**
   * Process accumulated chunk buffer
   */
  private async processChunkBuffer(
    chunkBuffer: Array<{ chunk: CodeChunk; codebasePath: string }>
  ): Promise<void> {
    if (chunkBuffer.length === 0) return;

    // Extract chunks and ensure they all have the same codebasePath
    const chunks = chunkBuffer.map((item) => item.chunk);
    const codebasePath = chunkBuffer[0].codebasePath;

    // Estimate tokens (rough estimation: 1 token ≈ 4 characters)
    const estimatedTokens = chunks.reduce(
      (sum, chunk) => sum + Math.ceil(chunk.content.length / 4),
      0
    );

    const isHybrid = this.getIsHybrid();
    const searchType = isHybrid === true ? 'hybrid' : 'regular';
    console.log(
      `[Context] 🔄 Processing batch of ${chunks.length} chunks (~${estimatedTokens} tokens) for ${searchType}`
    );
    await this.processChunkBatch(chunks, codebasePath);
  }

  /**
   * Process chunk buffer with bisecting retry on failure.
   * On failure, splits the batch in half and retries each half recursively.
   * By default, max recursion depth is derived from the initial batch size.
   * Milvus upserts on duplicate PKs, so partial retries are safe.
   */
  private async processChunkBufferWithRetry(
    chunkBuffer: Array<{ chunk: CodeChunk; codebasePath: string }>,
    maxRetries?: number
  ): Promise<number> {
    const retriesRemaining = maxRetries ?? Math.ceil(Math.log2(Math.max(chunkBuffer.length, 1)));

    try {
      await this.processChunkBuffer(chunkBuffer);
      return chunkBuffer.length;
    } catch (error) {
      // If leaf node or retries exhausted, rethrow (parent will catch or it will bubble up)
      if (retriesRemaining <= 0 || chunkBuffer.length <= 1) throw error;

      console.warn(`[Context] Batch of ${chunkBuffer.length} failed, bisecting for retry...`);
      const mid = Math.ceil(chunkBuffer.length / 2);
      const firstHalf = chunkBuffer.slice(0, mid);
      const secondHalf = chunkBuffer.slice(mid);

      let successCount = 0;

      // Try first half
      try {
        successCount += await this.processChunkBufferWithRetry(firstHalf, retriesRemaining - 1);
      } catch (e) {
        console.warn(`[Context] First half of batch failed: ${e}`);
        // First half failed completely, continue to second half
      }

      // Try second half
      try {
        successCount += await this.processChunkBufferWithRetry(secondHalf, retriesRemaining - 1);
      } catch (e) {
        console.warn(`[Context] Second half of batch failed: ${e}`);
        // Second half failed completely
      }

      // If we processed *some* chunks, return the count.
      // If successCount is 0, it means BOTH halves failed.
      // In that case, we should probably throw the original error to indicate total failure,
      // OR just return 0 if we want to suppress it.
      // Let's throw the original error if 0 success, so the top level logs it as "Permanently failed".
      if (successCount === 0) throw error;

      return successCount;
    }
  }

  /**
   * Process a batch of chunks
   */
  private async processChunkBatch(chunks: CodeChunk[], codebasePath: string): Promise<void> {
    const isHybrid = this.getIsHybrid();

    // Generate embedding vectors
    const chunkContents = chunks.map((chunk) => chunk.content);
    const embeddings = await this.embedding.embedBatch(chunkContents);

    if (isHybrid === true) {
      // Create hybrid vector documents
      const documents: VectorDocument[] = chunks.map((chunk, index) => {
        if (!chunk.metadata.filePath) {
          throw new Error(`Missing filePath in chunk metadata at index ${index}`);
        }

        const relativePath = path.relative(codebasePath, chunk.metadata.filePath);
        const fileExtension = path.extname(chunk.metadata.filePath).toLowerCase();
        const { filePath, startLine, endLine, ...restMetadata } = chunk.metadata;

        return {
          id: this.generateId(
            relativePath,
            chunk.metadata.startLine || 0,
            chunk.metadata.endLine || 0,
            chunk.content
          ),
          content: chunk.content, // Full text content for BM25 and storage
          vector: embeddings[index].vector, // Dense vector
          relativePath,
          startLine: chunk.metadata.startLine || 0,
          endLine: chunk.metadata.endLine || 0,
          fileExtension,
          metadata: {
            ...restMetadata,
            codebasePath: resolveCanonicalPath(codebasePath),
            language: chunk.metadata.language || 'unknown',
            chunkIndex: index,
          },
        };
      });

      // Store to vector database
      await this.vectorDatabase.insertHybrid(this.getCollectionName(codebasePath), documents);
    } else {
      // Create regular vector documents
      const documents: VectorDocument[] = chunks.map((chunk, index) => {
        if (!chunk.metadata.filePath) {
          throw new Error(`Missing filePath in chunk metadata at index ${index}`);
        }

        const relativePath = path.relative(codebasePath, chunk.metadata.filePath);
        const fileExtension = path.extname(chunk.metadata.filePath).toLowerCase();
        const { filePath, startLine, endLine, ...restMetadata } = chunk.metadata;

        return {
          id: this.generateId(
            relativePath,
            chunk.metadata.startLine || 0,
            chunk.metadata.endLine || 0,
            chunk.content
          ),
          vector: embeddings[index].vector,
          content: chunk.content,
          relativePath,
          startLine: chunk.metadata.startLine || 0,
          endLine: chunk.metadata.endLine || 0,
          fileExtension,
          metadata: {
            ...restMetadata,
            codebasePath: resolveCanonicalPath(codebasePath),
            language: chunk.metadata.language || 'unknown',
            chunkIndex: index,
          },
        };
      });

      // Store to vector database
      await this.vectorDatabase.insert(this.getCollectionName(codebasePath), documents);
    }
  }

  /**
   * Get programming language based on file extension
   */
  private getLanguageFromExtension(ext: string): string {
    const normalizedExt = ext.toLowerCase();
    const languageMap: Record<string, string> = {
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.py': 'python',
      '.java': 'java',
      '.cpp': 'cpp',
      '.c': 'c',
      '.h': 'c',
      '.hpp': 'cpp',
      '.cs': 'csharp',
      '.go': 'go',
      '.rs': 'rust',
      '.php': 'php',
      '.rb': 'ruby',
      '.swift': 'swift',
      '.kt': 'kotlin',
      '.scala': 'scala',
      '.m': 'objective-c',
      '.mm': 'objective-c',
    };
    return languageMap[normalizedExt] || 'text';
  }

  /**
   * Generate unique ID based on chunk content and location
   * @param relativePath Relative path to the file
   * @param startLine Start line number
   * @param endLine End line number
   * @param content Chunk content
   * @returns Hash-based unique ID
   */
  private generateId(
    relativePath: string,
    startLine: number,
    endLine: number,
    content: string
  ): string {
    const combinedString = `${relativePath}:${startLine}:${endLine}:${content}`;
    const hash = crypto.createHash('sha256').update(combinedString, 'utf-8').digest('hex');
    return `chunk_${hash.substring(0, 16)}`;
  }

  /**
   * Read ignore patterns from file (e.g., .gitignore)
   * @param filePath Path to the ignore file
   * @returns Array of ignore patterns
   */
  static async getIgnorePatternsFromFile(filePath: string): Promise<string[]> {
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      return content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#')); // Filter out empty lines and comments
    } catch (error) {
      console.warn(`[Context] ⚠️  Could not read ignore file ${filePath}: ${error}`);
      return [];
    }
  }

  /**
   * Load ignore patterns from various ignore files in the codebase
   * This method preserves any existing custom patterns that were added before
   * @param codebasePath Path to the codebase
   */
  private async loadIgnorePatterns(codebasePath: string): Promise<void> {
    try {
      let fileBasedPatterns: string[] = [];

      // Load all .xxxignore files in codebase directory
      const ignoreFiles = await this.findIgnoreFiles(codebasePath);
      for (const ignoreFile of ignoreFiles) {
        const patterns = await this.loadIgnoreFile(ignoreFile, path.basename(ignoreFile));
        fileBasedPatterns.push(...patterns);
      }

      // Load global ~/.context/.contextignore
      const globalIgnorePatterns = await this.loadGlobalIgnoreFile();
      fileBasedPatterns.push(...globalIgnorePatterns);

      // Merge file-based patterns with existing patterns (which may include custom MCP patterns)
      if (fileBasedPatterns.length > 0) {
        this.addCustomIgnorePatterns(fileBasedPatterns);
        console.log(
          `[Context] 🚫 Loaded total ${fileBasedPatterns.length} ignore patterns from all ignore files`
        );
      } else {
        console.log('📄 No ignore files found, keeping existing patterns');
      }
    } catch (error) {
      console.warn(`[Context] ⚠️ Failed to load ignore patterns: ${error}`);
      // Continue with existing patterns on error - don't reset them
    }
  }

  /**
   * Find all .xxxignore files in the codebase directory
   * @param codebasePath Path to the codebase
   * @returns Array of ignore file paths
   */
  private async findIgnoreFiles(codebasePath: string): Promise<string[]> {
    try {
      const entries = await fs.promises.readdir(codebasePath, { withFileTypes: true });
      const ignoreFiles: string[] = [];

      for (const entry of entries) {
        if (entry.isFile() && entry.name.startsWith('.') && entry.name.endsWith('ignore')) {
          ignoreFiles.push(path.join(codebasePath, entry.name));
        }
      }

      if (ignoreFiles.length > 0) {
        console.log(
          `📄 Found ignore files: ${ignoreFiles.map((f) => path.basename(f)).join(', ')}`
        );
      }

      return ignoreFiles;
    } catch (error) {
      console.warn(`[Context] ⚠️ Failed to scan for ignore files: ${error}`);
      return [];
    }
  }

  /**
   * Load global ignore file from ~/.context/.contextignore
   * @returns Array of ignore patterns
   */
  private async loadGlobalIgnoreFile(): Promise<string[]> {
    try {
      const homeDir = require('os').homedir();
      const globalIgnorePath = path.join(homeDir, '.context', '.contextignore');
      return await this.loadIgnoreFile(globalIgnorePath, 'global .contextignore');
    } catch (error) {
      // Global ignore file is optional, don't log warnings
      return [];
    }
  }

  /**
   * Load ignore patterns from a specific ignore file
   * @param filePath Path to the ignore file
   * @param fileName Display name for logging
   * @returns Array of ignore patterns
   */
  private async loadIgnoreFile(filePath: string, fileName: string): Promise<string[]> {
    try {
      await fs.promises.access(filePath);
      console.log(`📄 Found ${fileName} file at: ${filePath}`);

      const ignorePatterns = await Context.getIgnorePatternsFromFile(filePath);

      if (ignorePatterns.length > 0) {
        console.log(
          `[Context] 🚫 Loaded ${ignorePatterns.length} ignore patterns from ${fileName}`
        );
        return ignorePatterns;
      } else {
        console.log(`📄 ${fileName} file found but no valid patterns detected`);
        return [];
      }
    } catch (error) {
      if (fileName.includes('global')) {
        console.log(`📄 No ${fileName} file found`);
      }
      return [];
    }
  }

  /**
   * Check if a path matches any ignore pattern
   * @param filePath Path to check
   * @param basePath Base path for relative pattern matching
   * @returns True if path should be ignored
   */
  private matchesIgnorePattern(filePath: string, basePath: string): boolean {
    if (this.ignorePatterns.length === 0) {
      return false;
    }

    const relativePath = path.relative(basePath, filePath);
    const normalizedPath = relativePath.replace(/\\/g, '/'); // Normalize path separators

    // Always ignore hidden files and directories (e.g. .git, .env, .vscode).
    if (normalizedPath) {
      const parts = normalizedPath.split('/');
      if (parts.some((part) => part.startsWith('.') && part.length > 1)) {
        return true;
      }
    }

    for (const pattern of this.ignorePatterns) {
      if (this.isPatternMatch(normalizedPath, pattern)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Simple glob pattern matching
   * @param filePath File path to test
   * @param pattern Glob pattern
   * @returns True if pattern matches
   */
  private isPatternMatch(filePath: string, pattern: string): boolean {
    // Handle directory patterns (ending with /)
    if (pattern.endsWith('/')) {
      const dirPattern = pattern.slice(0, -1);
      const pathParts = filePath.split('/');
      return pathParts.some((part) => this.simpleGlobMatch(part, dirPattern));
    }

    // Handle file patterns
    if (pattern.includes('/')) {
      // Pattern with path separator - match exact path
      return this.simpleGlobMatch(filePath, pattern);
    } else {
      // Pattern without path separator - match filename in any directory
      const fileName = path.basename(filePath);
      return this.simpleGlobMatch(fileName, pattern);
    }
  }

  /**
   * Simple glob matching supporting * wildcard
   * @param text Text to test
   * @param pattern Pattern with * wildcards
   * @returns True if pattern matches
   */
  private simpleGlobMatch(text: string, pattern: string): boolean {
    // Convert glob pattern to regex
    const regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex special chars except *
      .replace(/\*/g, '.*'); // Convert * to .*

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(text);
  }

  /**
   * Get custom extensions from environment variables
   * Supports CUSTOM_EXTENSIONS as comma-separated list
   * @returns Array of custom extensions
   */
  private getCustomExtensionsFromEnv(): string[] {
    const envExtensions = envManager.get('CUSTOM_EXTENSIONS');
    if (!envExtensions) {
      return [];
    }

    try {
      const rawExtensions = envExtensions
        .split(',')
        .map((ext) => ext.trim())
        .filter((ext) => ext.length > 0);

      return this.normalizeAndFilterExtensions(rawExtensions, 'CUSTOM_EXTENSIONS');
    } catch (error) {
      console.warn(`[Context] ⚠️  Failed to parse CUSTOM_EXTENSIONS: ${error}`);
      return [];
    }
  }

  /**
   * Get custom ignore patterns from environment variables
   * Supports CUSTOM_IGNORE_PATTERNS as comma-separated list
   * @returns Array of custom ignore patterns
   */
  private getCustomIgnorePatternsFromEnv(): string[] {
    const envIgnorePatterns = envManager.get('CUSTOM_IGNORE_PATTERNS');
    if (!envIgnorePatterns) {
      return [];
    }

    try {
      const patterns = envIgnorePatterns
        .split(',')
        .map((pattern) => pattern.trim())
        .filter((pattern) => pattern.length > 0);

      return patterns;
    } catch (error) {
      console.warn(`[Context] ⚠️  Failed to parse CUSTOM_IGNORE_PATTERNS: ${error}`);
      return [];
    }
  }

  /**
   * Add custom extensions (from MCP or other sources) without replacing existing ones
   * @param customExtensions Array of custom extensions to add
   */
  addCustomExtensions(customExtensions: string[]): void {
    const normalizedExtensions = this.normalizeAndFilterExtensions(
      customExtensions,
      'addCustomExtensions()'
    );
    if (normalizedExtensions.length === 0) return;

    // Merge current extensions with new custom extensions, avoiding duplicates
    const mergedExtensions = [...this.supportedExtensions, ...normalizedExtensions];
    const uniqueExtensions: string[] = [...new Set(mergedExtensions)];
    this.supportedExtensions = uniqueExtensions;
    console.log(
      `[Context] 📎 Added ${normalizedExtensions.length} custom extensions. Total: ${this.supportedExtensions.length} extensions`
    );
  }

  private areDocExtensionsAllowed(): boolean {
    return envManager.isTruthy('CONTEXT_ALLOW_DOC_EXTENSIONS');
  }

  private normalizeAndFilterExtensions(extensions: string[], source: string): string[] {
    const normalized = extensions
      .map((ext) => normalizeExtension(ext))
      .filter((ext) => ext.length > 1);
    const unique = [...new Set(normalized)];
    if (unique.length === 0) return [];

    if (this.areDocExtensionsAllowed()) {
      return unique;
    }

    const blocked = unique.filter((ext) => DOC_EXTENSIONS.has(ext));
    if (blocked.length > 0) {
      console.warn(
        `[Context] ⚠️  Blocked documentation extensions from ${source}: ${blocked.join(', ')}. ` +
          `Set CONTEXT_ALLOW_DOC_EXTENSIONS=1 to allow them intentionally.`
      );
    }

    return unique.filter((ext) => !DOC_EXTENSIONS.has(ext));
  }

  /**
   * Get current splitter information
   */
  getSplitterInfo(): { type: string; hasBuiltinFallback: boolean; supportedLanguages?: string[] } {
    const splitterName = this.codeSplitter.constructor.name;

    if (splitterName === 'AstCodeSplitter') {
      const { AstCodeSplitter } = require('./splitter/ast-splitter');
      return {
        type: 'ast',
        hasBuiltinFallback: true,
        supportedLanguages: AstCodeSplitter.getSupportedLanguages(),
      };
    } else {
      return {
        type: 'langchain',
        hasBuiltinFallback: false,
      };
    }
  }

  /**
   * Check if current splitter supports a specific language
   * @param language Programming language
   */
  isLanguageSupported(language: string): boolean {
    const splitterName = this.codeSplitter.constructor.name;

    if (splitterName === 'AstCodeSplitter') {
      const { AstCodeSplitter } = require('./splitter/ast-splitter');
      return AstCodeSplitter.isLanguageSupported(language);
    }

    // LangChain splitter supports most languages
    return true;
  }

  /**
   * Get which strategy would be used for a specific language
   * @param language Programming language
   */
  getSplitterStrategyForLanguage(language: string): {
    strategy: 'ast' | 'langchain';
    reason: string;
  } {
    const splitterName = this.codeSplitter.constructor.name;

    if (splitterName === 'AstCodeSplitter') {
      const { AstCodeSplitter } = require('./splitter/ast-splitter');
      const isSupported = AstCodeSplitter.isLanguageSupported(language);

      return {
        strategy: isSupported ? 'ast' : 'langchain',
        reason: isSupported
          ? 'Language supported by AST parser'
          : 'Language not supported by AST, will fallback to LangChain',
      };
    } else {
      return {
        strategy: 'langchain',
        reason: 'Using LangChain splitter directly',
      };
    }
  }
}
