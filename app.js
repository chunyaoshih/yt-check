// YouTube 播放追蹤器 - 核心邏輯
const CONFIG_KEY = 'yt_tracker_config';
const DATA_PATH = 'data/playlist.json';
const DRIVE_FOLDER_NAME = 'yt-check';
const DRIVE_FILE_NAME = 'playlist.json';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

// ── 設定管理 ────────────────────────────────────────────

function getConfig() {
  const defaults = {
    pat: '', owner: 'chunyaoshih', repo: 'my-first-repo',
    platform: 'mac',
    backend: 'github',
    driveClientId: '', driveFolderId: '', driveFileId: '',
    ytApiKey: ''
  };
  try {
    const s = localStorage.getItem(CONFIG_KEY);
    if (s) return { ...defaults, ...JSON.parse(s) };
  } catch (e) {}
  return defaults;
}

function saveConfig(config) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

// ── GitHub API ───────────────────────────────────────────

async function githubRead() {
  const { pat, owner, repo } = getConfig();
  if (!pat) throw new Error('請先設定 GitHub Personal Access Token');
  const resp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${DATA_PATH}`,
    { headers: { 'Authorization': `token ${pat}`, 'Accept': 'application/vnd.github.v3+json' } }
  );
  if (resp.status === 404) return { data: { videos: [] }, sha: null };
  if (!resp.ok) {
    const e = await resp.json().catch(() => ({}));
    throw new Error(e.message || `GitHub 讀取失敗 (${resp.status})`);
  }
  const file = await resp.json();
  const bytes = Uint8Array.from(atob(file.content.replace(/\s/g, '')), c => c.charCodeAt(0));
  return {
    data: JSON.parse(new TextDecoder('utf-8').decode(bytes)),
    sha: file.sha
  };
}

async function githubWrite(content, sha, msg = 'Update playlist') {
  const { pat, owner, repo } = getConfig();
  const body = {
    message: msg,
    content: (() => {
      const bytes = new TextEncoder().encode(JSON.stringify(content, null, 2));
      let bin = '';
      bytes.forEach(b => { bin += String.fromCharCode(b); });
      return btoa(bin);
    })()
  };
  if (sha) body.sha = sha;
  const resp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${DATA_PATH}`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `token ${pat}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }
  );
  if (!resp.ok) {
    const e = await resp.json().catch(() => ({}));
    throw new Error(e.message || `GitHub 寫入失敗 (${resp.status})`);
  }
}

// ── Google Drive API ─────────────────────────────────────

const DRIVE_TOKEN_KEY = 'yt_tracker_drive_token';
let _gisTokenClient = null;
let _driveAccessToken = null;
let _driveTokenExpiry = 0;

// 從 localStorage 載入上次存的 token（跨頁面/重新整理重用）
(function loadCachedDriveToken() {
  try {
    const raw = localStorage.getItem(DRIVE_TOKEN_KEY);
    if (!raw) return;
    const { token, expiry } = JSON.parse(raw);
    if (token && expiry && Date.now() < expiry - 60000) {
      _driveAccessToken = token;
      _driveTokenExpiry = expiry;
    } else {
      localStorage.removeItem(DRIVE_TOKEN_KEY);
    }
  } catch (e) {}
})();

function saveCachedDriveToken(token, expiry) {
  _driveAccessToken = token;
  _driveTokenExpiry = expiry;
  try {
    localStorage.setItem(DRIVE_TOKEN_KEY, JSON.stringify({ token, expiry }));
  } catch (e) {}
}

function clearCachedDriveToken() {
  _driveAccessToken = null;
  _driveTokenExpiry = 0;
  try { localStorage.removeItem(DRIVE_TOKEN_KEY); } catch (e) {}
}

async function waitForGis(timeoutMs = 8000) {
  if (window.google?.accounts?.oauth2) return;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (window.google?.accounts?.oauth2) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Google Identity Services 載入逾時，請檢查網路或重新整理頁面');
}

async function initGisTokenClient() {
  const { driveClientId } = getConfig();
  if (!driveClientId) throw new Error('請先設定 Google Drive Client ID');
  await waitForGis();
  _gisTokenClient = google.accounts.oauth2.initTokenClient({
    client_id: driveClientId,
    scope: DRIVE_SCOPE,
    callback: () => {}
  });
}

// 取得 Drive access token。silent=true 嘗試不彈出視窗刷新；失敗時拋錯。
// silent=false 會顯示 Google 登入/同意視窗（必須由使用者點擊觸發，否則可能被瀏覽器阻擋）。
async function ensureDriveToken(silent = true) {
  if (_driveAccessToken && Date.now() < _driveTokenExpiry - 60000) {
    return _driveAccessToken;
  }
  if (!_gisTokenClient) await initGisTokenClient();
  return new Promise((resolve, reject) => {
    _gisTokenClient.callback = (resp) => {
      if (resp.error) {
        return reject(new Error('Google 授權失敗：' + (resp.error_description || resp.error)));
      }
      const expiry = Date.now() + (resp.expires_in ?? 3600) * 1000;
      saveCachedDriveToken(resp.access_token, expiry);
      resolve(resp.access_token);
    };
    _gisTokenClient.requestAccessToken(silent ? { prompt: '' } : { prompt: 'consent' });
  });
}

async function driveApi(path, opts = {}) {
  const token = await ensureDriveToken();
  const doFetch = (tok) => fetch(
    path.startsWith('http') ? path : `https://www.googleapis.com${path}`,
    { ...opts, headers: { ...(opts.headers || {}), 'Authorization': `Bearer ${tok}` } }
  );
  let resp = await doFetch(token);
  if (resp.status === 401) {
    clearCachedDriveToken();
    resp = await doFetch(await ensureDriveToken());
  }
  return resp;
}

