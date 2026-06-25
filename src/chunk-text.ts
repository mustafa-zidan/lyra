// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Split text at sentence boundaries into chunks of at most `maxLen` characters.
 *
 * Exported as an ES module so it can be imported in Node.js unit tests while
 * background.ts remains a plain script for cross-browser compatibility.
 */
export function chunkText(text: string, maxLen = 500): string[] {
    const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [text];
    const chunks: string[] = [];
    let current = '';

    for (const sentence of sentences) {
        if (current.length + sentence.length > maxLen && current.length > 0) {
            chunks.push(current.trim());
            current = '';
        }
        current += sentence;
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks.length > 0 ? chunks : [text];
}