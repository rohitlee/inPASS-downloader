/**
 * content.js – inPASS Document Downloader
 *
 * Runs on inPASS application pages.
 * Listens for START_DOWNLOAD from popup.js, then sequentially:
 *   1. Finds all document buttons (button[name="DocumentName"])
 *   2. For each document: submits the parent form via fetch (POST)
 *   3. Converts response to a Blob URL
 *   4. Triggers chrome.runtime.sendMessage to background.js to call
 *      chrome.downloads.download() with the correct filename + subfolder
 *   5. Sends progress updates back to popup
 */

'use strict';

// ── Guard: only inject once and only run in the top-level frame
if (window.top !== window) {
  // Don't run inside iframes — ensure single orchestrator
} else if (window.__inpassDownloaderInjected) {
  // already loaded in top frame — do nothing
} else {
  window.__inpassDownloaderInjected = true;

  // Prevent concurrent runs (ignore duplicate START_DOWNLOAD messages)
  window.__inpassDownloaderRunning = false;

  // ── Listen for messages from popup ──────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'START_DOWNLOAD') {
      if (window.__inpassDownloaderRunning) {
        sendResponse({ ok: false, error: 'Download already in progress' });
        return true;
      }

      window.__inpassDownloaderRunning = true;
      sendResponse({ ok: true });
      runDownload(msg.subfolder || '').finally(() => {
        window.__inpassDownloaderRunning = false;
      });
      return true; // async
    }
  });

  // ── Main download orchestrator ──────────────────────────────────────────────
  async function runDownload(subfolder) {
    // 1. Collect all document buttons
    const buttons = Array.from(
      document.querySelectorAll('button[name="DocumentName"]')
    );

    if (buttons.length === 0) {
      chrome.runtime.sendMessage({
        type: 'DOWNLOAD_COMPLETE',
        done: 0,
        total: 0,
        errors: 0
      });
      return;
    }

    const total  = buttons.length;
    let done     = 0;
    let errors   = 0;

    // Collect fetched blobs for zipping
    const collected = [];

    saveDownloadState({
      running: true,
      total,
      done,
      currentName: 'Preparing files…',
      subfolder,
      startedAt: Date.now()
    });

    // 2. Find the parent <form> of the first button (they share one form)
    const form = buttons[0].closest('form');
    if (!form) {
      chrome.runtime.sendMessage({
        type: 'DOWNLOAD_COMPLETE',
        done: 0,
        total,
        errors: total
      });
      return;
    }

    const formAction = form.action || window.location.href;
    const method     = (form.method || 'post').toUpperCase();

    // 3. Download sequentially
    for (const btn of buttons) {
      const docName = btn.value; // exact filename as shown on site

      // Notify popup: starting this file
      chrome.runtime.sendMessage({
        type: 'DOWNLOAD_PROGRESS',
        done,
        total,
        currentName: docName,
        status: 'starting'
      });

      try {
        // Unique id and timestamp for debugging this document
        const docId = `${Date.now()}-${Math.floor(Math.random()*10000)}`;
        chrome.runtime.sendMessage({ type: 'DEBUG', msg: `CS: start doc ${docId} ${docName}` });
        // Build FormData mirroring a real form submit of this button
        const formData = buildFormData(form, btn);

        // Update storage state for the current file
        saveDownloadState({
          running: true,
          total,
          done,
          currentName: docName,
          subfolder,
          startedAt: Date.now()
        });

        // Fetch the document as a blob
        chrome.runtime.sendMessage({ type: 'DEBUG', msg: `CS: fetch-start ${docId} ${docName}` });
        const response = await fetch(formAction, {
          method,
          body: formData,
          credentials: 'include' // carry session cookies (user already logged in)
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        // Determine content-type for safety
        const contentType = response.headers.get('Content-Type') || 'application/octet-stream';

        const blob = await response.blob();
        // collect for zip
        collected.push({ name: sanitizeFilename(docName, ''), blob });
        done++;
        chrome.runtime.sendMessage({
          type: 'DOWNLOAD_PROGRESS',
          done,
          total,
          currentName: docName,
          status: 'success'
        });

      } catch (err) {
        done++;
        errors++;
        saveDownloadState({
          running: true,
          total,
          done,
          currentName: docName,
          subfolder,
          errors,
          startedAt: Date.now()
        });
        chrome.runtime.sendMessage({
          type: 'DOWNLOAD_PROGRESS',
          done,
          total,
          currentName: docName,
          status: 'error',
          error: err.message
        });
      }

      // Small delay between downloads to be polite to the server
      await sleep(600);
    }

    // After fetching all files, create a single ZIP and trigger one download
    try {
      if (collected.length > 0) {
        chrome.runtime.sendMessage({ type: 'DEBUG', msg: `CS: creating zip of ${collected.length} files` });
        const zipBlob = await createZipBlob(collected);
        const zipName = (subfolder ? subfolder + '/' : '') + (subfolder ? subfolder : 'inpass-documents') + '.zip';
        const zipBlobUrl = URL.createObjectURL(zipBlob);

        const dlResult = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: 'TRIGGER_DOWNLOAD', blobUrl: zipBlobUrl, filename: zipName, docName: zipName }, resolve);
        });

        URL.revokeObjectURL(zipBlobUrl);
        if (dlResult && dlResult.error) {
          chrome.runtime.sendMessage({ type: 'DEBUG', msg: `CS: zip download error ${dlResult.error}` });
          errors++;
        } else {
          chrome.runtime.sendMessage({ type: 'DEBUG', msg: `CS: zip download ok` });
        }
      }

    } catch (zipErr) {
      chrome.runtime.sendMessage({ type: 'DEBUG', msg: `CS: zip error ${zipErr.message}` });
      errors = collected.length; // mark as errors
    }

    // 4. All done
    chrome.runtime.sendMessage({
      type: 'DOWNLOAD_COMPLETE',
      done,
      total,
      errors
    });

    saveDownloadState({
      running: false,
      total,
      done,
      currentName: errors === 0 ? 'Completed' : 'Completed with errors',
      subfolder,
      finishedAt: Date.now(),
      errors
    });

    // ensure running flag cleared (in case caller doesn't rely on finally)
    window.__inpassDownloaderRunning = false;
  }

  function saveDownloadState(state) {
    chrome.storage.local.set({ inpassDownloaderState: state });
  }

  function clearDownloadState() {
    chrome.storage.local.remove('inpassDownloaderState');
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Build FormData for the form, including all hidden/text fields,
   * plus the specific submit button that was "clicked".
   */
  function buildFormData(form, activeButton) {
    const fd = new FormData();

    // Add all non-button form fields (hidden inputs, text, etc.)
    const elements = Array.from(form.elements);
    for (const el of elements) {
      if (!el.name) continue;

      // Skip other submit buttons / file inputs
      if (el.type === 'submit' || el.type === 'button') continue;
      if (el.type === 'file') continue;

      // Skip unchecked checkboxes / radio buttons
      if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) continue;

      fd.append(el.name, el.value);
    }

    // Add the specific button that was "clicked"
    if (activeButton.name) {
      fd.append(activeButton.name, activeButton.value);
    }

    return fd;
  }

  /**
   * Build a safe filename path for chrome.downloads.
   * Strips characters that are illegal in Windows filenames.
   */
  function sanitizeFilename(name, subfolder) {
    // Remove characters illegal on Windows: \ / : * ? " < > |
    // We keep spaces, dots, brackets, hyphens – all valid in inPASS names
    const safe = name.replace(/[\\/:*?"<>|]/g, '_');

    if (subfolder) {
      // Sanitize subfolder too
      const safeFolder = subfolder.replace(/[\\:*?"<>|]/g, '_');
      return safeFolder + '/' + safe;
    }

    return safe;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ── ZIP builder (store only, no compression) ───────────────────────────────
  async function createZipBlob(entries) {
    // entries: [{name, blob}]
    const fileDatas = [];
    for (const e of entries) {
      const ab = await e.blob.arrayBuffer();
      const uint8 = new Uint8Array(ab);
      const crc = crc32(uint8);
      fileDatas.push({ name: e.name, data: uint8, size: uint8.length, crc });
    }

    const encoder = new TextEncoder();
    let localParts = [];
    let centralParts = [];
    let offset = 0;

    for (const f of fileDatas) {
      const nameBuf = encoder.encode(f.name);

      // local file header
      const localHeader = new Uint8Array(30 + nameBuf.length);
      const dv = new DataView(localHeader.buffer);
      dv.setUint32(0, 0x04034b50, true); // signature
      dv.setUint16(4, 20, true); // version needed
      dv.setUint16(6, 0, true); // flags
      dv.setUint16(8, 0, true); // compression method (0 = store)
      dv.setUint16(10, 0, true); // mod time
      dv.setUint16(12, 0, true); // mod date
      dv.setUint32(14, f.crc, true);
      dv.setUint32(18, f.size, true); // compressed size
      dv.setUint32(22, f.size, true); // uncompressed size
      dv.setUint16(26, nameBuf.length, true);
      dv.setUint16(28, 0, true); // extra length
      localHeader.set(nameBuf, 30);

      localParts.push(localHeader);
      localParts.push(f.data);

      // central directory header
      const centHeader = new Uint8Array(46 + nameBuf.length);
      const cdv = new DataView(centHeader.buffer);
      cdv.setUint32(0, 0x02014b50, true); // central file header signature
      cdv.setUint16(4, 20, true); // version made by
      cdv.setUint16(6, 20, true); // version needed
      cdv.setUint16(8, 0, true); // flags
      cdv.setUint16(10, 0, true); // compression
      cdv.setUint16(12, 0, true); // mod time
      cdv.setUint16(14, 0, true); // mod date
      cdv.setUint32(16, f.crc, true);
      cdv.setUint32(20, f.size, true);
      cdv.setUint32(24, f.size, true);
      cdv.setUint16(28, nameBuf.length, true);
      cdv.setUint16(30, 0, true); // extra
      cdv.setUint16(32, 0, true); // comment
      cdv.setUint16(34, 0, true); // disk
      cdv.setUint16(36, 0, true); // internal attrs
      cdv.setUint32(38, 0, true); // external attrs
      cdv.setUint32(42, offset, true); // relative offset of local header
      centHeader.set(nameBuf, 46);

      centralParts.push(centHeader);

      offset += localHeader.length + f.size;
    }

    // compute sizes
    let localSize = 0;
    for (const p of localParts) localSize += p.length;
    let centralSize = 0;
    for (const p of centralParts) centralSize += p.length;

    const totalSize = localSize + centralSize + 22; // end of central dir
    const out = new Uint8Array(totalSize);
    let ptr = 0;
    for (const p of localParts) {
      out.set(new Uint8Array(p.buffer || p), ptr);
      ptr += p.length;
    }
    const centralStart = ptr;
    for (const p of centralParts) {
      out.set(new Uint8Array(p.buffer || p), ptr);
      ptr += p.length;
    }

    // end of central dir
    const ed = new DataView(out.buffer, ptr, 22);
    ed.setUint32(0, 0x06054b50, true);
    ed.setUint16(4, 0, true); // disk
    ed.setUint16(6, 0, true); // disk where central starts
    ed.setUint16(8, fileDatas.length, true); // entries on this disk
    ed.setUint16(10, fileDatas.length, true); // total entries
    ed.setUint32(12, centralSize, true); // size of central dir
    ed.setUint32(16, centralStart, true); // offset of central dir
    ed.setUint16(20, 0, true); // comment length

    return new Blob([out], { type: 'application/zip' });
  }

  // CRC32 implementation
  function crc32(buf) {
    const table = crc32.table || (crc32.table = makeCrcTable());
    let crc = 0 ^ -1;
    for (let i = 0; i < buf.length; i++) {
      crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
    }
    return (crc ^ -1) >>> 0;
  }

  function makeCrcTable() {
    let c;
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) {
        c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
      }
      table[n] = c >>> 0;
    }
    return table;
  }
}
