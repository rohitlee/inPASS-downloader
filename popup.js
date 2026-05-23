/**
 * popup.js – inPASS Document Downloader
 * Handles popup UI logic, communicates with content.js via chrome.tabs.sendMessage
 */

'use strict';

// ── DOM refs ─────────────────────────────────────────────────────────────────
const statusDot       = document.getElementById('statusDot');
const statusText      = document.getElementById('statusText');
const docInfo         = document.getElementById('docInfo');
const docCountEl      = document.getElementById('docCount');
const downloadDirEl   = document.getElementById('downloadDir');
const progressSection = document.getElementById('progressSection');
const progressFill    = document.getElementById('progressFill');
const progressFraction= document.getElementById('progressFraction');
const currentFileEl   = document.getElementById('currentFile');
const logPanel        = document.getElementById('logPanel');
const logBody         = document.getElementById('logBody');
const btnDownload     = document.getElementById('btnDownload');
const btnRefresh      = document.getElementById('btnRefresh');
const clearLogBtn     = document.getElementById('clearLog');

let totalDocs   = 0;
let isDownloading = false;

// ── Persist subfolder preference ─────────────────────────────────────────────
chrome.storage.local.get(['downloadDir'], (result) => {
  if (result.downloadDir) {
    downloadDirEl.value = result.downloadDir;
  }
});

downloadDirEl.addEventListener('input', () => {
  chrome.storage.local.set({ downloadDir: downloadDirEl.value.trim() });
});

// ── Utility ───────────────────────────────────────────────────────────────────
function setStatus(type, text) {
  statusDot.className = 'status-dot ' + type;
  statusText.textContent = text;
}

function addLog(type, iconChar, name) {
  const item = document.createElement('div');
  item.className = `log-item ${type}`;
  item.innerHTML = `<span class="log-icon">${iconChar}</span><span class="log-name">${escHtml(name)}</span>`;
  logBody.appendChild(item);
  logBody.scrollTop = logBody.scrollHeight;
  logPanel.style.display = 'block';
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function updateProgress(done, total) {
  progressFraction.textContent = `${done} / ${total}`;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  progressFill.style.width = pct + '%';
}

function saveDownloadState(state) {
  chrome.storage.local.set({ inpassDownloaderState: state });
}

function loadDownloadState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['inpassDownloaderState'], (result) => {
      resolve(result.inpassDownloaderState || null);
    });
  });
}

function restoreDownloadUI(state) {
  if (!state) return false;

  isDownloading = !!state.running;
  totalDocs = state.total || 0;
  docCountEl.textContent = totalDocs;
  docInfo.style.display = 'flex';
  progressSection.style.display = 'block';
  btnDownload.disabled = state.running;
  btnRefresh.disabled = state.running;
  setStatus(state.running ? 'running' : 'done', state.running ? 'Download still running…' : state.currentName || 'Download state restored');
  updateProgress(state.done || 0, state.total || 0);
  currentFileEl.textContent = state.currentName || '';

  if (state.running) {
    addLog('info', 'ℹ', 'Download appears to be running in background. Do not start again.');
  }

  return state.running;
}

// ── Get active tab ────────────────────────────────────────────────────────────
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ── Scan page for documents ───────────────────────────────────────────────────
async function scanPage() {
  setStatus('scanning', 'Scanning page for documents…');
  docInfo.style.display = 'none';
  btnDownload.disabled = true;

  const tab = await getActiveTab();

  if (!tab || !tab.url) {
    setStatus('no-page', 'No active tab found.');
    return;
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        // Find all document buttons on the inPASS page
        const buttons = Array.from(
          document.querySelectorAll('button[name="DocumentName"]')
        );
        return buttons.map(btn => ({
          name: btn.value,
          text: btn.textContent.trim()
        }));
      }
    });

    const docs = results && results[0] && results[0].result;

    if (!docs || docs.length === 0) {
      setStatus('error', 'No documents found on this page.');
      return;
    }

    totalDocs = docs.length;
    docCountEl.textContent = totalDocs;
    docInfo.style.display = 'flex';
    setStatus('ready', `Ready — ${totalDocs} document${totalDocs !== 1 ? 's' : ''} detected.`);
    btnDownload.disabled = false;

  } catch (err) {
    console.error('Scan error:', err);
    setStatus('error', 'Cannot access page. Are you on an inPASS page?');
  }
}

