# ClaudeContext Investigation Handoff

**Investigation Date**: 2026-02-05
**Investigator**: Claude Opus 4.5
**Status**: Issues Identified - Requires Follow-up

---

## Executive Summary

A comprehensive investigation of the ClaudeContext codebase indexing system revealed:

- **Core functionality is working** - MCP tools accessible, semantic search functional, tests passing
- **Two issues identified** requiring investigation/fixes
- **Three edge cases** that may need hardening

---

## Issue #1: Stale Index Snapshots (Auto-Sync Not Updating)

### Symptoms

The daemon process is running but indexed codebases haven't been updated in 4 days:

| Codebase                                      | Last Updated | Expected |
| --------------------------------------------- | ------------ | -------- |
| `/Users/ruben/Documents/GitHub/unity-systems` | 2026-02-01   | Recent   |
| `.worktrees/feature-1`                        | 2026-02-01   | Recent   |
| `.worktrees/feature-2`                        | 2026-02-01   | Recent   |

### Evidence

```bash
# Daemon IS running
$ ps aux | grep "node.*daemon"
ruben  11404  0.0  0.2 446436864 101440  ??  Ss  8:49PM  7:10.49 node .../dist/index.js --daemon

# Lock file confirms daemon started Feb 4
$ cat ~/.context/locks/indexer-daemon.lock
{"pid":11404,"startedAt":"2026-02-04T19:49:11.688Z"}

# But snapshot shows Feb 1 for most codebases
$ cat ~/.context/mcp-codebase-snapshot.json | jq '.codebases[].lastUpdated'
"2026-02-01T10:34:11.431Z"  # 4 days old
```

### Possible Root Causes to Investigate

1. **Sync caps being exceeded silently**
   - Check if `SYNC_CAP_EXCEEDED` errors are being thrown
   - Location: `packages/core/src/context.ts:488-494`
   - The caps are: `maxEmbedFiles=200`, `maxEmbedBytes=2MB`

2. **Daemon sync errors not persisted**
   - No `~/.context/indexer-daemon.json` status file exists
   - Errors may be logged to stderr but not captured
   - Location: `packages/mcp/src/daemon/indexer-daemon.ts`

3. **FileSynchronizer snapshot mismatch**
   - The sync mechanism uses checksums to detect changes
   - If snapshot is corrupted/stale, changes won't be detected
   - Location: `packages/core/src/sync/synchronizer.ts`

4. **Embedding provider mismatch**
   - Main repo uses `voyage-code-3`, worktrees use `voyage-4-lite`
   - Daemon may be failing due to provider/dimension conflicts
   - Location: `packages/mcp/src/handlers.ts:44-73` (getContextForCodebase)

### Files to Investigate

```
packages/mcp/src/daemon/indexer-daemon.ts    # Daemon main loop
packages/mcp/src/sync.ts                      # SyncManager class
packages/core/src/context.ts                  # reindexByChange method (line 391-557)
packages/core/src/sync/synchronizer.ts        # FileSynchronizer change detection
```

### Verification Steps

```bash
# 1. Check daemon stderr output (if running in terminal)
# 2. Manually trigger sync and observe output:
node /Users/ruben/Documents/GitHub/unity-systems/7.Codebase-Indexing/claude-context/packages/mcp/dist/index.js \
  --admin-sync "/Users/ruben/Documents/GitHub/unity-systems"

# 3. Check if sync caps are the issue:
CONTEXT_SYNC_MAX_EMBED_FILES=500 node ... --admin-sync "/path"

# 4. Check FileSynchronizer snapshots:
ls -la ~/.context/snapshots/
```

---

## Issue #2: Orphaned Language Mapping Reference

### Description

The `getLanguageFromExtension()` method contains a mapping for `.ipynb` files, but `.ipynb` is NOT in `DEFAULT_SUPPORTED_EXTENSIONS`. This is dead code.

### Location

`packages/core/src/context.ts:1172`

```typescript
private getLanguageFromExtension(ext: string): string {
  const languageMap: Record<string, string> = {
    '.ts': 'typescript',
    // ... other languages ...
    '.ipynb': 'jupyter',  // <-- ORPHANED: .ipynb not in DEFAULT_SUPPORTED_EXTENSIONS
  };
  return languageMap[ext] || 'text';
}
```

### Impact

- **Severity**: Low (dead code, no functional impact)
- **Risk**: Confusion for future maintainers

### Fix

Remove the `.ipynb` entry from `languageMap` since it will never be reached.

---

## Edge Cases: Markdown Files Could Still Be Indexed

### Context

The staged changes correctly remove `.md`, `.markdown`, and `.ipynb` from `DEFAULT_SUPPORTED_EXTENSIONS`. However, there are three ways these files could still be indexed.

### Edge Case #1: Environment Variable Override

**Mechanism**: `CUSTOM_EXTENSIONS` environment variable

**Location**: `packages/core/src/context.ts:1400-1418`

```typescript
private getCustomExtensionsFromEnv(): string[] {
  const envExtensions = envManager.get('CUSTOM_EXTENSIONS');
  // Parses CSV and adds to supported extensions
}
```

**Risk**: If someone sets `CUSTOM_EXTENSIONS=".md,.markdown"`, markdown files WILL be indexed.

**Recommendation**: Consider adding a hardcoded blocklist that prevents documentation extensions from being added even via custom extensions:

```typescript
const BLOCKED_EXTENSIONS = ['.md', '.markdown', '.ipynb', '.txt', '.rst'];

private getCustomExtensionsFromEnv(): string[] {
  // ... existing code ...
  return extensions.filter(ext => !BLOCKED_EXTENSIONS.includes(ext));
}
```

