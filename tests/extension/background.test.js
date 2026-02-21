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

  test('long text without sentence breaks is returned as-is', () => {
    const text = 'a'.repeat(600);
    const result = chunkText(text, 500);
    // No sentence boundary — returned as single chunk
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(text);
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
});
