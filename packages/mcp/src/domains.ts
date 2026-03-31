/**
 * Domain definitions for semantic code indexing and search.
 *
 * Domains help optimize embedding model selection and search queries
 * based on the content type being indexed or searched.
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Domain identifier type for type safety
 */
export type DomainId =
  | 'code'
  | 'documentation'
  | 'api'
  | 'test'
  | 'config'
  | 'data'
  | 'infrastructure'
  | 'frontend'
  | 'backend';

/**
 * Embedding provider recommendation based on domain characteristics
 */
export interface EmbeddingRecommendation {
  provider: 'VoyageAI' | 'OpenAI' | 'Gemini' | 'Ollama';
  model: string;
  reason: string;
}

/**
 * Domain definition with metadata for indexing optimization
 */
export interface DomainDefinition {
  /** Unique domain identifier */
  id: DomainId;
  /** Human-readable display name */
  name: string;
  /** Description of what this domain covers */
  description: string;
  /** File extensions typically associated with this domain */
  fileExtensions: string[];
  /** Directory patterns that indicate this domain */
  directoryPatterns: string[];
  /** Filename patterns (regex) that match this domain */
  filenamePatterns: RegExp[];
  /** Keywords commonly found in this domain's content */
  keywords: string[];
  /** Recommended embedding configuration for this domain */
  embeddingRecommendation: EmbeddingRecommendation;
  /** Weight for search relevance scoring (0.0 - 1.0) */
  searchWeight: number;
  /** Whether this domain should be prioritized in hybrid search */
  prioritizeInHybridSearch: boolean;
}

// ============================================================================
// Domain Definitions (9 domains)
// ============================================================================

/**
 * Code domain - Core programming logic and implementations
 */
export const CODE_DOMAIN: DomainDefinition = {
  id: 'code',
  name: 'Code',
  description: 'Core programming logic, functions, classes, and implementations',
  fileExtensions: [
    '.ts',
    '.js',
    '.tsx',
    '.jsx',
    '.py',
    '.java',
    '.go',
    '.rs',
    '.cpp',
    '.c',
    '.cs',
    '.scala',
    '.rb',
    '.php',
    '.swift',
    '.kt',
  ],
  directoryPatterns: ['src', 'lib', 'packages', 'modules', 'core'],
  filenamePatterns: [/^(?!.*\.(test|spec|config|d)\.).*\.(ts|js|py|java|go|rs)$/i],
  keywords: [
    'function',
    'class',
    'interface',
    'export',
    'import',
    'async',
    'await',
    'return',
    'const',
    'let',
    'var',
  ],
  embeddingRecommendation: {
    provider: 'VoyageAI',
    model: 'voyage-code-3',
    reason:
      'Voyage Code 3 is optimized for code retrieval with deep understanding of programming constructs',
  },
  searchWeight: 1.0,
  prioritizeInHybridSearch: true,
};

/**
 * Documentation domain - README, guides, and explanatory content
 */
export const DOCUMENTATION_DOMAIN: DomainDefinition = {
  id: 'documentation',
  name: 'Documentation',
  description: 'README files, guides, tutorials, and explanatory markdown content',
  fileExtensions: ['.md', '.mdx', '.rst', '.txt', '.adoc'],
  directoryPatterns: ['docs', 'documentation', 'wiki', 'guides', 'tutorials'],
  filenamePatterns: [/^readme/i, /^contributing/i, /^changelog/i, /^license/i, /\.md$/i],
  keywords: [
    '## ',
    '# ',
    '```',
    '- [ ]',
    '- [x]',
    'installation',
    'usage',
    'getting started',
    'overview',
  ],
  embeddingRecommendation: {
    provider: 'VoyageAI',
    model: 'voyage-3-large',
    reason: 'Voyage 3 Large excels at natural language understanding for documentation',
  },
  searchWeight: 0.9,
  prioritizeInHybridSearch: true,
};

/**
 * API domain - API definitions, schemas, and endpoint specifications
 */
export const API_DOMAIN: DomainDefinition = {
  id: 'api',
  name: 'API',
  description: 'API definitions, OpenAPI specs, GraphQL schemas, and endpoint handlers',
  fileExtensions: ['.yaml', '.yml', '.json', '.graphql', '.gql', '.proto'],
  directoryPatterns: ['api', 'routes', 'endpoints', 'handlers', 'controllers', 'schemas'],
  filenamePatterns: [/openapi/i, /swagger/i, /schema\./i, /\.api\./i, /routes?\./i],
  keywords: [
    'endpoint',
    'GET',
    'POST',
    'PUT',
    'DELETE',
    'PATCH',
    'query',
    'mutation',
    'resolver',
    'handler',
    'route',
  ],
  embeddingRecommendation: {
    provider: 'VoyageAI',
    model: 'voyage-code-3',
    reason: 'API definitions benefit from code-aware embeddings that understand schema structures',
  },
  searchWeight: 0.95,
  prioritizeInHybridSearch: true,
};

