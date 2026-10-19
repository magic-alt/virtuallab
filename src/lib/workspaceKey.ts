/**
 * Keys are UI/persisted identifiers, NOT security or filesystem authority.
 * Drive-letter and UNC paths are Windows-style and case-folded. POSIX paths
 * preserve case and literal backslashes: Linux and case-sensitive APFS may
 * contain distinct siblings whose names differ only in these characters.
 * The native ownership boundary canonicalizes filesystem identities separately.
 */
export function workspaceKey(path: string): string {
  const windowsPath = /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("//");
  const slashed = windowsPath ? path.replaceAll("\\", "/") : path;
  const normalized = slashed === "/" ? slashed : slashed.replace(/\/+$/, "");
  return windowsPath ? normalized.toLowerCase() : normalized;
}
