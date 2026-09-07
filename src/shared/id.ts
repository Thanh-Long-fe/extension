/** Small id/hash helpers. crypto.randomUUID is available in every MV3 context. */

export function uid(prefix = ''): string {
  const raw =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      : Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  return prefix ? `${prefix}_${raw}` : raw;
}

/** Deterministic 32-bit string hash (FNV-1a), rendered base36. */
export function hashString(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