### Edge Case #2: MCP Tool Parameter Override

**Mechanism**: `customExtensions` parameter in `index_codebase` tool

**Location**: `packages/mcp/src/handlers.ts:406-411`

```typescript
if (customFileExtensions.length > 0) {
  this.context.addCustomExtensions(customFileExtensions);
}
```

**Risk**: MCP clients can pass `{ customExtensions: ['.md'] }` to index markdown.

**Recommendation**: Validate `customExtensions` against a blocklist before adding:

```typescript
const blockedExtensions = ['.md', '.markdown', '.ipynb'];
const safeExtensions = customFileExtensions.filter(
  (ext) => !blockedExtensions.includes(ext.toLowerCase())
);
if (safeExtensions.length < customFileExtensions.length) {
  console.warn('[HANDLER] Blocked documentation extensions from custom list');
}
this.context.addCustomExtensions(safeExtensions);
```

### Edge Case #3: Programmatic ContextConfig Override

**Mechanism**: Direct instantiation with `customExtensions` in config

**Location**: `packages/core/src/context.ts:115-116`

```typescript
export interface ContextConfig {
  customExtensions?: string[]; // Can include anything
}
```

**Risk**: Direct API users can pass markdown extensions.

**Recommendation**: Same blocklist approach in the Context constructor.

---

## Test Coverage Status

### Existing Tests (All Passing)

| Test                                       | File                                 | Status |
| ------------------------------------------ | ------------------------------------ | ------ |
| DEFAULT_SUPPORTED_EXTENSIONS excludes docs | `context.guardrails.test.js:79-89`   | ✅     |
| Refuses re-index without forceReindex      | `context.guardrails.test.js:93-107`  | ✅     |
| Force reindex drops + recreates            | `context.guardrails.test.js:109-132` | ✅     |
| Skips hidden files/directories             | `context.guardrails.test.js:135-160` | ✅     |
| Sync caps prevent runaway costs            | `context.guardrails.test.js:163-199` | ✅     |

### Missing Test Coverage

1. **Edge case: CUSTOM_EXTENSIONS env var with .md**
2. **Edge case: MCP customExtensions param with .md**
3. **Daemon sync error handling**
4. **FileSynchronizer change detection accuracy**

---

## Recommended Actions

### Priority 1: Investigate Stale Snapshots

```bash
# Run manual sync with verbose output
DEBUG=* node .../dist/index.js --admin-sync "/Users/ruben/Documents/GitHub/unity-systems" 2>&1 | tee sync-debug.log
```

Check for:

- `SYNC_CAP_EXCEEDED` errors
- Embedding provider mismatch errors
- FileSynchronizer exceptions

### Priority 2: Harden Markdown Exclusion

Add blocklist validation in:

1. `Context.getCustomExtensionsFromEnv()`
2. `Context.addCustomExtensions()`
3. `ToolHandlers.handleIndexCodebase()`

### Priority 3: Clean Up Dead Code

Remove `.ipynb` from `languageMap` in `getLanguageFromExtension()`.

### Priority 4: Add Missing Tests

```javascript
// Test: CUSTOM_EXTENSIONS cannot add markdown
test('CUSTOM_EXTENSIONS env var cannot add markdown files', () => {
  process.env.CUSTOM_EXTENSIONS = '.md,.markdown,.ts';
  const ctx = new Context({ embedding, vectorDatabase });
  const extensions = ctx.getSupportedExtensions();
  expect(extensions).not.toContain('.md');
  expect(extensions).not.toContain('.markdown');
  expect(extensions).toContain('.ts');
});
```

---

## File Locations Reference

```
packages/core/src/context.ts              # Main Context class, extensions, reindexByChange
packages/core/src/sync/synchronizer.ts    # FileSynchronizer for change detection
packages/core/test/context.guardrails.test.js  # Guardrail tests
packages/mcp/src/handlers.ts              # MCP tool handlers
packages/mcp/src/daemon/indexer-daemon.ts # Daemon process
packages/mcp/src/sync.ts                  # SyncManager (5-minute background sync)
packages/mcp/src/config.ts                # Configuration parsing
~/.context/mcp-codebase-snapshot.json     # Runtime snapshot of indexed codebases
~/.context/locks/indexer-daemon.lock      # Daemon lock file
```

---

## Environment Variables Reference

| Variable                          | Purpose                           | Default   |
| --------------------------------- | --------------------------------- | --------- |
| `CUSTOM_EXTENSIONS`               | Add custom file extensions (CSV)  | None      |
| `CUSTOM_IGNORE_PATTERNS`          | Add custom ignore patterns (CSV)  | None      |
| `MCP_AUTOSTART_DAEMON`            | Auto-start daemon with MCP server | `false`   |
| `CONTEXT_DAEMON_INTERVAL_MINUTES` | Daemon sync interval              | `15`      |
| `CONTEXT_SYNC_MAX_EMBED_FILES`    | Max files per sync cycle          | `200`     |
| `CONTEXT_SYNC_MAX_EMBED_BYTES`    | Max bytes per sync cycle          | `2000000` |

---

## Session Context

**Current Working Directory**: `/Users/ruben/Documents/GitHub/unity-systems/7.Codebase-Indexing/claude-context/packages/core`

**Git Status**: Multiple staged changes including:

- Removal of `.md`, `.markdown`, `.ipynb` from DEFAULT_SUPPORTED_EXTENSIONS
- New guardrail tests in `packages/core/test/context.guardrails.test.js`
- Safety caps for incremental sync
- Admin CLI for terminal-based indexing

**Build Status**: ✅ All packages build successfully
**Test Status**: ✅ All 5 guardrail tests pass