// ── Start bulk download ───────────────────────────────────────────────────────
async function startDownload() {
  if (isDownloading) return;

  const subfolder = downloadDirEl.value.trim();
  const tab = await getActiveTab();

  if (!tab) {
    setStatus('error', 'No active tab.');
    return;
  }

  isDownloading = true;
  btnDownload.disabled = true;
  btnRefresh.disabled  = true;

  saveDownloadState({
    running: true,
    total: totalDocs,
    done: 0,
    currentName: 'Starting download…',
    subfolder: subfolder,
    startedAt: Date.now()
  });

  // Show progress UI
  progressSection.style.display = 'block';
  updateProgress(0, totalDocs);

  setStatus('running', 'Downloading…');

  // Send message to content script to start the sequential download
  chrome.tabs.sendMessage(
    tab.id,
    {
      action: 'START_DOWNLOAD',
      subfolder: subfolder
    },
    (response) => {
      if (chrome.runtime.lastError) {
        // Content script may not be injected yet — inject then retry
        chrome.scripting.executeScript(
          { target: { tabId: tab.id }, files: ['content.js'] },
          () => {
            setTimeout(() => {
              chrome.tabs.sendMessage(tab.id, { action: 'START_DOWNLOAD', subfolder }, handleDownloadAck);
            }, 300);
          }
        );
        return;
      }
      handleDownloadAck(response);
    }
  );
}

function handleDownloadAck(response) {
  if (!response || !response.ok) {
    setStatus('error', response ? response.error : 'Content script not responding.');
    isDownloading = false;
    btnDownload.disabled = false;
    btnRefresh.disabled  = false;
  }
  // Progress updates arrive via chrome.runtime.onMessage below
}

// ── Listen for progress / completion messages from content.js ─────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'DEBUG') {
    addLog('info', 'ℹ', msg.msg || 'debug');
    return;
  }
  if (msg.type === 'DOWNLOAD_PROGRESS') {
    const { done, total, currentName, status } = msg;
    updateProgress(done, total);
    currentFileEl.textContent = currentName || '';

    if (status === 'success') {
      addLog('success', '✓', currentName);
    } else if (status === 'error') {
      addLog('error', '✗', currentName + (msg.error ? ` — ${msg.error}` : ''));
    }
  }

  if (msg.type === 'DOWNLOAD_COMPLETE') {
    const { done, total, errors } = msg;
    isDownloading = false;
    btnDownload.disabled = false;
    btnRefresh.disabled  = false;
    currentFileEl.textContent = 'All done!';
    progressFill.style.width = '100%';
    updateProgress(done, total);

    if (errors === 0) {
      setStatus('done', `✓ All ${total} documents downloaded successfully.`);
      addLog('info', 'ℹ', `Completed: ${done}/${total} files downloaded.`);
    } else {
      setStatus('error', `Done — ${errors} file(s) failed. ${done - errors}/${total} succeeded.`);
      addLog('info', 'ℹ', `Finished with ${errors} error(s). ${done - errors}/${total} succeeded.`);
    }
  }
});

// ── Button handlers ───────────────────────────────────────────────────────────
btnDownload.addEventListener('click', startDownload);

btnRefresh.addEventListener('click', () => {
  logBody.innerHTML = '';
  logPanel.style.display = 'none';
  progressSection.style.display = 'none';
  isDownloading = false;
  scanPage();
});

clearLogBtn.addEventListener('click', () => {
  logBody.innerHTML = '';
  logPanel.style.display = 'none';
});

// ── Auto-scan on popup open ───────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const state = await loadDownloadState();
  const running = restoreDownloadUI(state);
  if (!running) {
    scanPage();
  }
});