async function driveFindOrCreateFolder(name) {
  const q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const r = await driveApi(`/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`);
  if (!r.ok) throw new Error(`Drive 查詢資料夾失敗 (${r.status})`);
  const j = await r.json();
  if (j.files?.length) return j.files[0].id;
  const r2 = await driveApi('/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' })
  });
  if (!r2.ok) throw new Error(`Drive 建立資料夾失敗 (${r2.status})`);
  return (await r2.json()).id;
}

async function driveFindOrCreateFile(folderId, fileName) {
  const q = `name='${fileName}' and '${folderId}' in parents and trashed=false`;
  const r = await driveApi(`/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`);
  if (!r.ok) throw new Error(`Drive 查詢檔案失敗 (${r.status})`);
  const j = await r.json();
  if (j.files?.length) return j.files[0].id;
  // 建立新檔案（metadata-only，隨後寫入初始內容）
  const r2 = await driveApi('/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: fileName, parents: [folderId], mimeType: 'application/json' })
  });
  if (!r2.ok) throw new Error(`Drive 建立檔案失敗 (${r2.status})`);
  const fileId = (await r2.json()).id;
  const r3 = await driveApi(`/upload/drive/v3/files/${fileId}?uploadType=media`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videos: [] }, null, 2)
  });
  if (!r3.ok) throw new Error(`Drive 初始化檔案失敗 (${r3.status})`);
  return fileId;
}

async function driveResolveFileId() {
  const c = getConfig();
  if (c.driveFileId) return c.driveFileId;
  const folderId = c.driveFolderId || await driveFindOrCreateFolder(DRIVE_FOLDER_NAME);
  const fileId = await driveFindOrCreateFile(folderId, DRIVE_FILE_NAME);
  saveConfig({ ...getConfig(), driveFolderId: folderId, driveFileId: fileId });
  return fileId;
}

async function driveRead() {
  let fileId = await driveResolveFileId();
  let r = await driveApi(`/drive/v3/files/${fileId}?alt=media`);
  if (r.status === 404) {
    // 快取的檔案被刪了，清掉快取重找
    saveConfig({ ...getConfig(), driveFileId: '', driveFolderId: '' });
    fileId = await driveResolveFileId();
    r = await driveApi(`/drive/v3/files/${fileId}?alt=media`);
  }
  if (!r.ok) throw new Error(`Google Drive 讀取失敗 (${r.status})`);
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { videos: [] }; }
  if (!data.videos) data.videos = [];
  // Drive 版本不做樂觀鎖，sha 回 null
  return { data, sha: null };
}

async function driveWrite(content, _sha) {
  const fileId = await driveResolveFileId();
  const r = await driveApi(`/upload/drive/v3/files/${fileId}?uploadType=media`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(content, null, 2)
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error?.message || `Google Drive 寫入失敗 (${r.status})`);
  }
}

// ── 統一儲存介面（依 backend 切換 GitHub / Drive）──────

async function storageRead() {
  return getConfig().backend === 'drive' ? await driveRead() : await githubRead();
}

async function storageWrite(content, sha) {
  return getConfig().backend === 'drive'
    ? await driveWrite(content, sha)
    : await githubWrite(content, sha);
}

// 讀取 → 修改 → 寫入，自動重試（處理並發衝突）
async function updatePlaylistData(fn) {
  for (let i = 0; i < 3; i++) {
    const { data, sha } = await storageRead();
    const updated = fn(data);
    try {
      await storageWrite(updated, sha);
      return updated;
    } catch (e) {
      if (i === 2) throw e;
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
}

// ── YouTube 工具 ─────────────────────────────────────────

function extractPlaylistId(url) {
  if (!url) return null;
  const m = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

async function fetchPlaylistVideos(playlistId) {
  const { ytApiKey } = getConfig();
  if (!ytApiKey) throw new Error('請先在設定中輸入 YouTube Data API Key');
  const videos = [];
  let pageToken = '';
  do {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?playlistId=${encodeURIComponent(playlistId)}&key=${encodeURIComponent(ytApiKey)}&maxResults=50&part=snippet${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error?.message || `YouTube API 錯誤 (${resp.status})`);
    for (const item of (data.items || [])) {
      const videoId = item.snippet?.resourceId?.videoId;
      const title   = item.snippet?.title;
      if (videoId && title && title !== 'Deleted video' && title !== 'Private video') {
        videos.push({ id: videoId, title });
      }
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return videos;
}

function extractVideoId(url) {
  if (!url) return null;
  for (const re of [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /\/embed\/([a-zA-Z0-9_-]{11})/,
    /\/shorts\/([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/
  ]) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

async function fetchVideoTitle(videoId) {
  try {
    const r = await fetch(
      `https://noembed.com/embed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + videoId)}`
    );
    if (r.ok) {
      const d = await r.json();
      if (d.title && !d.error) return d.title;
    }
  } catch (e) {}
  return null;
}

// ── 播放進度 ─────────────────────────────────────────────

// 回傳最近一次儲存的位置（不論哪個平台）
function getResumePosition(video) {
  const a = video.platforms?.android;
  const m = video.platforms?.mac;
  if (!a && !m) return 0;
  if (!a) return m.last_position || 0;
  if (!m) return a.last_position || 0;
  return (new Date(a.last_updated) >= new Date(m.last_updated) ? a : m).last_position || 0;
}

// ── 工具函式 ─────────────────────────────────────────────

function formatTime(s) {
  if (s == null || isNaN(s)) return '--:--';
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function escapeHtml(s) {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
