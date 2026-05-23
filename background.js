/**
 * background.js – inPASS Document Downloader (Service Worker)
 *
 * Handles the TRIGGER_DOWNLOAD message from content.js.
 * Uses chrome.downloads.download() to save a blob URL with the correct filename.
 *
 * Note: chrome.downloads.download() works with blob: URLs created in content
 * scripts only if the download is initiated from the background service worker.
 */

'use strict';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'TRIGGER_DOWNLOAD') {
    const { blobUrl, filename, docName } = msg;

    // Debug ping to popup/content
    chrome.runtime.sendMessage({ type: 'DEBUG', msg: `BG: received TRIGGER_DOWNLOAD ${docName} -> ${filename}` });

    chrome.downloads.download(
      {
        url: blobUrl,
        filename: filename,     // includes optional subfolder prefix
        saveAs: false,          // silent download — no save dialog
        conflictAction: 'uniquify' // auto-rename if file already exists
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          chrome.runtime.sendMessage({ type: 'DEBUG', msg: `BG: download error ${docName} ${chrome.runtime.lastError.message}` });
          sendResponse({ error: chrome.runtime.lastError.message });
        } else {
          chrome.runtime.sendMessage({ type: 'DEBUG', msg: `BG: download started id=${downloadId} ${docName}` });
          sendResponse({ ok: true, downloadId });
        }
      }
    );

    return true; // keep message channel open for async sendResponse
  }
});
