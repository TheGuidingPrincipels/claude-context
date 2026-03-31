const fs = require('fs');
const os = require('os');
const path = require('path');

const { Context } = require('../dist/index.js');

/**
 * Temporarily sets environment variables for a test, then restores original values.
 * @param {Object} vars - Object mapping env var names to values (use undefined to delete)
 * @param {Function} fn - Test function to run with the temporary env vars
 * @returns {Promise<*>} The return value of fn
 */
async function withEnvVars(vars, fn) {
  const saved = {};
  Object.keys(vars).forEach((key) => {
    saved[key] = process.env[key];
    if (vars[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = vars[key];
    }
  });
  try {
    return await fn();
  } finally {
    Object.keys(saved).forEach((key) => {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    });
  }
}

function makeEmbeddingStub() {
  return {
    async detectDimension() {
      return 3;
    },
    async embed() {
      throw new Error('embed() not expected in these tests');
    },
    async embedBatch(texts) {
      return texts.map(() => ({ vector: [0, 0, 0], dimension: 3 }));
    },
    getDimension() {
      return 3;
    },
    getProvider() {
      return 'Stub';
    },
  };
}

function makeVectorDbStub(overrides = {}) {
  const base = {
    async createCollection() {
      throw new Error('createCollection() not expected in these tests');
    },
    async createHybridCollection() {
      throw new Error('createHybridCollection() not expected in these tests');
    },
    async dropCollection() {
      throw new Error('dropCollection() not expected in these tests');
    },
    async hasCollection() {
      return false;
    },
    async listCollections() {
      return [];
    },
    async insert() {
      throw new Error('insert() not expected in these tests');
    },
    async insertHybrid() {
      throw new Error('insertHybrid() not expected in these tests');
    },
    async search() {
      return [];
    },
    async hybridSearch() {
      return [];
    },
    async delete() {
      throw new Error('delete() not expected in these tests');
    },
    async query() {
      throw new Error('query() not expected in these tests');
    },
    async checkCollectionLimit() {
      return true;
    },
  };

  return { ...base, ...overrides };
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('Context defaults', () => {
  test('DEFAULT_SUPPORTED_EXTENSIONS excludes docs/notebooks', () => {
    const ctx = new Context({
      embedding: makeEmbeddingStub(),
      vectorDatabase: makeVectorDbStub(),
    });

    const extensions = ctx.getSupportedExtensions();
    expect(extensions).not.toContain('.md');
    expect(extensions).not.toContain('.markdown');
    expect(extensions).not.toContain('.ipynb');
  });

  test('CUSTOM_EXTENSIONS cannot add docs/notebooks by default', async () => {
    await withEnvVars(
      {
        CUSTOM_EXTENSIONS: '.md,.markdown,.ts',
        CONTEXT_ALLOW_DOC_EXTENSIONS: undefined,
      },
      () => {
        const ctx = new Context({
          embedding: makeEmbeddingStub(),
          vectorDatabase: makeVectorDbStub(),
        });

        const extensions = ctx.getSupportedExtensions();
        expect(extensions).not.toContain('.md');
        expect(extensions).not.toContain('.markdown');
        expect(extensions).toContain('.ts');
      }
    );
  });

  test('CUSTOM_EXTENSIONS can add docs/notebooks when CONTEXT_ALLOW_DOC_EXTENSIONS=1', async () => {
    await withEnvVars(
      {
        CUSTOM_EXTENSIONS: '.md,.markdown,.ts',
        CONTEXT_ALLOW_DOC_EXTENSIONS: '1',
      },
      () => {
        const ctx = new Context({
          embedding: makeEmbeddingStub(),
          vectorDatabase: makeVectorDbStub(),
        });

        const extensions = ctx.getSupportedExtensions();
        expect(extensions).toContain('.md');
        expect(extensions).toContain('.markdown');
        expect(extensions).toContain('.ts');
      }
    );
  });

  test('addCustomExtensions blocks docs/notebooks by default (keeps other extensions)', async () => {
    await withEnvVars(
      {
        CONTEXT_ALLOW_DOC_EXTENSIONS: undefined,
      },
      () => {
        const ctx = new Context({
          embedding: makeEmbeddingStub(),
          vectorDatabase: makeVectorDbStub(),
        });

        ctx.addCustomExtensions(['.md', '.vue']);
        const extensions = ctx.getSupportedExtensions();
        expect(extensions).not.toContain('.md');
        expect(extensions).toContain('.vue');
      }
    );
  });
});

describe('indexCodebase guardrails', () => {
  test('refuses to index into an existing collection unless forceReindex=true', async () => {
    const tmp = makeTempDir('cc-guardrail-');

    const ctx = new Context({
      embedding: makeEmbeddingStub(),
      vectorDatabase: makeVectorDbStub({
        async hasCollection() {
          return true;
        },
      }),
    });

    await expect(ctx.indexCodebase(tmp)).rejects.toThrow(/Refusing to re-index/i);
    rmDir(tmp);
  });

  test('allows forceReindex=true (drops + recreates collection)', async () => {
    const tmp = makeTempDir('cc-force-');

    const dropCollection = jest.fn(async () => {});
    const createHybridCollection = jest.fn(async () => {});

    const ctx = new Context({
      embedding: makeEmbeddingStub(),
      vectorDatabase: makeVectorDbStub({
        async hasCollection() {
          return true;
        },
        dropCollection,
        createHybridCollection,
      }),
    });

    const result = await ctx.indexCodebase(tmp, undefined, true);
    expect(result.indexedFiles).toBe(0);
    expect(dropCollection).toHaveBeenCalled();
    expect(createHybridCollection).toHaveBeenCalled();

    rmDir(tmp);
  });
});

describe('File traversal guardrails', () => {
  test('getCodeFiles skips hidden files/directories', async () => {
    const tmp = makeTempDir('cc-files-');
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmp, '.git'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'src', '.private'), { recursive: true });

    fs.writeFileSync(path.join(tmp, 'src', 'visible.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(tmp, '.hidden.ts'), 'export const y = 2;');
    fs.writeFileSync(path.join(tmp, '.git', 'ignored.ts'), 'export const z = 3;');
    fs.writeFileSync(path.join(tmp, 'src', '.private', 'secret.ts'), 'export const s = 4;');

    const ctx = new Context({
      embedding: makeEmbeddingStub(),
      vectorDatabase: makeVectorDbStub(),
    });

    const files = await ctx.getCodeFiles(tmp);
    const normalized = files.map((p) => p.replace(/\\/g, '/'));
    expect(normalized.some((p) => p.endsWith('/src/visible.ts'))).toBe(true);
    expect(normalized.some((p) => p.endsWith('/.hidden.ts'))).toBe(false);
    expect(normalized.some((p) => p.includes('/.git/'))).toBe(false);
    expect(normalized.some((p) => p.includes('/.private/'))).toBe(false);

    rmDir(tmp);
  });
});

describe('Incremental sync caps', () => {
  test('reindexByChange deletes chunks for removed files regardless of supported extensions', async () => {
    const tmp = makeTempDir('cc-removed-');
    const vectorDatabase = makeVectorDbStub({
      query: jest.fn(async (_collectionName, filterExpr) => {
        if (String(filterExpr).includes('docs/readme.md')) {
          return [{ id: 'chunk-1' }];
        }
        return [];
      }),
      delete: jest.fn(async () => {}),
      insert: jest.fn(async () => {
        throw new Error('insert() not expected in this test');
      }),
      insertHybrid: jest.fn(async () => {
        throw new Error('insertHybrid() not expected in this test');
      }),
    });

    const ctx = new Context({
      embedding: makeEmbeddingStub(),
      vectorDatabase,
    });

    const collectionName = ctx.getCollectionName(tmp);
    ctx.setSynchronizer(collectionName, {
      async initialize() {},
      async checkForChanges() {
        return { added: [], removed: ['docs/readme.md'], modified: [] };
      },
    });

    try {
      await ctx.reindexByChange(tmp);
      expect(vectorDatabase.query).toHaveBeenCalledWith(
        collectionName,
        expect.stringContaining('docs/readme.md'),
        ['id']
      );
      expect(vectorDatabase.delete).toHaveBeenCalledWith(collectionName, ['chunk-1']);
    } finally {
      rmDir(tmp);
    }
  });

  test('reindexByChange deletes chunks for modified ineligible files when includeModified=false', async () => {
    const tmp = makeTempDir('cc-ineligible-');
    fs.writeFileSync(path.join(tmp, 'notes.md'), '# hello');

    const vectorDatabase = makeVectorDbStub({
      query: jest.fn(async (_collectionName, filterExpr) => {
        if (String(filterExpr).includes('notes.md')) {
          return [{ id: 'chunk-2' }];
        }
        return [];
      }),
      delete: jest.fn(async () => {}),
      insert: jest.fn(async () => {
        throw new Error('insert() not expected in this test');
      }),
      insertHybrid: jest.fn(async () => {
        throw new Error('insertHybrid() not expected in this test');
      }),
    });

    const ctx = new Context({
      embedding: makeEmbeddingStub(),
      vectorDatabase,
    });

    const collectionName = ctx.getCollectionName(tmp);
    ctx.setSynchronizer(collectionName, {
      async initialize() {},
      async checkForChanges() {
        return { added: [], removed: [], modified: ['notes.md'] };
      },
    });

    try {
      await ctx.reindexByChange(tmp, undefined, { includeModified: false });
      expect(vectorDatabase.delete).toHaveBeenCalledWith(collectionName, ['chunk-2']);
      expect(vectorDatabase.insert).not.toHaveBeenCalled();
      expect(vectorDatabase.insertHybrid).not.toHaveBeenCalled();
    } finally {
      rmDir(tmp);
    }
  });

  test('reindexByChange throws before any delete/embed when caps exceeded', async () => {
    const tmp = makeTempDir('cc-caps-');
    fs.writeFileSync(path.join(tmp, 'a.ts'), 'export const a = 1;');
    fs.writeFileSync(path.join(tmp, 'b.ts'), 'export const b = 2;');

    const vectorDatabase = makeVectorDbStub({
      query: jest.fn(async () => {
        throw new Error('query() should not be called when caps are exceeded');
      }),
      delete: jest.fn(async () => {
        throw new Error('delete() should not be called when caps are exceeded');
      }),
      insertHybrid: jest.fn(async () => {
        throw new Error('insertHybrid() should not be called when caps are exceeded');
      }),
    });

    const ctx = new Context({
      embedding: makeEmbeddingStub(),
      vectorDatabase,
    });

    const collectionName = ctx.getCollectionName(tmp);
    ctx.setSynchronizer(collectionName, {
      async initialize() {},
      async checkForChanges() {
        return { added: ['a.ts', 'b.ts'], removed: [], modified: [] };
      },
    });

    await expect(
      ctx.reindexByChange(tmp, undefined, { maxEmbedFiles: 1, maxEmbedBytes: 2_000_000 })
    ).rejects.toThrow(/SYNC_CAP_EXCEEDED/);

    rmDir(tmp);
  });
});

describe('File traversal extended guardrails', () => {
  test('getCodeFiles skips .md files on disk', async () => {
    const tmp = makeTempDir('cc-md-');
    fs.writeFileSync(path.join(tmp, 'code.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(tmp, 'readme.md'), '# Hello');

    const ctx = new Context({
      embedding: makeEmbeddingStub(),
      vectorDatabase: makeVectorDbStub(),
    });

    try {
      const files = await ctx.getCodeFiles(tmp);
      const names = files.map((p) => path.basename(p));
      expect(names).toContain('code.ts');
      expect(names).not.toContain('readme.md');
    } finally {
      rmDir(tmp);
    }
  });

  test('normalizeAndFilterExtensions blocks case variations', async () => {
    await withEnvVars({ CONTEXT_ALLOW_DOC_EXTENSIONS: undefined }, () => {
      const ctx = new Context({
        embedding: makeEmbeddingStub(),
        vectorDatabase: makeVectorDbStub(),
      });

      ctx.addCustomExtensions(['.MD', '.Md', '.MARKDOWN', '.IPYNB', '.vue']);
      const extensions = ctx.getSupportedExtensions();
      expect(extensions).not.toContain('.md');
      expect(extensions).not.toContain('.markdown');
      expect(extensions).not.toContain('.ipynb');
      expect(extensions).toContain('.vue');
    });
  });

  test('customExtensions MCP parameter cannot add .md', async () => {
    await withEnvVars({ CONTEXT_ALLOW_DOC_EXTENSIONS: undefined }, () => {
      const ctx = new Context({
        embedding: makeEmbeddingStub(),
        vectorDatabase: makeVectorDbStub(),
      });

      ctx.addCustomExtensions(['.md', '.vue']);
      const extensions = ctx.getSupportedExtensions();
      expect(extensions).not.toContain('.md');
      expect(extensions).toContain('.vue');
    });
  });

  test('file with .md.ts extension is indexed', async () => {
    const tmp = makeTempDir('cc-mdts-');
    fs.writeFileSync(path.join(tmp, 'readme.md.ts'), 'export const x = 1;');

    const ctx = new Context({
      embedding: makeEmbeddingStub(),
      vectorDatabase: makeVectorDbStub(),
    });

    try {
      const files = await ctx.getCodeFiles(tmp);
      const names = files.map((p) => path.basename(p));
      expect(names).toContain('readme.md.ts');
    } finally {
      rmDir(tmp);
    }
  });

  test('file size limit skips oversized files', async () => {
    const tmp = makeTempDir('cc-size-');
    // Create a small file (50 bytes)
    fs.writeFileSync(path.join(tmp, 'small.ts'), 'x'.repeat(50));
    // Create an oversized file (200 bytes)
    fs.writeFileSync(path.join(tmp, 'large.ts'), 'x'.repeat(200));

    await withEnvVars({ CONTEXT_MAX_FILE_SIZE_BYTES: '100' }, async () => {
      const ctx = new Context({
        embedding: makeEmbeddingStub(),
        vectorDatabase: makeVectorDbStub(),
      });

      const files = await ctx.getCodeFiles(tmp);
      const names = files.map((p) => path.basename(p));
      expect(names).toContain('small.ts');
      expect(names).not.toContain('large.ts');
    });

    rmDir(tmp);
  });
});
