#!/usr/bin/env node

// CRITICAL: Redirect console outputs to stderr IMMEDIATELY to avoid interfering with MCP JSON protocol
// Only MCP protocol messages should go to stdout
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;

console.log = (...args: any[]) => {
  process.stderr.write('[LOG] ' + args.join(' ') + '\n');
};

console.warn = (...args: any[]) => {
  process.stderr.write('[WARN] ' + args.join(' ') + '\n');
};

// console.error already goes to stderr by default

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Context } from '@zilliz/claude-context-core';
import { MilvusVectorDatabase } from '@zilliz/claude-context-core';

// Import our modular components
import {
  createMcpConfig,
  logConfigurationSummary,
  showHelpMessage,
  ContextMcpConfig,
} from './config.js';
import { createEmbeddingInstance, logEmbeddingProviderInfo } from './embedding.js';
import { SnapshotManager } from './snapshot.js';
import { ToolHandlers } from './handlers.js';
import { ensureIndexerDaemonRunning, runIndexerDaemon } from './daemon/indexer-daemon.js';
import { runAdminCommandFromArgs } from './daemon/admin-cli.js';

class ContextMcpServer {
  private server: Server;
  private context: Context;
  private snapshotManager: SnapshotManager;
  private toolHandlers: ToolHandlers;
  private config: ContextMcpConfig;

