import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');

// Load only simple KEY=value entries; process environment always takes precedence.
try {
  const envText = await readFile(path.join(ROOT, '.env'), 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const API_KEY = process.env.YOUTUBE_API_KEY?.trim();
const API_BASE = 'https://www.googleapis.com/youtube/v3';
const CACHE_LIMIT = 350;
const cache = new Map();
const inflight = new Map();
const requestWindows = new Map();
const WINDOW_MS = 60_000;
const MAX_API_REQUESTS_PER_WINDOW = 50;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon'
};

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(JSON.stringify(payload));
}

function durationSeconds(iso = '') {
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return 0;
  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
}

function normalizeVideo(item) {
  const snippet = item.snippet || {};
  const details = item.contentDetails || {};
  const live = item.liveStreamingDetails || {};
  const thumbnails = snippet.thumbnails || {};
  const thumbnail = thumbnails.maxres || thumbnails.standard || thumbnails.high || thumbnails.medium || thumbnails.default;
  return {
    id: item.id?.videoId || item.id,
    title: snippet.title || 'Untitled video',
    description: snippet.description || '',
    channelId: snippet.channelId || '',
    channelTitle: snippet.channelTitle || 'Unknown channel',
    thumbnail: thumbnail?.url || '',
    publishedAt: snippet.publishedAt || null,
    duration: details.duration || '',
    durationSeconds: durationSeconds(details.duration),
    viewCount: Number(details.statistics?.viewCount || 0),
    likeCount: Number(details.statistics?.likeCount || 0),
    commentCount: Number(details.statistics?.commentCount || 0),
    liveBroadcastContent: snippet.liveBroadcastContent || 'none',
    scheduledStartTime: live.scheduledStartTime || null,
    actualStartTime: live.actualStartTime || null,
    actualEndTime: live.actualEndTime || null,
    concurrentViewers: Number(live.concurrentViewers || 0)
  };
}

function normalizeChannel(item) {
  const snippet = item.snippet || {};
  const stats = item.statistics || {};
  const thumbnails = snippet.thumbnails || {};
  const avatar = thumbnails.high || thumbnails.medium || thumbnails.default;
  return {
    id: item.id,
    title: snippet.title || 'Unknown channel',
    description: snippet.description || '',
    thumbnail: avatar?.url || '',
    customUrl: snippet.customUrl || '',
    publishedAt: snippet.publishedAt || null,
    subscriberCount: Number(stats.subscriberCount || 0),
    hiddenSubscriberCount: Boolean(stats.hiddenSubscriberCount),
    videoCount: Number(stats.videoCount || 0),
    viewCount: Number(stats.viewCount || 0),
    uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads || ''
  };
}

function cacheGet(key) {
  const value = cache.get(key);
  if (!value) return null;
  if (value.expiresAt <= Date.now()) { cache.delete(key); return null; }
  cache.delete(key);
  cache.set(key, value);
  return value.data;
}

function cacheSet(key, data, ttlMs) {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

async function youtube(resource, params, ttlMs) {
  if (!API_KEY) {
    const error = new Error('YouTube API key is not configured. Copy .env.example to .env, add YOUTUBE_API_KEY, then restart the server.');
    error.status = 503;
    error.code = 'api_key_missing';
    throw error;
  }
  const query = new URLSearchParams(params);
  query.set('key', API_KEY);
  const cacheKey = `${resource}?${[...query.entries()].filter(([k]) => k !== 'key').sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&')}`;
  const saved = cacheGet(cacheKey);
  if (saved) return saved;
  if (inflight.has(cacheKey)) return inflight.get(cacheKey);

  const work = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    let response;
    try {
      response = await fetch(`${API_BASE}/${resource}?${query}`, { signal: controller.signal });
    } catch (error) {
      const wrapped = new Error(error.name === 'AbortError' ? 'YouTube API request timed out. Please try again.' : 'Could not reach the YouTube API. Check your internet connection and try again.');
      wrapped.status = 502;
      wrapped.code = 'provider_unreachable';
      throw wrapped;
    } finally {
      clearTimeout(timeout);
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const reason = body.error?.errors?.[0]?.reason || body.error?.status || 'provider_error';
      let message = body.error?.message || 'YouTube API request failed.';
      let status = response.status === 403 ? 502 : response.status;
      let code = reason;
      if (/quotaExceeded|dailyLimitExceeded/i.test(reason)) {
        message = 'YouTube Data API quota is exhausted for this API key. Try again after the quota resets or review the project quota in Google Cloud Console.';
        code = 'quota_exceeded';
        status = 429;
      } else if (/keyInvalid|accessNotConfigured|forbidden/i.test(reason)) {
        message = 'The YouTube API key is invalid or YouTube Data API v3 is not enabled for its Google Cloud project.';
        code = 'api_key_invalid';
      } else if (response.status >= 500) {
        message = 'YouTube is temporarily unavailable. Please retry in a moment.';
        code = 'provider_unavailable';
        status = 502;
      }
      const error = new Error(message);
      error.status = status;
      error.code = code;
      throw error;
    }
    cacheSet(cacheKey, body, ttlMs);
    return body;
  })();
  inflight.set(cacheKey, work);
  try { return await work; }
  finally { inflight.delete(cacheKey); }
}