/**
 * Test domain - Unit tests, integration tests, and test utilities
 */
export const TEST_DOMAIN: DomainDefinition = {
  id: 'test',
  name: 'Test',
  description: 'Unit tests, integration tests, e2e tests, and test utilities',
  fileExtensions: ['.test.ts', '.test.js', '.spec.ts', '.spec.js', '.test.tsx', '.test.jsx'],
  directoryPatterns: ['tests', 'test', '__tests__', 'spec', 'specs', 'e2e', 'integration'],
  filenamePatterns: [/\.(test|spec)\./i, /test[_-]?/i, /_test\./i],
  keywords: [
    'describe',
    'it',
    'test',
    'expect',
    'assert',
    'mock',
    'spy',
    'beforeEach',
    'afterEach',
    'jest',
    'vitest',
  ],
  embeddingRecommendation: {
    provider: 'VoyageAI',
    model: 'voyage-code-3',
    reason: 'Test code benefits from code-optimized embeddings for understanding test patterns',
  },
  searchWeight: 0.7,
  prioritizeInHybridSearch: false,
};

/**
 * Config domain - Configuration files and environment settings
 */
export const CONFIG_DOMAIN: DomainDefinition = {
  id: 'config',
  name: 'Configuration',
  description: 'Configuration files, environment settings, and build configurations',
  fileExtensions: ['.json', '.yaml', '.yml', '.toml', '.ini', '.env', '.config.js', '.config.ts'],
  directoryPatterns: ['config', 'configs', 'settings', '.config'],
  filenamePatterns: [
    /config\./i,
    /\.config\./i,
    /settings\./i,
    /\.env/i,
    /tsconfig/i,
    /package\.json/i,
  ],
  keywords: [
    'env',
    'config',
    'settings',
    'options',
    'port',
    'host',
    'database',
    'api_key',
    'secret',
  ],
  embeddingRecommendation: {
    provider: 'OpenAI',
    model: 'text-embedding-3-small',
    reason: 'Configuration files are simpler structures where cost-effective embeddings work well',
  },
  searchWeight: 0.6,
  prioritizeInHybridSearch: false,
};

/**
 * Data domain - Data files, migrations, and fixtures
 */
export const DATA_DOMAIN: DomainDefinition = {
  id: 'data',
  name: 'Data',
  description: 'Data files, database migrations, seeds, and fixtures',
  fileExtensions: ['.sql', '.json', '.csv', '.xml'],
  directoryPatterns: ['data', 'migrations', 'seeds', 'fixtures', 'db', 'database'],
  filenamePatterns: [/migration/i, /seed/i, /fixture/i, /\d{8,}/],
  keywords: [
    'CREATE TABLE',
    'ALTER TABLE',
    'INSERT INTO',
    'migration',
    'seed',
    'fixture',
    'schema',
  ],
  embeddingRecommendation: {
    provider: 'OpenAI',
    model: 'text-embedding-3-small',
    reason: 'Data files have structured content where simpler embeddings are sufficient',
  },
  searchWeight: 0.5,
  prioritizeInHybridSearch: false,
};

/**
 * Infrastructure domain - DevOps, CI/CD, and infrastructure as code
 */
export const INFRASTRUCTURE_DOMAIN: DomainDefinition = {
  id: 'infrastructure',
  name: 'Infrastructure',
  description: 'DevOps configurations, CI/CD pipelines, Docker, Kubernetes, and IaC',
  fileExtensions: ['.yaml', '.yml', '.tf', '.hcl', '.dockerfile'],
  directoryPatterns: [
    '.github',
    '.gitlab',
    'infra',
    'infrastructure',
    'deploy',
    'k8s',
    'kubernetes',
    'terraform',
  ],
  filenamePatterns: [
    /dockerfile/i,
    /docker-compose/i,
    /\.github\/workflows/i,
    /\.gitlab-ci/i,
    /jenkinsfile/i,
  ],
  keywords: [
    'docker',
    'kubernetes',
    'terraform',
    'ansible',
    'deploy',
    'pipeline',
    'workflow',
    'container',
    'image',
    'service',
  ],
  embeddingRecommendation: {
    provider: 'VoyageAI',
    model: 'voyage-3-large',
    reason: 'Infrastructure code mixes code patterns with domain-specific terminology',
  },
  searchWeight: 0.75,
  prioritizeInHybridSearch: false,
};

