/**
 * Parses a string as a positive integer, returning a fallback if invalid.
 * @param value - The string value to parse (may be undefined)
 * @param fallback - The fallback value if parsing fails or value is not positive
 * @returns The parsed positive integer or the fallback
 */
export function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}