function rateLimit(req, res) {
  const key = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let window = requestWindows.get(key);
  if (!window || now - window.start >= WINDOW_MS) window = { start: now, count: 0 };
  window.count += 1;
  requestWindows.set(key, window);
  if (requestWindows.size > 2000) {
    for (const [ip, record] of requestWindows) if (now - record.start >= WINDOW_MS) requestWindows.delete(ip);
  }
  if (window.count <= MAX_API_REQUESTS_PER_WINDOW) return false;
  const retryAfter = Math.max(1, Math.ceil((window.start + WINDOW_MS - now) / 1000));
  sendJson(res, 429, { error: 'Too many requests. Please wait before trying again.', code: 'local_rate_limit' }, { 'Retry-After': String(retryAfter) });
  return true;
}

function boundedText(value, max = 100) {
  return (typeof value === 'string' ? value : '').trim().slice(0, max);
}

async function handleApi(req, res, url) {
  if (rateLimit(req, res)) return;
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (parts[1] === 'search') {
      const q = boundedText(url.searchParams.get('q'), 120);
      const mode = url.searchParams.get('mode') || 'videos';
      const orderInput = url.searchParams.get('order') || 'relevance';
      const order = ['relevance', 'date', 'viewCount', 'rating'].includes(orderInput) ? orderInput : 'relevance';
      const duration = ['any', 'short', 'medium', 'long'].includes(url.searchParams.get('duration')) ? url.searchParams.get('duration') : 'any';
      const pageToken = boundedText(url.searchParams.get('pageToken'), 300);
      if (!['videos', 'live', 'upcoming'].includes(mode)) return sendJson(res, 400, { error: 'Unsupported discovery mode.', code: 'invalid_mode' });
      if ((mode === 'videos' && q.length < 2) || q.length === 1) return sendJson(res, 400, { error: mode === 'videos' ? 'Enter at least two characters to search videos.' : 'Enter at least two characters, or clear the topic to browse all broadcasts.', code: 'query_too_short' });
      const params = { part: 'snippet', type: 'video', maxResults: '12', order, safeSearch: 'moderate' };
      if (q) params.q = q;
      if (mode === 'live') params.eventType = 'live';
      if (mode === 'upcoming') params.eventType = 'upcoming';
      if (mode === 'videos' && duration !== 'any') params.videoDuration = duration;
      if (pageToken) params.pageToken = pageToken;
      const ttl = mode === 'live' ? 30_000 : mode === 'upcoming' ? 90_000 : 60_000;
      const data = await youtube('search', params, ttl);
      const ids = (data.items || []).map((item) => item.id?.videoId).filter(Boolean);
      let enriched = [];
      if (ids.length) {
        const detail = await youtube('videos', { part: 'snippet,contentDetails,statistics,liveStreamingDetails', id: ids.join(',') }, 180_000);
        const byId = new Map((detail.items || []).map((item) => [item.id, normalizeVideo(item)]));
        enriched = ids.map((id) => byId.get(id)).filter(Boolean);
      }
      return sendJson(res, 200, {
        items: enriched,
        nextPageToken: data.nextPageToken || null,
        totalResults: data.pageInfo?.totalResults || 0,
        mode,
        fetchedAt: new Date().toISOString()
      });
    }

    if (parts[1] === 'videos' && parts[2]) {
      const id = boundedText(parts[2], 20);
      if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return sendJson(res, 400, { error: 'Invalid YouTube video ID.', code: 'invalid_video_id' });
      const data = await youtube('videos', { part: 'snippet,contentDetails,statistics,liveStreamingDetails', id }, 180_000);
      const item = data.items?.[0];
      if (!item) return sendJson(res, 404, { error: 'This video is unavailable or cannot be embedded.', code: 'video_not_found' });
      const video = normalizeVideo(item);
      let channel = null;
      if (video.channelId) {
        const channelData = await youtube('channels', { part: 'snippet,statistics,contentDetails', id: video.channelId }, 300_000);
        if (channelData.items?.[0]) channel = normalizeChannel(channelData.items[0]);
      }
      return sendJson(res, 200, { video, channel });
    }

    if (parts[1] === 'channels' && parts[2]) {
      const id = boundedText(parts[2], 64);
      if (!/^(UC[A-Za-z0-9_-]{22})$/.test(id)) return sendJson(res, 400, { error: 'Invalid YouTube channel ID.', code: 'invalid_channel_id' });
      const channelData = await youtube('channels', { part: 'snippet,statistics,contentDetails', id }, 300_000);
      const item = channelData.items?.[0];
      if (!item) return sendJson(res, 404, { error: 'Channel not found.', code: 'channel_not_found' });
      const channel = normalizeChannel(item);
      const mode = url.searchParams.get('mode') || 'videos';
      if (!['videos', 'live', 'upcoming'].includes(mode)) return sendJson(res, 400, { error: 'Unsupported channel browse mode.', code: 'invalid_mode' });
      const pageToken = boundedText(url.searchParams.get('pageToken'), 300);
      let videos = [];
      let nextPageToken = null;
      let totalResults = channel.videoCount;
      if (mode === 'videos' && channel.uploadsPlaylistId) {
        const playlist = await youtube('playlistItems', { part: 'contentDetails', playlistId: channel.uploadsPlaylistId, maxResults: '12', ...(pageToken ? { pageToken } : {}) }, 180_000);
        const ids = (playlist.items || []).map((entry) => entry.contentDetails?.videoId).filter(Boolean);
        nextPageToken = playlist.nextPageToken || null;
        if (ids.length) {
          const details = await youtube('videos', { part: 'snippet,contentDetails,statistics,liveStreamingDetails', id: ids.join(',') }, 180_000);
          const byId = new Map((details.items || []).map((entry) => [entry.id, normalizeVideo(entry)]));
          videos = ids.map((videoId) => byId.get(videoId)).filter(Boolean);
        }
      } else if (mode === 'live' || mode === 'upcoming') {
        const broadcasts = await youtube('search', { part: 'snippet', type: 'video', channelId: id, maxResults: '12', eventType: mode, order: 'date', ...(pageToken ? { pageToken } : {}) }, mode === 'live' ? 30_000 : 90_000);
        const ids = (broadcasts.items || []).map((entry) => entry.id?.videoId).filter(Boolean);
        nextPageToken = broadcasts.nextPageToken || null;
        totalResults = broadcasts.pageInfo?.totalResults || 0;
        if (ids.length) {
          const details = await youtube('videos', { part: 'snippet,contentDetails,statistics,liveStreamingDetails', id: ids.join(',') }, 180_000);
          const byId = new Map((details.items || []).map((entry) => [entry.id, normalizeVideo(entry)]));
          videos = ids.map((videoId) => byId.get(videoId)).filter(Boolean);
        }
      }
      return sendJson(res, 200, { channel, items: videos, nextPageToken, mode, totalResults });
    }

    return sendJson(res, 404, { error: 'API endpoint not found.', code: 'not_found' });
  } catch (error) {
    console.error(`[api] ${error.code || 'error'}: ${error.message}`);
    return sendJson(res, error.status || 500, { error: error.message || 'Unexpected server error.', code: error.code || 'server_error' });
  }
}

async function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const safePath = path.resolve(PUBLIC, `.${decodeURIComponent(requested)}`);
  if (!safePath.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  try {
    const data = await readFile(safePath);
    const ext = path.extname(safePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'SAMEORIGIN',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' https://i.ytimg.com https://yt3.ggpht.com data:; frame-src https://www.youtube-nocookie.com https://www.youtube.com; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'"
    });
    if (req.method === 'HEAD') res.end(); else res.end(data);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found');
    } else throw error;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'Only GET requests are supported.', code: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
    }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) sendJson(res, 500, { error: 'Unexpected server error.', code: 'server_error' });
    else res.destroy();
  }
});

server.listen(Number.isInteger(PORT) && PORT >= 1024 && PORT <= 65535 ? PORT : 3000, '127.0.0.1', () => {
  const address = server.address();
  console.log(`Signal is ready at http://127.0.0.1:${address.port}`);
  console.log(API_KEY ? 'YouTube Data API key detected.' : 'No API key detected. Copy .env.example to .env and configure YOUTUBE_API_KEY.');
});
