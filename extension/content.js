// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Lyra TTS - Content Script
 *
 * Injected into every page. Responsible for:
 *  - Showing a floating playback-status bar at the bottom of the page
 *  - Highlighting the sentence currently being spoken
 *  - Listening for messages from the background worker
 *  - Providing selected text back to the popup on request
 */

'use strict';

(function () {
  // Guard against double-injection
  if (window.__lyraLoaded) return;
  window.__lyraLoaded = true;

  // ---------------------------------------------------------------------------
  // Highlight state
  // ---------------------------------------------------------------------------

  /** @type {{ node: Text; start: number; end: number }[]} */
  let textIndex = [];
  /** Concatenated plain text of the whole body, matching textIndex offsets. */
  let fullText = '';
  /** Whether the CSS Custom Highlight API is available. */
  const hasCSSHighlight =
    typeof CSS !== 'undefined' &&
    typeof CSS.highlights !== 'undefined' &&
    typeof Highlight !== 'undefined';

  /** Inject the ::highlight(lyra-reading) style once. */
  function injectHighlightStyle() {
    if (document.getElementById('__lyra-hl-style')) return;
    const style = document.createElement('style');
    style.id = '__lyra-hl-style';
    style.textContent = `
      ::highlight(lyra-reading) {
        background-color: #fef08a;
        color: #1c1917;
      }
      .lyra-reading-mark {
        background-color: #fef08a;
        color: #1c1917;
        border-radius: 2px;
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * Walk all text nodes inside `root` and build an index.
   * Sets module-level `textIndex` and `fullText`.
   */
  function buildTextIndex(root = document.body) {
    textIndex = [];
    fullText = '';

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        // Skip script/style/noscript content
        const tag = node.parentElement?.tagName?.toUpperCase() ?? '';
        if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA'].includes(tag)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let offset = 0;
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent;
      textIndex.push({ node, start: offset, end: offset + text.length });
      fullText += text;
      offset += text.length;
    }
  }

  /**
   * Highlight `chunkText` in the page by finding it in the text index and
   * applying a visual highlight, then scrolling it into view.
   *
   * Uses the CSS Custom Highlight API when available; falls back to wrapping
   * matching text nodes in <mark> elements.
   */
  function highlightChunk(chunkText) {
    clearHighlight();
    if (!chunkText || textIndex.length === 0) return;

    // Normalise whitespace for matching
    const needle = chunkText.trim().replace(/\s+/g, ' ');
    const haystack = fullText.replace(/\s+/g, ' ');
    const idx = haystack.indexOf(needle);
    if (idx === -1) return;

    // Map character offset back to original (non-normalised) positions.
    // Because we normalise both strings the same way this is a best-effort
    // approximation; good enough for sentence-length chunks.
    const start = idx;
    const end = idx + needle.length;

    const range = buildRange(start, end);
    if (!range) return;

    // Scroll the highlighted range into view
    const rect = range.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > window.innerHeight) {
      range.startContainer.parentElement?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }

    if (hasCSSHighlight) {
      CSS.highlights.set('lyra-reading', new Highlight(range));
    } else {
      applyMarkFallback(range);
    }
  }

  /**
   * Build a DOM Range spanning offsets [start, end) in `fullText`.
   * @returns {Range|null}
   */
  function buildRange(start, end) {
    let startNode = null,
      startOffset = 0,
      endNode = null,
      endOffset = 0;

    for (const entry of textIndex) {
      if (startNode === null && entry.end > start) {
        startNode = entry.node;
        startOffset = start - entry.start;
      }
      if (endNode === null && entry.end >= end) {
        endNode = entry.node;
        endOffset = end - entry.start;
        break;
      }
    }

    if (!startNode || !endNode) return null;

    try {
      const range = document.createRange();
      range.setStart(startNode, Math.min(startOffset, startNode.length));
      range.setEnd(endNode, Math.min(endOffset, endNode.length));
      return range;
    } catch {
      return null;
    }
  }

  /** Wrap range in <mark class="lyra-reading-mark"> elements (fallback). */
  function applyMarkFallback(range) {
    try {
      const mark = document.createElement('mark');
      mark.className = 'lyra-reading-mark';
      range.surroundContents(mark);
    } catch {
      // surroundContents fails when range crosses element boundaries — ignore
    }
  }

  /** Remove all highlights applied by Lyra. */
  function clearHighlight() {
    if (hasCSSHighlight) {
      CSS.highlights.delete('lyra-reading');
    }
    // Also clean up any fallback marks
    for (const mark of document.querySelectorAll('mark.lyra-reading-mark')) {
      const parent = mark.parentNode;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
    }
  }

  // ---------------------------------------------------------------------------
  // Status bar UI
  // ---------------------------------------------------------------------------

  let statusBar = null;

  function getOrCreateStatusBar() {
    if (statusBar) return statusBar;

    statusBar = document.createElement('div');
    statusBar.id = '__lyra-status';
    Object.assign(statusBar.style, {
      position: 'fixed',
      bottom: '0',
      left: '0',
      right: '0',
      zIndex: '2147483647',
      background: 'rgba(30, 27, 75, 0.95)',
      color: '#e0e7ff',
      fontFamily: 'system-ui, sans-serif',
      fontSize: '14px',
      padding: '10px 20px',
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      boxShadow: '0 -2px 12px rgba(0,0,0,0.3)',
      backdropFilter: 'blur(4px)',
      transition: 'transform 0.25s ease',
      transform: 'translateY(100%)',
    });

    const icon = document.createElement('span');
    icon.textContent = '🔊';
    icon.style.fontSize = '18px';

    const label = document.createElement('span');
    label.id = '__lyra-label';
    label.textContent = 'Preparing…';
    label.style.flex = '1';

    const stopBtn = document.createElement('button');
    stopBtn.textContent = 'Stop';
    Object.assign(stopBtn.style, {
      background: 'rgba(255,255,255,0.15)',
      border: '1px solid rgba(255,255,255,0.3)',
      color: '#fff',
      borderRadius: '6px',
      padding: '4px 14px',
      cursor: 'pointer',
      fontSize: '13px',
    });
    stopBtn.addEventListener('click', () => {
      hideStatusBar();
      clearHighlight();
      chrome.runtime.sendMessage({ action: 'stop' });
    });

    statusBar.append(icon, label, stopBtn);
    document.body.appendChild(statusBar);
    return statusBar;
  }

  function showStatusBar(text) {
    const bar = getOrCreateStatusBar();
    const label = document.getElementById('__lyra-label');
    if (label) label.textContent = text;
    bar.style.transform = 'translateY(0)';
  }

  function hideStatusBar() {
    if (statusBar) statusBar.style.transform = 'translateY(100%)';
  }

  // ---------------------------------------------------------------------------
  // Message listener
  // ---------------------------------------------------------------------------

  const api = typeof browser !== 'undefined' ? browser : chrome;

  injectHighlightStyle();

  api.runtime.onMessage.addListener((message) => {
    switch (message.action) {
      case 'playback-started':
        buildTextIndex();
        showStatusBar('Reading aloud…');
        break;

      case 'chunk-highlight':
        if (message.text) {
          highlightChunk(message.text);
        } else {
          clearHighlight();
        }
        break;

      case 'playback-finished':
        clearHighlight();
        showStatusBar('Done.');
        setTimeout(hideStatusBar, 1500);
        break;

      case 'playback-stopped':
        clearHighlight();
        hideStatusBar();
        break;

      case 'playback-error':
        clearHighlight();
        showStatusBar(`Error: ${message.error}`);
        setTimeout(hideStatusBar, 4000);
        break;

      case 'get-selection':
        return Promise.resolve({
          text: window.getSelection()?.toString()?.trim() ?? '',
        });
    }
  });
})();
