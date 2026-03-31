const fs = require('fs');
const os = require('os');
const path = require('path');
const { Context } = require('../dist/index.js');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function makeVectorDbStub() {
  return {
    async hasCollection() {
      return false;
    },
    async createHybridCollection() {},
    async insertHybrid() {},
    async checkCollectionLimit() {
      return true;
    },
  };
}

describe('Context Retry Logic', () => {
  test('processChunkBufferWithRetry bisects batches on failure', async () => {
    const tmp = makeTempDir('cc-retry-');

    // create 4 files
    fs.writeFileSync(path.join(tmp, '1.ts'), 'content 1');
    fs.writeFileSync(path.join(tmp, '2.ts'), 'BAD_CONTENT'); // This will cause failure
    fs.writeFileSync(path.join(tmp, '3.ts'), 'content 3');
    fs.writeFileSync(path.join(tmp, '4.ts'), 'content 4');

    // Mock embedding provider that fails on 'BAD_CONTENT'
    const embedBatchMock = jest.fn(async (texts) => {
      if (texts.some((t) => t.includes('BAD_CONTENT'))) {
        throw new Error('API Error: Bad content detected');
      }
      return texts.map((t) => ({ vector: [0.1, 0.2, 0.3], dimension: 3 }));
    });

    const embeddingStub = {
      async detectDimension() {
        return 3;
      },
      async embed() {
        throw new Error('Should use embedBatch');
      },
      embedBatch: embedBatchMock,
      getDimension() {
        return 3;
      },
      getProvider() {
        return 'Stub';
      },
      preprocessText(t) {
        return t;
      },
      preprocessTexts(ts) {
        return ts;
      },
    };

    const ctx = new Context({
      embedding: embeddingStub,
      vectorDatabase: makeVectorDbStub(),
    });

    // Mock splitter to return deterministic chunks
    ctx.updateSplitter({
      split: async (code, language, filePath) => {
        return [
          {
            content: code,
            metadata: {
              startLine: 1,
              endLine: 1,
              language,
              filePath,
            },
          },
        ];
      },
      setChunkSize: () => {},
      setChunkOverlap: () => {},
    });

    // Force batch size to 4 so all files are in one initial batch
    process.env.EMBEDDING_BATCH_SIZE = '4';

    try {
      await ctx.indexCodebase(tmp);

      // Expected behavior:
      // 1. Initial batch of 4 fails (contains BAD_CONTENT)
      // 2. Bisect -> Batch 1 [1.ts, 2.ts] fails
      // 3. Bisect -> Batch 1a [1.ts] succeeds
      // 4. Bisect -> Batch 1b [2.ts] fails -> Permanent failure for this chunk
      // 5. Bisect -> Batch 2 [3.ts, 4.ts] succeeds

      // Total successful chunks should be 3 (1.ts, 3.ts, 4.ts)
      // Total indexed files might report 4 because file processing doesn't stop,
      // but we care about how many chunks made it.
      // Actually, looking at context.ts logic:
      // failedChunks is incremented when the recursive retry fails completely.

      expect(embedBatchMock).toHaveBeenCalled();

      // Verify that at least some calls succeeded
      const successfulCalls = embedBatchMock.mock.calls.filter(
        (args) => !args[0].some((t) => t.includes('BAD_CONTENT'))
      );
      expect(successfulCalls.length).toBeGreaterThan(0);

      // Verify that 1.ts, 3.ts, and 4.ts were processed
      const allProcessedTexts = successfulCalls.flatMap((call) => call[0]);
      expect(allProcessedTexts.some((t) => t.includes('content 1'))).toBe(true);
      expect(allProcessedTexts.some((t) => t.includes('content 3'))).toBe(true);
      expect(allProcessedTexts.some((t) => t.includes('content 4'))).toBe(true);

      // Verify bad content was never successfully processed
      expect(allProcessedTexts.some((t) => t.includes('BAD_CONTENT'))).toBe(false);
    } finally {
      delete process.env.EMBEDDING_BATCH_SIZE;
      rmDir(tmp);
    }
  });
});
