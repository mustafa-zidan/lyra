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
        background-color: rgba(109, 94, 240, 0.22);
      }
      .lyra-reading-mark {
        background-color: rgba(109, 94, 240, 0.22);
        color: inherit;
        border-radius: 3px;
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
                const parent = node.parentElement;
                // Skip script/style/noscript content
                const tag = parent?.tagName?.toUpperCase() ?? '';
                if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA'].includes(tag)) {
                    return NodeFilter.FILTER_REJECT;
                }
                // Skip Lyra's own injected UI (status bar, selection button) so their
                // labels can't corrupt highlight text matching.
                if (parent?.closest('[id^="__lyra"]')) {
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
     * Build a mapping from normalised-string index → original-string index.
     * Normalisation collapses runs of whitespace into a single space.
     */
    function buildNormalisationMap(original) {
        const map = [];
        let inSpace = false;
        for (let i = 0; i < original.length; i++) {
            const isWS = /\s/.test(original[i]);
            if (isWS) {
                if (!inSpace) {
                    map.push(i); // the single normalised space maps to this position
                    inSpace = true;
                }
                // skip subsequent whitespace chars (collapsed away)
            }
            else {
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
        // Map normalised offsets back to original fullText positions.
        // Walk fullText, tracking where each normalised character maps to.
        const normToOrig = buildNormalisationMap(fullText);
        const start = normToOrig[idx];
        const end = idx + needle.length < normToOrig.length ? normToOrig[idx + needle.length] : fullText.length;
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
            maxWidth: '340px',
            background: '#ffffff',
            color: '#1b1b2a',
            fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
            fontSize: '13px',
            fontWeight: '500',
            padding: '10px 12px 10px 15px',
            display: 'flex',
            alignItems: 'center',
            gap: '11px',
            border: '1px solid #e7e7ef',
            borderRadius: '12px',
            boxShadow: '0 6px 22px rgba(27,27,42,0.16)',
            transition: 'opacity 0.2s ease, transform 0.2s ease',
            opacity: '0',
            transform: 'translateY(100%)',
        });
        const icon = document.createElement('span');
        Object.assign(icon.style, {
            width: '9px',
            height: '9px',
            borderRadius: '50%',
            background: '#6d5ef0',
            boxShadow: '0 0 0 4px rgba(109,94,240,0.18)',
            flex: 'none',
        });
        const label = document.createElement('span');
        label.id = '__lyra-label';
        label.textContent = 'Preparing…';
        Object.assign(label.style, {
            flex: '1',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
        });
        const stopBtn = document.createElement('button');
        stopBtn.textContent = 'Stop';
        Object.assign(stopBtn.style, {
            background: '#fff4f4',
            border: '1px solid #f4cccd',
            color: '#e5484d',
            borderRadius: '7px',
            padding: '5px 13px',
            cursor: 'pointer',
            fontSize: '12px',
            fontWeight: '600',
            fontFamily: 'inherit',
            flex: 'none',
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
            statusBar.style.transform = 'translateY(100%)';
        }
    }
    // ---------------------------------------------------------------------------
    // Message listener
    // ---------------------------------------------------------------------------
    const api = typeof browser !== 'undefined' ? browser : chrome;
    injectHighlightStyle();
    let currentAudio = null;
    /**
     * Decode a raw base64 WAV string and play it, resolving when playback ends
     * (or is stopped). decodeAudioData on an ArrayBuffer is not subject to the
     * page's media-src CSP, unlike a `new Audio(dataUrl)`.
     */
    async function playAudio(base64Wav) {
        stopAudio(); // halt anything still playing
        const binary = atob(base64Wav);
        const buf = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++)
            buf[i] = binary.charCodeAt(i);
        const ctx = new AudioContext();
        const state = { ctx, source: null, stopped: false, finish: null };
        currentAudio = state;
        if (ctx.state === 'suspended')
            await ctx.resume();
        let decoded;
        try {
            decoded = await ctx.decodeAudioData(buf.buffer);
        }
        catch {
            if (ctx.state !== 'closed')
                ctx.close();
            if (currentAudio === state)
                currentAudio = null;
            return;
        }
        // Stop may have been requested while we were resuming/decoding.
        if (state.stopped) {
            if (ctx.state !== 'closed')
                ctx.close();
            return;
        }
        const source = ctx.createBufferSource();
        state.source = source;
        source.buffer = decoded;
        source.connect(ctx.destination);
        await new Promise((resolve) => {
            const finish = () => {
                state.finish = null;
                if (ctx.state !== 'closed')
                    ctx.close();
                if (currentAudio === state)
                    currentAudio = null;
                resolve();
            };
            state.finish = finish;
            source.onended = finish;
            source.start(0);
        });
    }
    /** Immediately stop any audio started by playAudio. */
    function stopAudio() {
        const state = currentAudio;
        if (!state)
            return;
        state.stopped = true;
        try {
            state.source?.stop();
        }
        catch {
            // source may not have started yet — ignore
        }
        state.finish?.();
        try {
            if (state.ctx.state !== 'closed')
                state.ctx.close();
        }
        catch {
            // context already closed — ignore
        }
        currentAudio = null;
    }
    // ---------------------------------------------------------------------------
    // Floating "Listen" button shown next to a text selection (DeepL-style)
    // ---------------------------------------------------------------------------
    let selectionButton = null;
    let isMouseDown = false;
    function getOrCreateSelectionButton() {
        if (selectionButton)
            return selectionButton;
        const btn = document.createElement('button');
        btn.id = '__lyra-selection-btn';
        btn.type = 'button';
        btn.setAttribute('aria-label', 'Read selection aloud with Lyra');
        Object.assign(btn.style, {
            position: 'fixed',
            zIndex: '2147483647',
            display: 'none',
            alignItems: 'center',
            gap: '6px',
            background: '#6d5ef0',
            color: '#ffffff',
            border: 'none',
            borderRadius: '8px',
            padding: '6px 11px',
            fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
            fontSize: '12px',
            fontWeight: '600',
            lineHeight: '1',
            cursor: 'pointer',
            boxShadow: '0 4px 14px rgba(27,27,42,0.28)',
        });
        btn.innerHTML =
            '<span aria-hidden="true" style="font-size:13px;line-height:1">🔊</span><span>Listen</span>';
        // Pressing the button must not collapse the current selection, and our own
        // mouse events must not bubble to the document (which would hide it).
        btn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
        btn.addEventListener('mouseup', (e) => e.stopPropagation());
        btn.addEventListener('click', onSelectionButtonClick);
        document.body.appendChild(btn);
        selectionButton = btn;
        return btn;
    }
    function showSelectionButton() {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
            hideSelectionButton();
            return;
        }
        const text = sel.toString().trim();
        if (!text) {
            hideSelectionButton();
            return;
        }
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) {
            hideSelectionButton();
            return;
        }
        const btn = getOrCreateSelectionButton();
        btn.style.display = 'inline-flex';
        // Position just above the start of the selection. DeepL (and most
        // translate/dictionary tools) render their own toolbar *below* the
        // selection, so going above avoids overlapping/hiding under them.
        // Flip below only when there isn't room above. Clamp to the viewport.
        const bw = btn.offsetWidth;
        const bh = btn.offsetHeight;
        let left = rect.left;
        let top = rect.top - bh - 8;
        if (top < 4) {
            top = rect.bottom + 8; // no room above → place below
        }
        top = Math.min(top, window.innerHeight - bh - 4);
        left = Math.max(4, Math.min(left, window.innerWidth - bw - 4));
        btn.style.left = `${left}px`;
        btn.style.top = `${top}px`;
    }
    function hideSelectionButton() {
        if (selectionButton)
            selectionButton.style.display = 'none';
    }
    /** BCP-47 language of the selection: nearest `lang` attribute, else the document's. */
    function selectionLanguage() {
        const node = window.getSelection()?.anchorNode;
        const el = node instanceof Element ? node : node?.parentElement;
        const lang = el?.closest('[lang]')?.getAttribute('lang') || document.documentElement.lang;
        return lang?.trim() || undefined;
    }
    async function onSelectionButtonClick(e) {
        e.preventDefault();
        e.stopPropagation();
        const text = window.getSelection()?.toString()?.trim();
        const language = selectionLanguage();
        hideSelectionButton();
        if (!text)
            return;
        try {
            await api.runtime.sendMessage({ action: 'speak', text, language });
        }
        catch {
            // Background unavailable — ignore.
        }
    }
    // Show the button after a mouse-drag selection; hide it when a new
    // interaction starts or the selection is cleared.
    document.addEventListener('mousedown', () => {
        isMouseDown = true;
        hideSelectionButton();
    });
    document.addEventListener('mouseup', () => {
        isMouseDown = false;
        // Defer so the selection is finalised before we read it.
        setTimeout(showSelectionButton, 0);
    });
    // Double-click word selection is only finalised on `dblclick` (after the
    // second mouseup), so the mouseup handler above runs too early to see it.
    // Re-check here once the word selection has settled.
    document.addEventListener('dblclick', () => {
        isMouseDown = false;
        setTimeout(showSelectionButton, 0);
    });
    document.addEventListener('selectionchange', () => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.toString().trim()) {
            hideSelectionButton();
        }
        else if (!isMouseDown) {
            // Keyboard-driven selection (Shift+Arrows, Ctrl+A …).
            showSelectionButton();
        }
    });
    document.addEventListener('scroll', hideSelectionButton, true);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape')
            hideSelectionButton();
    });
    // ---------------------------------------------------------------------------
    // Message listener
    // ---------------------------------------------------------------------------
    api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
            case 'play-audio':
                // Resolve the background's tabs.sendMessage when the chunk finishes,
                // so it can sequence the next chunk. `return true` keeps the channel
                // open for the async sendResponse (required by Chrome).
                playAudio(message.audio)
                    .then(() => sendResponse({ done: true }))
                    .catch(() => sendResponse({ done: false }));
                return true;
            case 'stop-audio':
                stopAudio();
                break;
            case 'playback-finished':
                clearHighlight();
                showStatusBar('Done.');
                setTimeout(hideStatusBar, 1500);
                break;
            case 'playback-stopped':
                stopAudio();
                clearHighlight();
                hideStatusBar();
                break;
            case 'playback-error':
                stopAudio();
                clearHighlight();
                showStatusBar(`Error: ${message.error}`);
                setTimeout(hideStatusBar, 4000);
                break;
            case 'get-selection':
                return Promise.resolve({
                    text: window.getSelection()?.toString()?.trim() ?? '',
                    language: selectionLanguage(),
                });
        }
    });
})();
