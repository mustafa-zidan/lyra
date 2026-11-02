// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Lyra TTS - Content Script
 *
 * Injected into every page. Responsible for:
 *  - Showing a floating playback-status bar at the bottom of the page
 *  - Running the read: asking the background for each chunk's audio (a few
 *    chunks ahead of the one playing), playing them back to back and
 *    highlighting the chunk being spoken
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
  /** `fullText` with whitespace runs collapsed to one space, for matching chunks. */
  let normText = '';
  /** normText index → fullText index (see buildNormalisationMap). */
  let normToOrig: number[] = [];
  /**
   * Where the last highlighted chunk ended in normText. Chunks arrive in reading order,
   * so the next one is searched for from here: a sentence that also appears earlier on the
   * page (a repeated heading, a nav label) must not pull the highlight back to that copy.
   */
  let matchCursor = 0;

  /** A word of the page (or of a chunk), lowercased, with its [start, end) in the source text. */
  interface Word {
    text: string;
    start: number;
    end: number;
  }

  /** Words of `fullText`, for the fuzzy fallback when a chunk isn't on the page verbatim. */
  let pageWords: Word[] = [];
  /** Word text → its indices in pageWords, ascending. */
  let wordPositions = new Map<string, number[]>();

  /**
   * Runs of letters and digits; each Chinese/Japanese character is a word of its own,
   * since those scripts don't put spaces between words. Punctuation is dropped, so smart
   * and straight quotes, dashes and footnote brackets can't stop a match.
   */
  const WORD_RE =
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])[\p{L}\p{N}\p{M}])+/gu;

  /** Most words the fuzzy match may skip, on both sides together, at one mismatch. */
  const MAX_SKIP = 3;
  /** Most page occurrences of one word tried as an anchor (bounds work on common words). */
  const MAX_ANCHOR_CANDIDATES = 50;

  function toWords(text: string): Word[] {
    return Array.from(text.matchAll(WORD_RE), (m) => ({
      text: m[0].toLowerCase(),
      start: m.index,
      end: m.index + m[0].length,
    }));
  }

  /** Whether the CSS Custom Highlight API is available. */
  const hasCSSHighlight =
    typeof CSS !== 'undefined' &&
    typeof (CSS as { highlights?: unknown }).highlights !== 'undefined' &&
    typeof Highlight !== 'undefined';

  /** The saved settings this script uses; the defaults match settings.ts. */
  interface DisplaySettings {
    highlightColor: string;
    highlightStyle: 'background' | 'underline' | 'both';
    highContrast: boolean;
    /** Alt+click a paragraph to read from there to the end. */
    clickToRead: boolean;
    /** Highlight the spoken word, and narrow the passage highlight to its sentence. */
    wordHighlight: boolean;
    wordColor: string;
    /** Reading aid: a ruler band on the current line, or dim all but the paragraph. */
    focusMode: FocusMode;
  }

  type FocusMode = 'off' | 'ruler' | 'spotlight';

  const display: DisplaySettings = {
    highlightColor: '#dcd7fc',
    highlightStyle: 'background',
    highContrast: false,
    clickToRead: true,
    wordHighlight: true,
    wordColor: '#ffd84d',
    focusMode: 'off',
  };

  /** Only #rrggbb from storage goes into the stylesheet. */
  const safeColor = (value: string, fallback: string) =>
    /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;

  /** Declarations for `::highlight(lyra-reading)`, from the user's colour, style and contrast. */
  function highlightCss(): string {
    const color = safeColor(display.highlightColor, '#dcd7fc');
    if (display.highContrast) return 'background-color: #1b1b2a; color: #ffffff;';
    const underline = `text-decoration: underline 3px color-mix(in srgb, ${color} 55%, #000); text-underline-offset: 3px;`;
    if (display.highlightStyle === 'underline') return underline;
    if (display.highlightStyle === 'both') return `background-color: ${color}; ${underline}`;
    return `background-color: ${color};`;
  }

  /** Inject (or refresh) the highlight styles. */
  function injectHighlightStyle(): void {
    let style = document.getElementById('__lyra-hl-style');
    if (!style) {
      style = document.createElement('style');
      style.id = '__lyra-hl-style';
      document.head.appendChild(style);
    }
    const chunk = highlightCss();
    // The spoken word: a strong colour with dark text, readable on any passage style.
    const word = `background-color: ${safeColor(display.wordColor, '#ffd84d')}; color: #000000;`;
    style.textContent = `
      ::highlight(lyra-reading) { ${chunk} }
      ::highlight(lyra-word) { ${word} }
      .lyra-reading-mark { ${chunk} color: inherit; border-radius: 3px; }
    `;
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
        const parent = (node as Text).parentElement;
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
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = (node as Text).textContent ?? '';
      textIndex.push({ node: node as Text, start: offset, end: offset + text.length });
      fullText += text;
      offset += text.length;
    }
    normText = fullText.replace(/\s+/g, ' ');
    normToOrig = buildNormalisationMap(fullText);
    matchCursor = 0;

    pageWords = toWords(fullText);
    wordPositions = new Map();
    pageWords.forEach((w, i) => {
      const list = wordPositions.get(w.text);
      if (list) list.push(i);
      else wordPositions.set(w.text, [i]);
    });
  }

  /** First index in ascending `arr` whose key is >= `value`. */
  function lowerBound<T>(arr: T[], value: number, key: (item: T) => number): number {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (key(arr[mid]) < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
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
  function highlightChunk(chunkText: string): [number, number] | null {
    clearHighlight();
    if (!chunkText || textIndex.length === 0) return null;

    const span = findExact(chunkText) ?? findFuzzy(chunkText);
    if (!span) return null;
    const range = buildRange(span[0], span[1]);
    if (!range) return null;

    scrollIntoViewIfNeeded(range);
    if (hasCSSHighlight) {
      setHighlight('lyra-reading', range);
    } else {
      focusRange = range;
      applyMarkFallback(range);
    }
    updateFocus();
    return span;
  }

  type HighlightRegistry = {
    set(name: string, h: Highlight): void;
    delete(name: string): void;
  };

  function setHighlight(name: 'lyra-reading' | 'lyra-word', range: Range): void {
    if (name === 'lyra-reading') focusRange = range;
    else focusWord = range;
    const highlight = new Highlight(range);
    if (name === 'lyra-word') highlight.priority = 1; // paint over the sentence
    (CSS as unknown as { highlights: HighlightRegistry }).highlights.set(name, highlight);
  }

  function scrollIntoViewIfNeeded(range: Range): void {
    const rect = range.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > window.innerHeight) {
      (range.startContainer as Element).parentElement?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Word-by-word highlight (#3)
  // ---------------------------------------------------------------------------

  /** One spoken word: when (seconds into the chunk's audio) and where on the page. */
  interface WordCue {
    t0: number;
    t1: number;
    /** The word's [start, end) in fullText. */
    word: [number, number];
    /** Its sentence's [start, end) in fullText. */
    sentence: [number, number];
  }

  /**
   * Sentences of a chunk: up to a run of CJK/Devanagari sentence marks, or of Latin ones
   * followed by a space (so "1.5" or "e.g" mid-word doesn't end one).
   */
  const SENTENCE_RE = /[^]+?(?:[.!?]+(?=\s|$)|[。！？｡।]+|$)/g;

  /**
   * Place the server's word timings (offsets into the chunk text) on the page, inside the
   * chunk's page span. The chunk's words are aligned in order with the page's words there,
   * so text that only one side has (a footnote marker) doesn't throw the rest off.
   */
  function buildWordCues(
    chunkText: string,
    span: [number, number],
    timings: number[][],
  ): WordCue[] {
    if (timings.length === 0) return [];
    const chunk = toWords(chunkText);
    const first = lowerBound(pageWords, span[0], (w) => w.start);
    const toPage = new Array<number>(chunk.length).fill(-1);
    let j = first;
    for (let i = 0; i < chunk.length; i++) {
      for (let k = j; k < j + MAX_SKIP + 1 && k < pageWords.length; k++) {
        if (pageWords[k].start >= span[1]) break;
        const page = pageWords[k].text;
        const w = chunk[i].text;
        if (
          page === w ||
          (i === 0 && page.endsWith(w)) ||
          (i === chunk.length - 1 && page.startsWith(w))
        ) {
          toPage[i] = k;
          j = k + 1;
          break;
        }
      }
    }

    /** Page [start, end) of the chunk words overlapping chunk offsets [a, b), or null. */
    const pageSpan = (a: number, b: number): [number, number] | null => {
      let lo = -1;
      let hi = -1;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i].end <= a || chunk[i].start >= b || toPage[i] === -1) continue;
        if (lo === -1) lo = toPage[i];
        hi = toPage[i];
      }
      return lo === -1 ? null : [pageWords[lo].start, pageWords[hi].end];
    };

    const sentences = Array.from(chunkText.matchAll(SENTENCE_RE), (m) => [
      m.index,
      m.index + m[0].length,
    ]);
    const cues: WordCue[] = [];
    for (const [a, b, t0, t1] of timings) {
      const word = pageSpan(a, b);
      if (!word) continue;
      const s = sentences.find(([sa, sb]) => a >= sa && a < sb);
      const inPage = s && pageSpan(s[0], s[1]);
      const sentence = inPage ? withPunctuation(...inPage) : span;
      cues.push({ t0, t1, word, sentence });
    }
    return cues;
  }

  /**
   * Move the word (and sentence) highlight along with the audio until the chunk ends.
   * The audio clock stops while paused, so the highlight does too.
   */
  function followWords(r: Reader, cues: WordCue[], source: AudioBufferSourceNode): void {
    if (!hasCSSHighlight || cues.length === 0) return;
    let shownWord = -1;
    let shownSentence: [number, number] | null = null;
    const tick = () => {
      if (r.cancelled || r.source !== source || r.startedAt === null) return;
      // currentTime runs ahead of what is heard by the output latency.
      const t = r.ctx.currentTime - r.startedAt - (r.ctx.outputLatency || 0);
      // The last word that has started; it stays lit through the pause after it.
      let i = shownWord === -1 ? 0 : shownWord;
      if (cues[i] && cues[i].t0 > t) i = 0;
      while (i + 1 < cues.length && cues[i + 1].t0 <= t) i++;
      if (i !== shownWord && cues[i].t0 <= t) {
        shownWord = i;
        const cue = cues[i];
        const word = buildRange(cue.word[0], cue.word[1]);
        if (word) setHighlight('lyra-word', word);
        if (cue.sentence !== shownSentence) {
          shownSentence = cue.sentence;
          const sentence = buildRange(cue.sentence[0], cue.sentence[1]);
          if (sentence) {
            setHighlight('lyra-reading', sentence);
            scrollIntoViewIfNeeded(sentence);
          }
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /**
   * Find the chunk verbatim (whitespace collapsed) and return its [start, end) in
   * fullText. Searches forward from the previous chunk first; only if that fails (e.g. the
   * page changed) falls back to the first match on the page.
   */
  function findExact(chunkText: string): [number, number] | null {
    const needle = chunkText.trim().replace(/\s+/g, ' ');
    let idx = normText.indexOf(needle, matchCursor);
    if (idx === -1) idx = normText.indexOf(needle);
    if (idx === -1) return null;
    matchCursor = idx + needle.length;

    // Map normalised offsets back to original fullText positions.
    const start = normToOrig[idx];
    const end =
      idx + needle.length < normToOrig.length ? normToOrig[idx + needle.length] : fullText.length;
    return [start, end];
  }

  /**
   * Find a chunk that isn't on the page verbatim: Readability dropped or added text
   * (hidden elements, footnote markers), quotes or dashes differ, or a chunk was cut
   * mid-word. Compares words only, after the previous chunk first and then from the top.
   */
  function findFuzzy(chunkText: string): [number, number] | null {
    const from = lowerBound(pageWords, normToOrig[matchCursor] ?? fullText.length, (w) => w.start);
    const chunk = toWords(chunkText);
    const words = findFuzzyWords(chunk, from) ?? findFuzzyWords(chunk, 0);
    if (!words) return null;

    const [start, end] = withPunctuation(pageWords[words[0]].start, pageWords[words[1]].end);
    matchCursor = lowerBound(normToOrig, end, (i) => i);
    return [start, end];
  }

  /**
   * Widen [start, end) of fullText over punctuation touching it ("“Don’t", "died."), but
   * not whitespace or letters: in Chinese or Japanese that would swallow the next sentence.
   */
  function withPunctuation(start: number, end: number): [number, number] {
    const isPunct = (c: string) => /[^\s\p{L}\p{N}\p{M}]/u.test(c);
    while (start > 0 && isPunct(fullText[start - 1])) start--;
    while (end < fullText.length && isPunct(fullText[end])) end++;
    return [start, end];
  }

  /**
   * Align the chunk's words with the page's at or after page word `from`, and return the
   * first and last matched page word indices.
   *
   * Anchors on the longest run of the chunk's words that appears verbatim on the page
   * (nearest to `from` on a tie), then extends it both ways, stepping over up to MAX_SKIP
   * words that only one side has (a footnote marker, a hidden label) or that differ. The
   * chunk's first and last words may be partial, since a chunk can be cut mid-word. The
   * match counts only if at least half of the chunk's words were matched.
   */
  function findFuzzyWords(chunk: Word[], from: number): [number, number] | null {
    const n = chunk.length;
    if (n === 0) return null;
    const c = chunk.map((w) => w.text);

    let bestLen = 0;
    let bestChunk = 0;
    let bestPage = 0;
    for (let i = 0; i < n; i++) {
      const positions = wordPositions.get(c[i]);
      if (!positions) continue;
      const first = lowerBound(positions, from, (p) => p);
      const last = Math.min(positions.length, first + MAX_ANCHOR_CANDIDATES);
      for (let k = first; k < last; k++) {
        const p = positions[k];
        let len = 0;
        while (i + len < n && pageWords[p + len]?.text === c[i + len]) len++;
        if (len > bestLen || (len === bestLen && p < bestPage)) {
          bestLen = len;
          bestChunk = i;
          bestPage = p;
        }
      }
    }
    if (bestLen < Math.min(3, n)) return null;

    const same = (ci: number, pj: number): boolean => {
      const page = pageWords[pj]?.text;
      if (page === undefined) return false;
      return (
        page === c[ci] ||
        (ci === n - 1 && page.startsWith(c[ci])) ||
        (ci === 0 && page.endsWith(c[ci]))
      );
    };

    /**
     * Walk from (ci, pj) in direction `dir`, matching words and skipping over mismatches.
     * Returns the last page word matched (or `lastMatched` if none) and how many matched.
     */
    const extend = (ci: number, pj: number, dir: 1 | -1, lastMatched: number): [number, number] => {
      let matched = 0;
      const inChunk = (i: number) => i >= 0 && i < n;
      while (inChunk(ci) && pj >= 0 && pj < pageWords.length) {
        if (same(ci, pj)) {
          matched++;
          lastMatched = pj;
          ci += dir;
          pj += dir;
          continue;
        }
        // Smallest skip (chunk words a, page words b) that lines the two up again.
        let step: [number, number] | null = null;
        for (let total = 1; total <= MAX_SKIP && !step; total++) {
          for (let a = 0; a <= total && !step; a++) {
            const ca = ci + a * dir;
            if (inChunk(ca) && same(ca, pj + (total - a) * dir)) step = [a, total - a];
          }
        }
        if (!step) break;
        ci += step[0] * dir;
        pj += step[1] * dir;
      }
      return [lastMatched, matched];
    };

    const [lastPage, after] = extend(
      bestChunk + bestLen,
      bestPage + bestLen,
      1,
      bestPage + bestLen - 1,
    );
    const [firstPage, before] = extend(bestChunk - 1, bestPage - 1, -1, bestPage);
    if (bestLen + after + before < n / 2) return null;
    return [firstPage, lastPage];
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
    focusRange = null;
    focusWord = null;
    if (hasCSSHighlight) {
      const { highlights } = CSS as unknown as { highlights: HighlightRegistry };
      highlights.delete('lyra-reading');
      highlights.delete('lyra-word');
    }
    // Also clean up any fallback marks
    for (const mark of document.querySelectorAll('mark.lyra-reading-mark')) {
      const parent = mark.parentNode!;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
    }
    updateFocus();
  }

  // ---------------------------------------------------------------------------
  // Focus mode (#9): a ruler on the line being read, or a spotlight on its paragraph
  // ---------------------------------------------------------------------------

  /** Elements that make up one block of reading text. */
  const BLOCK_SELECTOR =
    'p, li, h1, h2, h3, h4, h5, h6, blockquote, dd, dt, td, th, pre, figcaption, summary';

  /** The sentence (or chunk) and word being read; the focus overlay follows them. */
  let focusRange: Range | null = null;
  let focusWord: Range | null = null;
  let focusOverlay: HTMLDivElement | null = null;
  let focusFrame = 0;

  const DIM = 'rgba(20, 20, 32, 0.55)';

  /**
   * The overlay: a box with a huge shadow, so everything around it is dimmed. For the
   * ruler the box spans the viewport's width on the current line; for the spotlight it
   * fits the paragraph being read. It never takes clicks.
   */
  function getFocusOverlay(): HTMLDivElement {
    if (focusOverlay) return focusOverlay;
    focusOverlay = document.createElement('div');
    focusOverlay.id = '__lyra-focus';
    focusOverlay.setAttribute('aria-hidden', 'true');
    Object.assign(focusOverlay.style, {
      position: 'fixed',
      zIndex: '2147483646', // just under the status bar
      pointerEvents: 'none',
      boxShadow: `0 0 0 200vmax ${DIM}`,
      borderRadius: '6px',
      transition: 'top 0.12s ease, left 0.12s ease, width 0.12s ease, height 0.12s ease',
      display: 'none',
    });
    document.body.appendChild(focusOverlay);
    return focusOverlay;
  }

  /** Viewport rect the overlay should leave clear, or null to hide it. */
  function focusRect(): { top: number; left: number; width: number; height: number } | null {
    if (!focusRange || display.focusMode === 'off') return null;
    if (display.focusMode === 'ruler') {
      // The line of the word being spoken, else the first line of the sentence.
      const line = (focusWord ?? focusRange).getClientRects()[0];
      if (!line) return null;
      const pad = Math.max(4, line.height * 0.3);
      return {
        top: line.top - pad,
        left: -10,
        width: window.innerWidth + 20,
        height: line.height + 2 * pad,
      };
    }
    // Spotlight: the paragraph holding the sentence, grown to fit a sentence that spans
    // paragraphs.
    const start = focusRange.startContainer;
    const block = (start instanceof Element ? start : start.parentElement)?.closest(BLOCK_SELECTOR);
    const rects = [focusRange.getBoundingClientRect()];
    if (block) rects.push(block.getBoundingClientRect());
    const top = Math.min(...rects.map((r) => r.top));
    const left = Math.min(...rects.map((r) => r.left));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    const right = Math.max(...rects.map((r) => r.right));
    const pad = 10;
    return {
      top: top - pad,
      left: left - pad,
      width: right - left + 2 * pad,
      height: bottom - top + 2 * pad,
    };
  }

  /** Keep the overlay on the current line/paragraph, through scrolling and reflow. */
  function updateFocus(): void {
    cancelAnimationFrame(focusFrame);
    const rect = focusRect();
    if (!rect) {
      if (focusOverlay) focusOverlay.style.display = 'none';
      return;
    }
    const overlay = getFocusOverlay();
    Object.assign(overlay.style, {
      display: 'block',
      top: `${rect.top}px`,
      left: `${rect.left}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    focusFrame = requestAnimationFrame(updateFocus);
  }

  const FOCUS_MODES: FocusMode[] = ['off', 'ruler', 'spotlight'];
  const FOCUS_LABELS: Record<FocusMode, string> = {
    off: 'Focus: off',
    ruler: 'Focus: ruler',
    spotlight: 'Focus: spotlight',
  };

  /** Status-bar button: off → ruler → spotlight → off, saved for later reads. */
  function cycleFocusMode(): void {
    const next = FOCUS_MODES[(FOCUS_MODES.indexOf(display.focusMode) + 1) % FOCUS_MODES.length];
    display.focusMode = next;
    api.storage.local.set({ focusMode: next }).catch(() => {});
    updateControls();
    updateFocus();
  }

  // ---------------------------------------------------------------------------
  // Status bar UI
  // ---------------------------------------------------------------------------

  let statusBar: HTMLDivElement | null = null;
  /** Back / pause / forward buttons, shown only while a read is running. */
  let controls: HTMLDivElement | null = null;
  let pauseBtn: HTMLButtonElement | null = null;
  let focusBtn: HTMLButtonElement | null = null;

  const ICONS = {
    back: '<path d="M6 5h2v14H6zM20 5v14L9.5 12z"/>',
    forward: '<path d="M16 5h2v14h-2zM4 5v14l10.5-7z"/>',
    pause: '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>',
    play: '<path d="M7 4v16l13-8z"/>',
    focus:
      '<path d="M3 9h18v6H3z" opacity=".35"/><path d="M3 4h18v2H3zM3 18h18v2H3zM3 10h18v4H3z"/>',
  };

  /** A square icon button for the status bar. */
  function iconButton(
    icon: keyof typeof ICONS,
    label: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = '__lyra-icon-btn';
    setIcon(btn, icon, label);
    Object.assign(btn.style, {
      background: '#f7f7fb',
      border: '1px solid #e7e7ef',
      color: '#1b1b2a',
      borderRadius: '7px',
      width: '28px',
      height: '28px',
      padding: '0',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      cursor: 'pointer',
      flex: 'none',
    });
    btn.addEventListener('click', onClick);
    return btn;
  }

  function setIcon(btn: HTMLButtonElement, icon: keyof typeof ICONS, label: string): void {
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${ICONS[icon]}</svg>`;
    btn.setAttribute('aria-label', label);
    btn.title = label;
  }

  function getOrCreateStatusBar(): HTMLDivElement {
    if (statusBar) return statusBar;

    statusBar = document.createElement('div');
    statusBar.id = '__lyra-status';
    statusBar.setAttribute('role', 'region');
    statusBar.setAttribute('aria-label', 'Lyra read aloud');
    Object.assign(statusBar.style, {
      position: 'fixed',
      bottom: '20px',
      right: '20px',
      left: 'auto',
      zIndex: '2147483647',
      maxWidth: '440px',
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
    label.setAttribute('aria-live', 'polite');
    label.textContent = 'Preparing…';
    Object.assign(label.style, {
      flex: '1',
      minWidth: '0',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    });

    controls = document.createElement('div');
    controls.id = '__lyra-controls';
    Object.assign(controls.style, { display: 'none', gap: '5px', flex: 'none' });
    pauseBtn = iconButton('pause', 'Pause', togglePause);
    pauseBtn.id = '__lyra-pause';
    const backBtn = iconButton('back', 'Back one passage', () => skip(-1));
    backBtn.id = '__lyra-back';
    const forwardBtn = iconButton('forward', 'Forward one passage', () => skip(1));
    forwardBtn.id = '__lyra-forward';
    focusBtn = iconButton('focus', FOCUS_LABELS[display.focusMode], cycleFocusMode);
    focusBtn.id = '__lyra-focus-btn';
    controls.append(backBtn, pauseBtn, forwardBtn, focusBtn);

    const stopBtn = document.createElement('button');
    stopBtn.id = '__lyra-stop';
    stopBtn.type = 'button';
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
      stopReading();
      hideStatusBar();
      clearHighlight();
      api.runtime.sendMessage({ action: 'stop' });
    });

    statusBar.append(icon, label, controls, stopBtn);
    document.body.appendChild(statusBar);
    return statusBar;
  }

  /** Show the playback buttons while a read runs; keep the pause button's state current. */
  function updateControls(): void {
    if (!controls || !pauseBtn) return;
    controls.style.display = reader ? 'flex' : 'none';
    const paused = reader?.paused ?? false;
    setIcon(pauseBtn, paused ? 'play' : 'pause', paused ? 'Resume' : 'Pause');
    if (focusBtn) {
      setIcon(focusBtn, 'focus', FOCUS_LABELS[display.focusMode]);
      focusBtn.setAttribute('aria-pressed', String(display.focusMode !== 'off'));
      focusBtn.style.background = display.focusMode === 'off' ? '#f7f7fb' : '#e2dffc';
    }
  }

  function showStatusBar(text: string): void {
    const bar = getOrCreateStatusBar();
    const label = document.getElementById('__lyra-label');
    if (label) label.textContent = text;
    updateControls();
    bar.style.opacity = '1';
    bar.style.transform = 'translateY(0)';
  }

  function hideStatusBar(): void {
    if (statusBar) {
      statusBar.style.opacity = '0';
      statusBar.style.transform = 'translateY(100%)';
    }
  }

  // ---------------------------------------------------------------------------
  // Message listener
  // ---------------------------------------------------------------------------

  const api: typeof chrome = typeof browser !== 'undefined' ? browser : chrome;

  injectHighlightStyle();

  /** Pick up saved display settings now and whenever they change. */
  function loadDisplaySettings(values: Partial<DisplaySettings>): void {
    for (const key of Object.keys(display) as (keyof DisplaySettings)[]) {
      if (values[key] !== undefined)
        (display as unknown as Record<string, unknown>)[key] = values[key];
    }
    injectHighlightStyle();
    updateControls();
    updateFocus();
  }
  api.storage.local
    .get(Object.keys(display))
    .then((items) => loadDisplaySettings(items as Partial<DisplaySettings>))
    .catch(() => {});
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const values: Record<string, unknown> = {};
    for (const [key, change] of Object.entries(changes)) values[key] = change.newValue;
    loadDisplaySettings(values as Partial<DisplaySettings>);
  });

  // ---------------------------------------------------------------------------
  // Reading (Web Audio API, runs here in the content script)
  // ---------------------------------------------------------------------------

  /** What the background sends to start a read. */
  interface ReadRequest {
    readId: string;
    chunks: string[];
    voice: string;
    serverUrl: string;
    model: string;
    language?: string;
  }

  /** The background's answer to a `generate` request. */
  interface GenerateResponse {
    ok: boolean;
    audio?: string;
    label?: string;
    words?: number[][];
    error?: string;
    cancelled?: boolean;
  }

  /** A chunk's audio, ready to play, or why there is none. */
  interface PreparedChunk {
    buffer: AudioBuffer | null;
    label?: string;
    words?: number[][];
    error?: string;
    cancelled?: boolean;
  }

  interface Reader {
    cancelled: boolean;
    ctx: AudioContext;
    source: AudioBufferSourceNode | null;
    /** Resolves the playback promise of the chunk playing now. */
    finishPlayback: (() => void) | null;
    /** Index of the chunk being played (or waited for). */
    index: number;
    /** `ctx.currentTime` when the current chunk started playing, or null before it has. */
    startedAt: number | null;
    paused: boolean;
    /** Chunk to continue from, set by back/forward; the read loop picks it up. */
    jumpTo: number | null;
    /** Wakes the read loop while it waits for a chunk's audio, so a jump is immediate. */
    wake: (() => void) | null;
  }

  /**
   * How many chunks past the playing one to request. The server generates one at a
   * time, so two is enough to keep the next chunk ready without queueing much work
   * that a Stop would waste.
   */
  const LOOKAHEAD = 2;
  /** Waiting longer than this for a chunk probably means the server is loading a model. */
  const SLOW_REQUEST_MS = 8000;
  /** Give up after this many chunks in a row fail; a single bad chunk is skipped. */
  const MAX_CONSECUTIVE_FAILURES = 2;

  let reader: Reader | null = null;

  /**
   * Read a list of chunks aloud, in order, until the end or until stopped.
   *
   * Audio for the next chunks is requested and decoded while the current one plays,
   * so reading starts as soon as the first (short) chunk is ready and continues
   * without a pause per chunk, however long the page is.
   *
   * Playback uses decodeAudioData on an ArrayBuffer, which is not subject to the
   * page's media-src CSP, unlike `new Audio(dataUrl)`. One AudioContext serves the
   * whole read.
   */
  async function startReading(req: ReadRequest): Promise<void> {
    stopReading();
    const r: Reader = {
      cancelled: false,
      ctx: new AudioContext(),
      source: null,
      finishPlayback: null,
      index: 0,
      startedAt: null,
      paused: false,
      jumpTo: null,
      wake: null,
    };
    reader = r;
    // Not awaited: resume() can stay pending until the page allows audio, and the
    // first chunk's request should go out meanwhile.
    if (r.ctx.state === 'suspended') r.ctx.resume().catch(() => {});

    buildTextIndex();
    // The selection paints over the reading highlights; it has done its job by now.
    window.getSelection()?.removeAllRanges();
    showStatusBar('Preparing…');

    const { chunks } = req;
    const pending = new Map<number, Promise<PreparedChunk>>();
    const prepare = (i: number): void => {
      if (i < chunks.length && !pending.has(i)) pending.set(i, prepareChunk(r, req, chunks[i]));
    };

    let statusLabel = '';
    let failures = 0;
    let played = 0;
    let lastError = '';
    try {
      let i = 0;
      while (i < chunks.length) {
        r.index = i;
        r.startedAt = null;
        for (let j = i; j <= i + LOOKAHEAD; j++) prepare(j);

        const slowTimer = setTimeout(() => {
          if (r.cancelled) return;
          showStatusBar('Loading model… the first use downloads it, which can take a while');
          statusLabel = '';
        }, SLOW_REQUEST_MS);
        const woken = new Promise<null>((resolve) => (r.wake = () => resolve(null)));
        const chunk = await Promise.race([pending.get(i)!, woken]);
        r.wake = null;
        clearTimeout(slowTimer);
        if (r.cancelled || chunk?.cancelled) return;
        if (r.jumpTo !== null) {
          i = r.jumpTo;
          r.jumpTo = null;
          continue;
        }
        pending.delete(i); // drop the decoded audio once played

        if (!chunk!.buffer) {
          lastError = chunk!.error ?? 'No audio';
          if (++failures >= MAX_CONSECUTIVE_FAILURES) throw new Error(lastError);
          i++;
          continue; // skip a passage the server couldn't read and carry on
        }
        failures = 0;

        if (chunk!.label && chunk!.label !== statusLabel) {
          statusLabel = chunk!.label;
          showStatusBar(statusLabel);
        }
        const span = highlightChunk(chunks[i]);
        const cues =
          span && display.wordHighlight ? buildWordCues(chunks[i], span, chunk!.words ?? []) : [];
        await playBuffer(r, chunk!.buffer, cues);
        played++;
        if (r.cancelled) return;
        if (r.jumpTo !== null) {
          i = r.jumpTo;
          r.jumpTo = null;
        } else {
          i++;
        }
      }
      if (played === 0 && lastError) throw new Error(lastError);

      clearHighlight();
      endRead(r); // before the label, so the playback buttons hide
      showStatusBar('Done.');
      setTimeout(hideStatusBar, 1500);
    } catch (err) {
      if (r.cancelled) return;
      clearHighlight();
      endRead(r);
      showStatusBar(`Error: ${(err as Error).message}`);
      setTimeout(hideStatusBar, 4000);
    } finally {
      endRead(r);
    }
  }

  /** Seconds into the current chunk after which "back" restarts it rather than going back. */
  const RESTART_THRESHOLD_S = 2;

  /**
   * Move the read by `delta` chunks. Back restarts the current chunk if it has been
   * playing a while (like a media player), so a hard sentence is easy to hear again.
   * The read resumes if it was paused.
   */
  function skip(delta: -1 | 1): void {
    const r = reader;
    if (!r) return;
    let target = r.index + delta;
    if (
      delta < 0 &&
      r.startedAt !== null &&
      r.ctx.currentTime - r.startedAt > RESTART_THRESHOLD_S
    ) {
      target = r.index;
    }
    target = Math.max(0, target);
    r.jumpTo = target; // past the last chunk simply ends the read
    if (r.paused) setPaused(false);
    try {
      r.source?.stop();
    } catch {
      // not started yet — ignore
    }
    r.finishPlayback?.();
    r.wake?.();
  }

  function setPaused(paused: boolean): void {
    const r = reader;
    if (!r || r.paused === paused) return;
    r.paused = paused;
    if (paused) r.ctx.suspend().catch(() => {});
    else r.ctx.resume().catch(() => {});
    updateControls();
  }

  function togglePause(): void {
    if (reader) setPaused(!reader.paused);
  }

  /** Ask the background for a chunk's audio and decode it. */
  async function prepareChunk(r: Reader, req: ReadRequest, text: string): Promise<PreparedChunk> {
    let res: GenerateResponse | undefined;
    try {
      res = (await api.runtime.sendMessage({
        action: 'generate',
        readId: req.readId,
        text,
        voice: req.voice,
        serverUrl: req.serverUrl,
        model: req.model,
        language: req.language,
      })) as GenerateResponse | undefined;
    } catch (err) {
      return { buffer: null, error: (err as Error).message };
    }
    if (r.cancelled || res?.cancelled) return { buffer: null, cancelled: true };
    if (!res?.ok || !res.audio) return { buffer: null, error: res?.error ?? 'No audio' };

    try {
      const buffer = await r.ctx.decodeAudioData(base64ToArrayBuffer(res.audio));
      return { buffer, label: res.label, words: res.words };
    } catch {
      return { buffer: null, cancelled: r.cancelled, error: 'Could not decode the audio' };
    }
  }

  /** Play a decoded chunk, resolving when it ends or the read is stopped. */
  function playBuffer(r: Reader, buffer: AudioBuffer, cues: WordCue[] = []): Promise<void> {
    return new Promise<void>((resolve) => {
      if (r.cancelled) return resolve();
      const source = r.ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(r.ctx.destination);
      const finish = () => {
        if (r.finishPlayback === finish) r.finishPlayback = null;
        if (r.source === source) r.source = null;
        resolve();
      };
      r.source = source;
      r.finishPlayback = finish;
      source.onended = finish;
      source.start();
      r.startedAt = r.ctx.currentTime;
      followWords(r, cues, source);
    });
  }

  function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const buf = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
    return buf.buffer;
  }

  /** Stop the current read, if any, and release its audio. */
  function stopReading(): void {
    if (reader) endRead(reader);
  }

  /** Cancel a read and release its audio (safe to call more than once). */
  function endRead(r: Reader): void {
    if (reader === r) reader = null;
    r.cancelled = true;
    try {
      r.source?.stop();
    } catch {
      // source may not have started yet — ignore
    }
    r.finishPlayback?.();
    r.wake?.();
    if (r.ctx.state !== 'closed') r.ctx.close().catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Floating "Listen" button shown next to a text selection (DeepL-style)
  // ---------------------------------------------------------------------------

  let selectionButton: HTMLButtonElement | null = null;
  let isMouseDown = false;

  function getOrCreateSelectionButton(): HTMLButtonElement {
    if (selectionButton) return selectionButton;

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

  function showSelectionButton(): void {
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

  function hideSelectionButton(): void {
    if (selectionButton) selectionButton.style.display = 'none';
  }

  /** BCP-47 language of the selection: nearest `lang` attribute, else the document's. */
  function selectionLanguage(): string | undefined {
    const node = window.getSelection()?.anchorNode;
    const el = node instanceof Element ? node : node?.parentElement;
    const lang = el?.closest('[lang]')?.getAttribute('lang') || document.documentElement.lang;
    return lang?.trim() || undefined;
  }

  async function onSelectionButtonClick(e: MouseEvent): Promise<void> {
    e.preventDefault();
    e.stopPropagation();
    const text = window.getSelection()?.toString()?.trim();
    const language = selectionLanguage();
    hideSelectionButton();
    if (!text) return;
    try {
      await api.runtime.sendMessage({ action: 'speak', text, language });
    } catch {
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
    } else if (!isMouseDown) {
      // Keyboard-driven selection (Shift+Arrows, Ctrl+A …).
      showSelectionButton();
    }
  });
  document.addEventListener('scroll', hideSelectionButton, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideSelectionButton();
  });

  // ---------------------------------------------------------------------------
  // Read from here (context menu, or Alt+click a paragraph)
  // ---------------------------------------------------------------------------

  /** Where the context menu was last opened, for "Read from here". */
  let contextTarget: Element | null = null;
  document.addEventListener(
    'contextmenu',
    (e) => {
      contextTarget = e.target instanceof Element ? e.target : null;
    },
    true,
  );

  /** What "Read from here" needs to know about a clicked point of the page. */
  interface TextFromHere {
    /** The clicked block's own text, for finding it in the extracted article. */
    anchor: string;
    /** The page's visible text from the clicked block to the end of its article. */
    text: string;
    language?: string;
  }

  /**
   * The visible text from `target`'s block to the end of the article (the nearest
   * `article`/`main`, else the body). If the block's text appears more than once, the
   * first copy is taken.
   */
  function textFromHere(target: Element | null): TextFromHere | null {
    if (!target || target.closest('[id^="__lyra"]')) return null;
    const block = (target.closest(BLOCK_SELECTOR) ?? target) as HTMLElement;
    const container = (block.closest('article, main, [role="main"]') ??
      document.body) as HTMLElement;
    const anchor = (block.innerText ?? block.textContent ?? '').trim();
    if (!anchor) return null;
    const all = container.innerText;
    const at = all.indexOf(anchor);
    const text = (at === -1 ? anchor : all.slice(at)).trim();
    const lang = block.closest('[lang]')?.getAttribute('lang') || document.documentElement.lang;
    return { anchor, text, language: lang?.trim() || undefined };
  }

  // Alt+click (Option+click on macOS) on text starts reading from that paragraph. Links,
  // buttons and form fields keep their own Alt+click (e.g. download a link).
  document.addEventListener(
    'click',
    (e) => {
      if (!display.clickToRead || !e.altKey || e.shiftKey || e.ctrlKey || e.metaKey) return;
      const target = e.target instanceof Element ? e.target : null;
      if (!target || target.closest('a, button, input, select, textarea, label, [contenteditable]'))
        return;
      const here = textFromHere(target);
      if (!here) return;
      e.preventDefault();
      e.stopPropagation();
      window.getSelection()?.removeAllRanges();
      api.runtime.sendMessage({ action: 'read-from-here', ...here }).catch(() => {});
    },
    true,
  );

  // ---------------------------------------------------------------------------
  // Message listener
  // ---------------------------------------------------------------------------

  api.runtime.onMessage.addListener((message) => {
    switch ((message as { action: string }).action) {
      case 'start-reading':
        startReading(message as ReadRequest).catch(console.error);
        break;

      // Highlighting without playback: reset the page index, then highlight a chunk
      // (or clear with null). Reads use start-reading; the highlight tests drive these.
      case 'playback-started':
        buildTextIndex();
        break;

      case 'chunk-highlight':
        if ((message as { text?: string }).text) {
          highlightChunk((message as { text: string }).text);
        } else {
          clearHighlight();
        }
        break;

      case 'playback-stopped':
        stopReading();
        clearHighlight();
        hideStatusBar();
        break;

      case 'playback-error':
        stopReading();
        clearHighlight();
        showStatusBar(`Error: ${(message as { error: string }).error}`);
        setTimeout(hideStatusBar, 4000);
        break;

      // Back / pause / forward from the popup or a keyboard shortcut. Sent to every tab;
      // only the one reading acts on it.
      case 'playback-control':
        switch ((message as { command: string }).command) {
          case 'toggle-pause':
            togglePause();
            break;
          case 'back':
            skip(-1);
            break;
          case 'forward':
            skip(1);
            break;
        }
        break;

      case 'get-state':
        return Promise.resolve({ reading: reader !== null, paused: reader?.paused ?? false });

      case 'get-text-from-here':
        return Promise.resolve(textFromHere(contextTarget));

      case 'get-selection':
        return Promise.resolve({
          text: window.getSelection()?.toString()?.trim() ?? '',
          language: selectionLanguage(),
        });
    }
  });
})();