  constructor(config: ContextMcpConfig) {
    this.config = config;
    // Initialize MCP server
    this.server = new Server(
      {
        name: config.name,
        version: config.version,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Initialize embedding provider
    console.log(`[EMBEDDING] Initializing embedding provider: ${config.embeddingProvider}`);
    console.log(`[EMBEDDING] Using model: ${config.embeddingModel}`);

    const embedding = createEmbeddingInstance(config);
    logEmbeddingProviderInfo(config, embedding);

    // Initialize vector database
    const vectorDatabase = new MilvusVectorDatabase({
      address: config.milvusAddress,
      ...(config.milvusToken && { token: config.milvusToken }),
    });

    // Initialize Claude Context
    this.context = new Context({
      embedding,
      vectorDatabase,
    });

    // Initialize managers
    this.snapshotManager = new SnapshotManager();
    this.toolHandlers = new ToolHandlers(this.context, this.snapshotManager, config);

    // Load existing codebase snapshot on startup
    this.snapshotManager.loadCodebaseSnapshot();

    this.setupTools();
  }

  private setupTools() {
    const index_description = `
Index a codebase directory to enable semantic search using a configurable code splitter.

⚠️ **IMPORTANT**:
- You MUST provide an absolute path to the target codebase.

✨ **Usage Guidance**:
- This tool is typically used when search fails due to an unindexed codebase.
- If indexing is attempted on an already indexed path, and a conflict is detected, you MUST prompt the user to confirm whether to proceed with a force index (i.e., re-indexing and overwriting the previous index).
`;

    const search_description = `
Search the indexed codebase using natural language queries within a specified absolute path.

⚠️ **IMPORTANT**:
- You MUST provide an absolute path.

🎯 **When to Use**:
This tool is versatile and can be used before completing various tasks to retrieve relevant context:
- **Code search**: Find specific functions, classes, or implementations
- **Context-aware assistance**: Gather relevant code context before making changes
- **Issue identification**: Locate problematic code sections or bugs
- **Code review**: Understand existing implementations and patterns
- **Refactoring**: Find all related code pieces that need to be updated
- **Feature development**: Understand existing architecture and similar implementations
- **Duplicate detection**: Identify redundant or duplicated code patterns across the codebase

✨ **Usage Guidance**:
- If the codebase is not indexed, this tool will return a clear error message indicating that indexing is required first.
- Indexing may be disabled in this MCP server (search-only mode). In that case, index via the terminal/admin CLI or your singleton indexer daemon.
`;

    // Define available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const isAdmin = this.config.toolMode === 'admin' && this.config.exposeAdminTools;
      return {
        tools: [
          ...(isAdmin
            ? [
                {
                  name: 'index_codebase',
                  description: index_description,
                  inputSchema: {
                    type: 'object',
                    properties: {
                      path: {
                        type: 'string',
                        description: `ABSOLUTE path to the codebase directory to index.`,
                      },
                      force: {
                        type: 'boolean',
                        description: 'Force re-indexing even if already indexed',
                        default: false,
                      },
                      splitter: {
                        type: 'string',
                        description:
                          "Code splitter to use: 'ast' for syntax-aware splitting with automatic fallback, 'langchain' for character-based splitting",
                        enum: ['ast', 'langchain'],
                        default: 'ast',
                      },
                      customExtensions: {
                        type: 'array',
                        items: {
                          type: 'string',
                        },
                        description:
                          "Optional: Additional file extensions to include beyond defaults (e.g., ['.vue', '.svelte', '.astro']). Extensions should include the dot prefix or will be automatically added",
                        default: [],
                      },
                      ignorePatterns: {
                        type: 'array',
                        items: {
                          type: 'string',
                        },
                        description:
                          "Optional: Additional ignore patterns to exclude specific files/directories beyond defaults. Only include this parameter if the user explicitly requests custom ignore patterns (e.g., ['static/**', '*.tmp', 'private/**'])",
                        default: [],
                      },
                    },
                    required: ['path'],
                  },
                },
              ]
            : []),
          {
            name: 'search_code',
            description: search_description,
            inputSchema: {
              type: 'object',
              properties: {
                path: {
                  type: 'string',
                  description: `ABSOLUTE path to the codebase directory to search in.`,
                },
                query: {
                  type: 'string',
                  description: 'Natural language query to search for in the codebase',
                },
                limit: {
                  type: 'number',
                  description: 'Maximum number of results to return',
                  default: 10,
                  maximum: 50,
                },
                extensionFilter: {
                  type: 'array',
                  items: {
                    type: 'string',
                  },
                  description:
                    "Optional: List of file extensions to filter results. (e.g., ['.ts','.py']).",
                  default: [],
                },
              },
              required: ['path', 'query'],
            },
          },
          ...(isAdmin
            ? [
                {
                  name: 'clear_index',
                  description: `Clear the search index. IMPORTANT: You MUST provide an absolute path.`,
                  inputSchema: {
                    type: 'object',
                    properties: {
                      path: {
                        type: 'string',
                        description: `ABSOLUTE path to the codebase directory to clear.`,
                      },
                    },
                    required: ['path'],
                  },
                },
              ]
            : []),
          {
            name: 'get_indexing_status',
            description: `Get the current indexing status of a codebase. Shows progress percentage for actively indexing codebases and completion status for indexed codebases.`,
            inputSchema: {
              type: 'object',
              properties: {
                path: {
                  type: 'string',
                  description: `ABSOLUTE path to the codebase directory to check status for.`,
                },
              },
              required: ['path'],
            },
          },
        ],
      };
    });

    // Handle tool execution
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const isAdmin = this.config.toolMode === 'admin' && this.config.exposeAdminTools;

      switch (name) {
        case 'index_codebase':
          if (!isAdmin) {
            throw new Error(
              `Tool 'index_codebase' is disabled (admin tools not exposed; set MCP_TOOL_MODE=admin and MCP_EXPOSE_ADMIN_TOOLS=true)`
            );
          }
          return await this.toolHandlers.handleIndexCodebase(args);
        case 'search_code':
          return await this.toolHandlers.handleSearchCode(args);
        case 'clear_index':
          if (!isAdmin) {
            throw new Error(
              `Tool 'clear_index' is disabled (admin tools not exposed; set MCP_TOOL_MODE=admin and MCP_EXPOSE_ADMIN_TOOLS=true)`
            );
          }
          return await this.toolHandlers.handleClearIndex(args);
        case 'get_indexing_status':
          return await this.toolHandlers.handleGetIndexingStatus(args);

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    });
  }

  async start() {
    console.log('[SYNC-DEBUG] MCP server start() method called');
    console.log('Starting Context MCP server...');

    const transport = new StdioServerTransport();
    console.log('[SYNC-DEBUG] StdioServerTransport created, attempting server connection...');

    await this.server.connect(transport);
    console.log('MCP server started and listening on stdio.');
    console.log('[SYNC-DEBUG] Server connection established successfully');

    // Ensure singleton daemon is running (optional; configured via env)
    if (this.config.autostartDaemon) {
      try {
        await ensureIndexerDaemonRunning({ intervalMinutes: this.config.daemonIntervalMinutes });
      } catch (error) {
        console.error('[MCP] Failed to ensure indexer daemon is running:', error);
      }
    }

    // Exit promptly when the host closes stdio (prevents leaked processes)
    const gracefulExit = (reason: string) => {
      console.error(`[MCP] Shutting down (${reason})`);
      process.exit(0);
    };
    process.stdin.on('end', () => gracefulExit('stdin end'));
    process.stdin.on('close', () => gracefulExit('stdin close'));

    console.log('[MCP] Ready');
  }
}

// Main execution
async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);

  // Show help if requested
  if (args.includes('--help') || args.includes('-h')) {
    showHelpMessage();
    process.exit(0);
  }

  // Create configuration
  const config = createMcpConfig();
  logConfigurationSummary(config);

  // Warn loudly if admin tools are exposed (potential misconfiguration)
  if (config.toolMode === 'admin' && config.exposeAdminTools) {
    console.warn(
      '[MCP] ⚠️  WARNING: Admin tools (index_codebase, clear_index) are EXPOSED to the LLM. ' +
        'This allows the connected AI to trigger indexing. ' +
        'Set MCP_TOOL_MODE=search to restrict to search-only mode.'
    );
  }

  // Admin CLI commands (terminal-only)
  const adminResult = await runAdminCommandFromArgs(args, config);
  if (adminResult.handled) {
    process.exit(adminResult.exitCode);
  }

  // Daemon mode (singleton background index maintenance)
  if (args.includes('--daemon')) {
    await runIndexerDaemon(config);
    return;
  }

  const server = new ContextMcpServer(config);
  await server.start();
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.error('Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.error('Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

// Always start the server - this is designed to be the main entry point
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