/**
 * Frontend domain - UI components, styles, and client-side code
 */
export const FRONTEND_DOMAIN: DomainDefinition = {
  id: 'frontend',
  name: 'Frontend',
  description: 'UI components, React/Vue/Angular code, styles, and client-side logic',
  fileExtensions: ['.tsx', '.jsx', '.vue', '.svelte', '.css', '.scss', '.sass', '.less', '.html'],
  directoryPatterns: [
    'components',
    'ui',
    'views',
    'pages',
    'layouts',
    'styles',
    'frontend',
    'client',
    'web',
  ],
  filenamePatterns: [/component/i, /\.styles\./i, /\.module\.css/i, /page\./i, /layout\./i],
  keywords: [
    'useState',
    'useEffect',
    'component',
    'render',
    'props',
    'state',
    'onClick',
    'className',
    'styled',
    'css',
  ],
  embeddingRecommendation: {
    provider: 'VoyageAI',
    model: 'voyage-code-3',
    reason: 'Frontend code benefits from code-optimized embeddings for component patterns',
  },
  searchWeight: 0.9,
  prioritizeInHybridSearch: true,
};

/**
 * Backend domain - Server-side code, services, and business logic
 */
export const BACKEND_DOMAIN: DomainDefinition = {
  id: 'backend',
  name: 'Backend',
  description: 'Server-side code, services, business logic, and data access layers',
  fileExtensions: ['.ts', '.js', '.py', '.java', '.go', '.rs', '.cs', '.rb', '.php'],
  directoryPatterns: [
    'server',
    'backend',
    'services',
    'models',
    'repositories',
    'domain',
    'application',
  ],
  filenamePatterns: [/service\./i, /repository\./i, /controller\./i, /model\./i, /entity\./i],
  keywords: [
    'service',
    'repository',
    'controller',
    'model',
    'entity',
    'database',
    'query',
    'transaction',
    'middleware',
  ],
  embeddingRecommendation: {
    provider: 'VoyageAI',
    model: 'voyage-code-3',
    reason: 'Backend code requires deep code understanding for service patterns',
  },
  searchWeight: 1.0,
  prioritizeInHybridSearch: true,
};

// ============================================================================
// All Domains Registry
// ============================================================================

/**
 * All domain definitions indexed by ID for O(1) lookup
 */
export const DOMAINS: Record<DomainId, DomainDefinition> = {
  code: CODE_DOMAIN,
  documentation: DOCUMENTATION_DOMAIN,
  api: API_DOMAIN,
  test: TEST_DOMAIN,
  config: CONFIG_DOMAIN,
  data: DATA_DOMAIN,
  infrastructure: INFRASTRUCTURE_DOMAIN,
  frontend: FRONTEND_DOMAIN,
  backend: BACKEND_DOMAIN,
};

/**
 * Array of all domain definitions for iteration
 */
export const ALL_DOMAINS: DomainDefinition[] = Object.values(DOMAINS);

/**
 * Array of all domain IDs for validation
 */
export const DOMAIN_IDS: DomainId[] = Object.keys(DOMAINS) as DomainId[];

// ============================================================================
// Lookup Helpers
// ============================================================================

/**
 * Get a domain definition by ID
 * @param domainId The domain identifier
 * @returns The domain definition or undefined if not found
 */
export function getDomainById(domainId: DomainId): DomainDefinition | undefined {
  return DOMAINS[domainId];
}

/**
 * Check if a given string is a valid domain ID
 * @param id The string to check
 * @returns True if the string is a valid DomainId
 */
export function isValidDomainId(id: string): id is DomainId {
  return DOMAIN_IDS.includes(id as DomainId);
}

/**
 * Detect the domain of a file based on its path and extension
 * @param filePath The file path to analyze
 * @returns The detected domain ID, defaults to 'code' if no match
 */
export function detectDomainFromPath(filePath: string): DomainId {
  const normalizedPath = filePath.toLowerCase().replace(/\\/g, '/');
  const fileName = normalizedPath.split('/').pop() || '';

  // Check each domain's patterns
  for (const domain of ALL_DOMAINS) {
    // Check filename patterns (highest priority)
    for (const pattern of domain.filenamePatterns) {
      if (pattern.test(fileName)) {
        return domain.id;
      }
    }

    // Check directory patterns
    for (const dirPattern of domain.directoryPatterns) {
      if (
        normalizedPath.includes(`/${dirPattern}/`) ||
        normalizedPath.startsWith(`${dirPattern}/`)
      ) {
        return domain.id;
      }
    }

    // Check file extensions
    for (const ext of domain.fileExtensions) {
      if (normalizedPath.endsWith(ext.toLowerCase())) {
        return domain.id;
      }
    }
  }

  // Default to code domain
  return 'code';
}

