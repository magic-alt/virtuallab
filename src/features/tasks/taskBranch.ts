/** Keep task branches readable on every platform; Native uses the same algorithm. */
export function suggestTaskBranch(title: string, taskId: string): string {
  const encoder = new TextEncoder();
  let slug = '';
  let separator = false;
  for (const character of title.toLowerCase()) {
    if (!/[\p{Alphabetic}\p{N}]/u.test(character)) {
      separator = !!slug;
      continue;
    }
    const next = slug + (separator ? '-' : '') + character;
    if (encoder.encode(next).byteLength > 72) break;
    slug = next;
    separator = false;
  }
  let hash = 0xcbf29ce484222325n;
  for (const byte of encoder.encode(taskId)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return `task/${slug || 'work'}-${hash.toString(16).padStart(16, '0').slice(-12)}`;
}
