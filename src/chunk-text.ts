// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Split text into chunks of at most `maxLen` characters, for speaking one at a time.
 *
 * Chunks break at sentence marks (Latin, CJK 。！？ and Devanagari ।) and line breaks,
 * and pack as many whole sentences as fit. A sentence longer than the limit is cut
 * at a comma or a space (or hard, for a run with neither), so no chunk ever exceeds
 * the limit: one huge chunk is slow to generate and the server rejects text over
 * 5000 characters, which used to end reading of long pages partway through.
 *
 * `firstMaxLen` caps the first chunk separately, so reading starts after generating a
 * short passage instead of a full-size one.
 *
 * The background service worker (an ES module) imports this, and so do the Node.js
 * unit tests, so the tests cover the code that actually runs.
 */
export function chunkText(text: string, maxLen = 500, firstMaxLen = maxLen): string[] {
  const pieces = (text.match(/[^.!?。！？｡।\n]*(?:[.!?。！？｡।]+|\n+|$)/g) ?? [text]).filter(
    Boolean,
  );
  const chunks: string[] = [];
  let current = '';

  for (let rest of pieces) {
    while (rest) {
      const limit = chunks.length === 0 ? firstMaxLen : maxLen;
      if (current.length + rest.length <= limit) {
        current += rest;
        break;
      }
      if (current.trim()) {
        chunks.push(current.trim());
        current = '';
        continue;
      }
      // Nothing buffered and the sentence alone is too long: cut it.
      rest = current + rest;
      current = '';
      const cut = cutPoint(rest, limit);
      const head = rest.slice(0, cut).trim();
      if (head) chunks.push(head);
      rest = rest.slice(cut);
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [text];
}

/** Where to cut `s` so the head is at most `limit` long: after a comma, else a space. */
function cutPoint(s: string, limit: number): number {
  const head = s.slice(0, limit + 1);
  const clause = Math.max(...[',', ';', ':', '，', '、', '；'].map((m) => head.lastIndexOf(m)));
  if (clause >= limit / 2 && clause < limit) return clause + 1;
  const space = head.search(/\s\S*$/);
  if (space > 0) return space;
  return limit;
}
