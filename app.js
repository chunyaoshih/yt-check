// YouTube 播放追蹤器 - 核心邏輯
const CONFIG_KEY = 'yt_tracker_config';
const DATA_PATH = 'data/playlist.json';

// ── 設定管理 ────────────────────────────────────────────

function getConfig() {
  try {
    const s = localStorage.getItem(CONFIG_KEY);
    if (s) {
      const c = JSON.parse(s);
      if (!c.platform) c.platform = 'mac';
      return c;
    }
  } catch (e) {}
  return { pat: '', owner: 'chunyaoshih', repo: 'my-first-repo', platform: 'mac' };
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

// 讀取 → 修改 → 寫入，自動重試（處理並發衝突）
async function updatePlaylistData(fn) {
  for (let i = 0; i < 3; i++) {
    const { data, sha } = await githubRead();
    const updated = fn(data);
    try {
      await githubWrite(updated, sha);
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
