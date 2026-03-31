/**
 * SyncManager is DISABLED. All sync operations are handled by the singleton
 * indexer daemon (--daemon). These methods are no-ops to prevent the published
 * npm package from running uncapped background sync loops.
 */
export class SyncManager {
  constructor(_context: unknown, _snapshotManager: unknown) {
    // No-op: daemon handles all sync
  }

  public async handleSyncIndex(): Promise<void> {
    console.error(
      '[SYNC] handleSyncIndex() is DISABLED. Use the singleton indexer daemon (--daemon) for incremental sync.'
    );
  }

  public startBackgroundSync(): void {
    console.error(
      '[SYNC] startBackgroundSync() is DISABLED. Use the singleton indexer daemon (--daemon) instead.'
    );
  }
}