/**
 * Detect the domain based on content analysis
 * @param content The file content to analyze
 * @param filePath Optional file path for additional context
 * @returns The detected domain ID with confidence score
 */
export function detectDomainFromContent(
  content: string,
  filePath?: string
): { domainId: DomainId; confidence: number } {
  const scores: Map<DomainId, number> = new Map();

  // Initialize all scores to 0
  for (const id of DOMAIN_IDS) {
    scores.set(id, 0);
  }

  const contentLower = content.toLowerCase();

  // Score based on keyword matches
  for (const domain of ALL_DOMAINS) {
    let score = 0;
    for (const keyword of domain.keywords) {
      const matches = (contentLower.match(new RegExp(keyword.toLowerCase(), 'g')) || []).length;
      score += matches * 0.1; // Each match adds 0.1 to score
    }
    scores.set(domain.id, score);
  }

  // Add path-based hint if available
  if (filePath) {
    const pathDomain = detectDomainFromPath(filePath);
    scores.set(pathDomain, (scores.get(pathDomain) || 0) + 1.0);
  }

  // Find the domain with the highest score
  let maxScore = 0;
  let detectedDomain: DomainId = 'code';

  for (const [domainId, score] of scores) {
    if (score > maxScore) {
      maxScore = score;
      detectedDomain = domainId;
    }
  }

  // Calculate confidence (0-1 range)
  const totalScore = Array.from(scores.values()).reduce((a, b) => a + b, 0);
  const confidence = totalScore > 0 ? Math.min(maxScore / totalScore, 1.0) : 0.5;

  return { domainId: detectedDomain, confidence };
}

/**
 * Get domains that should be prioritized in hybrid search
 * @returns Array of domain IDs that are prioritized
 */
export function getPrioritizedDomains(): DomainId[] {
  return ALL_DOMAINS.filter((d) => d.prioritizeInHybridSearch).map((d) => d.id);
}

/**
 * Get the recommended embedding configuration for a domain
 * @param domainId The domain identifier
 * @returns The embedding recommendation or default (voyage-code-3)
 */
export function getEmbeddingRecommendation(domainId: DomainId): EmbeddingRecommendation {
  const domain = DOMAINS[domainId];
  if (domain) {
    return domain.embeddingRecommendation;
  }

  // Default to code embedding
  return CODE_DOMAIN.embeddingRecommendation;
}

/**
 * Get all domains that match a file extension
 * @param extension The file extension (with or without dot)
 * @returns Array of matching domains sorted by search weight
 */
export function getDomainsForExtension(extension: string): DomainDefinition[] {
  const ext = extension.startsWith('.') ? extension : `.${extension}`;
  const extLower = ext.toLowerCase();

  return ALL_DOMAINS.filter((d) => d.fileExtensions.some((e) => e.toLowerCase() === extLower)).sort(
    (a, b) => b.searchWeight - a.searchWeight
  );
}

/**
 * Get the search weight for a domain
 * @param domainId The domain identifier
 * @returns The search weight (0.0 - 1.0)
 */
export function getDomainSearchWeight(domainId: DomainId): number {
  return DOMAINS[domainId]?.searchWeight ?? 0.5;
}

/**
 * Calculate weighted search scores for multiple domains
 * @param domainScores Map of domain IDs to raw scores
 * @returns Map of domain IDs to weighted scores
 */
export function calculateWeightedScores(
  domainScores: Map<DomainId, number>
): Map<DomainId, number> {
  const weightedScores = new Map<DomainId, number>();

  for (const [domainId, score] of domainScores) {
    const weight = getDomainSearchWeight(domainId);
    weightedScores.set(domainId, score * weight);
  }

  return weightedScores;
}

/**
 * Get a summary of all domains for logging/debugging
 * @returns Array of domain summaries
 */
export function getDomainsSummary(): Array<{
  id: DomainId;
  name: string;
  extensions: number;
  weight: number;
}> {
  return ALL_DOMAINS.map((d) => ({
    id: d.id,
    name: d.name,
    extensions: d.fileExtensions.length,
    weight: d.searchWeight,
  }));
}
