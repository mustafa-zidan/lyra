/**
 * Eurydice TTS — Content Script
 *
 * Injected into every page. Responsible for:
 *  - Showing a floating playback-status bar at the bottom of the page
 *  - Listening for messages from the background worker
 *  - Providing selected text back to the popup on request
 */

'use strict';

(function () {
  // Guard against double-injection
  if (window.__eurydiceLoaded) return;
  window.__eurydiceLoaded = true;

  // ---------------------------------------------------------------------------
  // Status bar UI
  // ---------------------------------------------------------------------------

  let statusBar = null;

  function getOrCreateStatusBar() {
    if (statusBar) return statusBar;

    statusBar = document.createElement('div');
    statusBar.id = '__eurydice-status';
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

    // Icon
    const icon = document.createElement('span');
    icon.textContent = '🔊';
    icon.style.fontSize = '18px';

    // Label
    const label = document.createElement('span');
    label.id = '__eurydice-label';
    label.textContent = 'Preparing…';
    label.style.flex = '1';

    // Stop button
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
      chrome.runtime.sendMessage({ action: 'stop' });
    });

    statusBar.append(icon, label, stopBtn);
    document.body.appendChild(statusBar);
    return statusBar;
  }

  function showStatusBar(text) {
    const bar = getOrCreateStatusBar();
    const label = document.getElementById('__eurydice-label');
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

  api.runtime.onMessage.addListener((message) => {
    switch (message.action) {
      case 'playback-started':
        showStatusBar('Reading aloud…');
        break;
      case 'playback-finished':
        showStatusBar('Done.');
        setTimeout(hideStatusBar, 1500);
        break;
      case 'playback-stopped':
        hideStatusBar();
        break;
      case 'playback-error':
        showStatusBar(`Error: ${message.error}`);
        setTimeout(hideStatusBar, 4000);
        break;
      case 'get-selection':
        // Popup asks for current selection text
        return Promise.resolve({
          text: window.getSelection()?.toString()?.trim() ?? '',
        });
    }
  });
})();
