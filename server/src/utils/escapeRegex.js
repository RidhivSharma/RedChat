/**
 * Escapes user input before it is embedded in a RegExp.
 * Prevents regex injection (e.g. ".*" matching everything) in searches.
 */
export function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default escapeRegex;
