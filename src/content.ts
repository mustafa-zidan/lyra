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
    if ((window as Window & { __lyraLoaded?: boolean }).__lyraLoaded) return;
    (window as Window & { __lyraLoaded?: boolean }).__lyraLoaded = true;

    // ---------------------------------------------------------------------------
    // Highlight state
    // ---------------------------------------------------------------------------

    interface TextEntry {
        node: Text;
        start: number;
        end: number;
    }

    let textIndex: TextEntry[] = [];
    /** Concatenated plain text of the whole body, matching textIndex offsets. */
    let fullText = '';
    /** Whether the CSS Custom Highlight API is available. */
    const hasCSSHighlight =
        typeof CSS !== 'undefined' &&
        typeof (CSS as { highlights?: unknown }).highlights !== 'undefined' &&
        typeof Highlight !== 'undefined';

    /** Inject the ::highlight(lyra-reading) style once. */
    function injectHighlightStyle(): void {
        if (document.getElementById('__lyra-hl-style')) return;
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
    function buildTextIndex(root: Element = document.body): void {
        textIndex = [];
        fullText = '';

        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                // Skip script/style/noscript content
                const tag = (node as Text).parentElement?.tagName?.toUpperCase() ?? '';
                if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA'].includes(tag)) {
                    return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            },
        });

        let offset = 0;
        let node: Node | null;
        while ((node = walker.nextNode())) {
            const text = (node as Text).textContent ?? '';
            textIndex.push({node: node as Text, start: offset, end: offset + text.length});
            fullText += text;
            offset += text.length;
        }
    }

    /**
     * Build a mapping from normalised-string index → original-string index.
     * Normalisation collapses runs of whitespace into a single space.
     */
    function buildNormalisationMap(original: string): number[] {
        const map: number[] = [];
        let inSpace = false;
        for (let i = 0; i < original.length; i++) {
            const isWS = /\s/.test(original[i]);
            if (isWS) {
                if (!inSpace) {
                    map.push(i); // the single normalised space maps to this position
                    inSpace = true;
                }
                // skip subsequent whitespace chars (collapsed away)
            } else {
                map.push(i);
                inSpace = false;
            }
        }
        return map;
    }

    /**
     * Highlight `chunkText` in the page by finding it in the text index and
     * applying a visual highlight, then scrolling it into view.
     *
     * Uses the CSS Custom Highlight API when available; falls back to wrapping
     * matching text nodes in <mark> elements.
     */
    function highlightChunk(chunkText: string): void {
        clearHighlight();
        if (!chunkText || textIndex.length === 0) return;

        // Normalise whitespace for matching
        const needle = chunkText.trim().replace(/\s+/g, ' ');
        const haystack = fullText.replace(/\s+/g, ' ');
        const idx = haystack.indexOf(needle);
        if (idx === -1) return;

        // Map normalised offsets back to original fullText positions.
        // Walk fullText, tracking where each normalised character maps to.
        const normToOrig = buildNormalisationMap(fullText);
        const start = normToOrig[idx];
        const end = idx + needle.length < normToOrig.length
            ? normToOrig[idx + needle.length]
            : fullText.length;

        const range = buildRange(start, end);
        if (!range) return;

        // Scroll the highlighted range into view
        const rect = range.getBoundingClientRect();
        if (rect.top < 0 || rect.bottom > window.innerHeight) {
            (range.startContainer as Element).parentElement?.scrollIntoView({
                behavior: 'smooth',
                block: 'center',
            });
        }

        if (hasCSSHighlight) {
            (CSS as { highlights: { set(name: string, h: Highlight): void } }).highlights.set(
                'lyra-reading',
                new Highlight(range),
            );
        } else {
            applyMarkFallback(range);
        }
    }

    /**
     * Build a DOM Range spanning offsets [start, end) in `fullText`.
     */
    function buildRange(start: number, end: number): Range | null {
        let startNode: Text | null = null;
        let startOffset = 0;
        let endNode: Text | null = null;
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
    function applyMarkFallback(range: Range): void {
        try {
            const mark = document.createElement('mark');
            mark.className = 'lyra-reading-mark';
            range.surroundContents(mark);
        } catch {
            // surroundContents fails when range crosses element boundaries — ignore
        }
    }

    /** Remove all highlights applied by Lyra. */
    function clearHighlight(): void {
        if (hasCSSHighlight) {
            (CSS as { highlights: { delete(name: string): void } }).highlights.delete('lyra-reading');
        }
        // Also clean up any fallback marks
        for (const mark of document.querySelectorAll('mark.lyra-reading-mark')) {
            const parent = mark.parentNode!;
            while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
            parent.removeChild(mark);
        }
    }

    // ---------------------------------------------------------------------------
    // Status bar UI
    // ---------------------------------------------------------------------------

    let statusBar: HTMLDivElement | null = null;

    function getOrCreateStatusBar(): HTMLDivElement {
        if (statusBar) return statusBar;

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
            chrome.runtime.sendMessage({action: 'stop'});
        });

        statusBar.append(icon, label, stopBtn);
        document.body.appendChild(statusBar);
        return statusBar;
    }

    function showStatusBar(text: string): void {
        const bar = getOrCreateStatusBar();
        const label = document.getElementById('__lyra-label');
        if (label) label.textContent = text;
        bar.style.opacity = '1';
        bar.style.transform = 'translateY(0)';
    }

    function hideStatusBar(): void {
        if (statusBar) {
            statusBar.style.opacity = '0';
            statusBar.style.transform = 'translateY(8px)';
        }
    }

    // ---------------------------------------------------------------------------
    // Message listener
    // ---------------------------------------------------------------------------

    const api: typeof chrome = typeof browser !== 'undefined' ? browser : chrome;

    injectHighlightStyle();

    api.runtime.onMessage.addListener((message) => {
        switch ((message as { action: string }).action) {
            case 'playback-started':
                buildTextIndex();
                showStatusBar('Reading aloud…');
                break;

            case 'chunk-highlight':
                if ((message as { text?: string }).text) {
                    highlightChunk((message as { text: string }).text);
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
                showStatusBar(`Error: ${(message as { error: string }).error}`);
                setTimeout(hideStatusBar, 4000);
                break;

            case 'get-selection':
                return Promise.resolve({
                    text: window.getSelection()?.toString()?.trim() ?? '',
                });
        }
    });
})();
