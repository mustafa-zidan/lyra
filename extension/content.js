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
    if (window.__lyraLoaded)
        return;
    window.__lyraLoaded = true;
    let textIndex = [];
    /** Concatenated plain text of the whole body, matching textIndex offsets. */
    let fullText = '';
    /** Whether the CSS Custom Highlight API is available. */
    const hasCSSHighlight = typeof CSS !== 'undefined' &&
        typeof CSS.highlights !== 'undefined' &&
        typeof Highlight !== 'undefined';
    /** Inject the ::highlight(lyra-reading) style once. */
    function injectHighlightStyle() {
        if (document.getElementById('__lyra-hl-style'))
            return;
        const style = document.createElement('style');
        style.id = '__lyra-hl-style';
        style.textContent = `
      ::highlight(lyra-reading) {
        background-color: #000;
        color: #fff;
      }
      .lyra-reading-mark {
        background-color: #000;
        color: #fff;
        border-radius: 0;
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
            const text = node.textContent ?? '';
            textIndex.push({ node: node, start: offset, end: offset + text.length });
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
        if (!chunkText || textIndex.length === 0)
            return;
        // Normalise whitespace for matching
        const needle = chunkText.trim().replace(/\s+/g, ' ');
        const haystack = fullText.replace(/\s+/g, ' ');
        const idx = haystack.indexOf(needle);
        if (idx === -1)
            return;
        // Map character offset back to original (non-normalised) positions.
        // Because we normalise both strings the same way this is a best-effort
        // approximation; good enough for sentence-length chunks.
        const start = idx;
        const end = idx + needle.length;
        const range = buildRange(start, end);
        if (!range)
            return;
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
        }
        else {
            applyMarkFallback(range);
        }
    }
    /**
     * Build a DOM Range spanning offsets [start, end) in `fullText`.
     */
    function buildRange(start, end) {
        let startNode = null;
        let startOffset = 0;
        let endNode = null;
        let endOffset = 0;
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
        if (!startNode || !endNode)
            return null;
        try {
            const range = document.createRange();
            range.setStart(startNode, Math.min(startOffset, startNode.length));
            range.setEnd(endNode, Math.min(endOffset, endNode.length));
            return range;
        }
        catch {
            return null;
        }
    }
    /** Wrap range in <mark class="lyra-reading-mark"> elements (fallback). */
    function applyMarkFallback(range) {
        try {
            const mark = document.createElement('mark');
            mark.className = 'lyra-reading-mark';
            range.surroundContents(mark);
        }
        catch {
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
            while (mark.firstChild)
                parent.insertBefore(mark.firstChild, mark);
            parent.removeChild(mark);
        }
    }
    // ---------------------------------------------------------------------------
    // Status bar UI
    // ---------------------------------------------------------------------------
    let statusBar = null;
    function getOrCreateStatusBar() {
        if (statusBar)
            return statusBar;
        statusBar = document.createElement('div');
        statusBar.id = '__lyra-status';
        Object.assign(statusBar.style, {
            position: 'fixed',
            bottom: '20px',
            right: '20px',
            left: 'auto',
            zIndex: '2147483647',
            maxWidth: '320px',
            background: '#111',
            color: '#fff',
            fontFamily: 'system-ui, sans-serif',
            fontSize: '13px',
            fontWeight: '500',
            padding: '8px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            borderRadius: '2px',
            boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
            transition: 'opacity 0.2s ease, transform 0.2s ease',
            opacity: '0',
            transform: 'translateY(8px)',
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
            background: 'transparent',
            border: '1px solid rgba(255,255,255,0.5)',
            color: '#fff',
            borderRadius: '2px',
            padding: '4px 12px',
            cursor: 'pointer',
            fontSize: '12px',
            fontWeight: '600',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
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
        if (label)
            label.textContent = text;
        bar.style.opacity = '1';
        bar.style.transform = 'translateY(0)';
    }
    function hideStatusBar() {
        if (statusBar) {
            statusBar.style.opacity = '0';
            statusBar.style.transform = 'translateY(8px)';
        }
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
                }
                else {
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
