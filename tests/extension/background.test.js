// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Unit tests for pure utility functions in background.js.
 * These run in a plain Node context (no browser required).
 */
import { test, expect } from '@playwright/test';
import { chunkText } from '../../extension/chunk-text.js';

test.describe('chunkText()', () => {
  test('single short sentence stays as one chunk', () => {
    const result = chunkText('Hello, world!');
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('Hello, world!');
  });

  test('splits at sentence boundaries', () => {
    const text = 'First sentence. Second sentence. Third sentence.';
    const result = chunkText(text, 30);
    // Each sentence is ~17 chars — with maxLen=30 each becomes its own chunk
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(60); // generous upper bound
    }
  });

  test('long text without sentence breaks is cut at spaces under maxLen', () => {
    const text = 'word '.repeat(300).trim(); // 1499 chars, no sentence marks
    const result = chunkText(text, 500);
    expect(result.length).toBeGreaterThan(2);
    for (const chunk of result) expect(chunk.length).toBeLessThanOrEqual(500);
    expect(result.join(' ')).toBe(text);
  });

  test('a run with no spaces is still cut at maxLen', () => {
    const text = 'a'.repeat(1200);
    const result = chunkText(text, 500);
    expect(result).toEqual(['a'.repeat(500), 'a'.repeat(500), 'a'.repeat(200)]);
  });

  test('prefers cutting a long sentence after a comma', () => {
    const text = `${'x'.repeat(30)}, ${'y '.repeat(20)}end`;
    const [first] = chunkText(text, 40);
    expect(first).toBe(`${'x'.repeat(30)},`);
  });

  test('line breaks end a sentence, so lists without full stops still split', () => {
    const text = Array.from({ length: 200 }, (_, i) => `List item number ${i}`).join('\n');
    const result = chunkText(text, 500);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(500);
      expect(chunk).toMatch(/^List item number \d+/); // never cut inside an item
    }
  });

  test('a long page never yields a chunk the server would reject', () => {
    const paragraph = `${'Lorem ipsum dolor sit amet consectetur '.repeat(200)}\n\n`;
    const result = chunkText(paragraph.repeat(20), 450, 180);
    for (const chunk of result) expect(chunk.length).toBeLessThanOrEqual(450);
  });

  test('firstMaxLen keeps the first chunk short so reading starts quickly', () => {
    const text = 'This is a sentence of moderate length. '.repeat(30);
    const result = chunkText(text, 450, 180);
    expect(result[0].length).toBeLessThanOrEqual(180);
    expect(result[1].length).toBeGreaterThan(180);
    expect(result.join(' ')).toBe(text.trim());
  });

  test('empty string returns single empty chunk array item', () => {
    const result = chunkText('');
    expect(result).toHaveLength(1);
  });

  test('batches short sentences together under maxLen', () => {
    const text = 'Hi. Bye. Ok.';
    const result = chunkText(text, 500); // well within limit
    // All sentences fit in one chunk
    expect(result).toHaveLength(1);
  });

  test('respects exclamation and question mark boundaries', () => {
    const text = 'Really? Yes! Great.';
    const result = chunkText(text, 10);
    expect(result.length).toBeGreaterThan(1);
  });

  test('splits at CJK and Devanagari sentence marks', () => {
    expect(chunkText('今日はいい天気ですね。散歩しましょう！', 12)).toEqual([
      '今日はいい天気ですね。',
      '散歩しましょう！',
    ]);
    expect(chunkText('नमस्ते। आप कैसे हैं?', 14)).toEqual(['नमस्ते।', 'आप कैसे हैं?']);
  });
});
