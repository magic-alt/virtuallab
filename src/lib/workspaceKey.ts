/**
 * Keys are UI/persisted identifiers, NOT security or filesystem authority.
 * Drive-letter and UNC paths are Windows-style and case-folded. POSIX paths
 * preserve case: Linux and case-sensitive APFS may contain distinct siblings.
 * The native ownership boundary canonicalizes filesystem identities separately.
 */
export function workspaceKey(path: string): string {
  const slashed = path.replaceAll("\\", "/");
  const normalized = slashed === "/" ? slashed : slashed.replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}
