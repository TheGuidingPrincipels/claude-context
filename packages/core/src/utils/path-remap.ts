import * as path from 'path';
import { envManager } from './env-manager';

/**
 * Resolves a local codebase path to its canonical form for collection name hashing.
 *
 * When COLLECTION_PATH_PREFIX_REMAP is set (e.g. "/home/philip/dev=/Users/ruben/Documents/GitHub"),
 * the local prefix is replaced with the canonical prefix before hashing. This allows multiple
 * machines with different filesystem layouts to share the same Zilliz collections and merkle trees.
 *
 * If no remap is configured, the path is returned as-is (after path.resolve).
 */
export function resolveCanonicalPath(codebasePath: string): string {
  const normalizedPath = path.resolve(codebasePath);
  const remap = envManager.get('COLLECTION_PATH_PREFIX_REMAP');

  if (!remap) {
    return normalizedPath;
  }

  const separatorIndex = remap.indexOf('=');
  if (separatorIndex === -1) {
    console.warn(
      `[PathRemap] ⚠️ Invalid COLLECTION_PATH_PREFIX_REMAP format: "${remap}". Expected "LOCAL_PREFIX=CANONICAL_PREFIX".`
    );
    return normalizedPath;
  }

  const localPrefix = remap.substring(0, separatorIndex).replace(/\/+$/, '');
  const canonicalPrefix = remap.substring(separatorIndex + 1).replace(/\/+$/, '');

  if (normalizedPath.startsWith(localPrefix + '/') || normalizedPath === localPrefix) {
    const remapped = canonicalPrefix + normalizedPath.substring(localPrefix.length);
    console.log(`[PathRemap] 🔄 ${normalizedPath} → ${remapped}`);
    return remapped;
  }

  return normalizedPath;
}
