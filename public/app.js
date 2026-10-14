const $ = (selector) => document.querySelector(selector);
const resultsEl = $('#results');
const titleEl = $('#results-title');
const countEl = $('#result-count');
const noticeEl = $('#notice');
const emptyEl = $('#empty-state');
const moreButton = $('#load-more');
const sortSelect = $('#sort-select');
const durationSelect = $('#duration-select');
const searchInput = $('#search-input');
const dialog = $('#detail-dialog');
const detailContent = $('#detail-content');
const toastEl = $('#toast');

const state = {
  mode: 'videos', query: 'nature documentary', queries: { videos: 'nature documentary', live: '', upcoming: '' }, order: 'relevance', duration: 'any',
  pageToken: null, total: 0, items: [], busy: false, controller: null,
  channelId: null, channel: null, channelMode: 'videos', channelNext: null, lastFetchedAt: null
};
searchInput.value = state.query;

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function formatNumber(value) {
  const n = Number(value || 0);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, '')}K`;
  return new Intl.NumberFormat().format(n);
}
function formatDuration(seconds) {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined }).format(date);
}
function relativeTime(value) {
  if (!value) return '';
  const delta = Date.now() - new Date(value).getTime();
  if (delta < 0) return '';
  const days = Math.floor(delta / 86_400_000);
  if (days < 1) return 'today';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
function scheduled(value) {
  if (!value) return 'Time not announced';
  const start = new Date(value);
  const today = new Date();
  const sameDay = start.toDateString() === today.toDateString();
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const nextDay = start.toDateString() === tomorrow.toDateString();
  const when = sameDay ? 'Today' : nextDay ? 'Tomorrow' : formatDate(value);
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(start);
  return `${when} · ${time}`;
}
function notice(message, kind = 'info') {
  noticeEl.textContent = message;
  noticeEl.className = `notice notice-${kind}`;
  noticeEl.hidden = false;
}
function hideNotice() { noticeEl.hidden = true; }
function setBusy(busy) {
  state.busy = busy;
  resultsEl.setAttribute('aria-busy', String(busy));
  moreButton.disabled = busy;
  if (busy && !state.items.length) {
    resultsEl.innerHTML = Array.from({ length: 6 }, () => '<div class="skeleton-card"><div class="skeleton-poster"></div><div class="skeleton-line"></div><div class="skeleton-line short"></div></div>').join('');
  }
}
function statusFor(video) {
  const mode = state.channelId ? state.channelMode : state.mode;
  if (mode === 'live' || video.liveBroadcastContent === 'live') return '<span class="status-badge is-live"><i></i> Live now</span>';
  if (mode === 'upcoming' || video.liveBroadcastContent === 'upcoming') return '<span class="status-badge is-upcoming"><i>◷</i> Upcoming</span>';
  return '';
}
function videoCard(video, index) {
  const thumbnail = video.thumbnail ? escapeHtml(video.thumbnail) : '/signal.svg';
  const duration = formatDuration(video.durationSeconds);
  const mode = state.channelId ? state.channelMode : state.mode;
  const streamStatus = mode === 'live' || mode === 'upcoming' || video.liveBroadcastContent === 'live' || video.liveBroadcastContent === 'upcoming';
  const meta = video.concurrentViewers ? `${formatNumber(video.concurrentViewers)} watching` : video.viewCount ? `${formatNumber(video.viewCount)} views` : (relativeTime(video.publishedAt) || 'Video');
  const liveMeta = video.concurrentViewers ? `${formatNumber(video.concurrentViewers)} watching` : 'Live broadcast';
  return `<article class="video-card stagger-${index % 12}">
    <button class="poster-button" data-video="${escapeHtml(video.id)}" aria-label="Play ${escapeHtml(video.title)}">
      <img class="poster" src="${thumbnail}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='/signal.svg'">
      <span class="poster-shade"></span><span class="play-symbol" aria-hidden="true">▶</span>
      ${statusFor(video)}${duration && !streamStatus ? `<span class="duration-badge">${duration}</span>` : ''}
      ${(mode === 'upcoming' || video.liveBroadcastContent === 'upcoming') && video.scheduledStartTime ? `<span class="scheduled-badge">${escapeHtml(scheduled(video.scheduledStartTime))}</span>` : ''}
    </button>
    <div class="card-copy">
      <div class="card-topline"><button class="channel-link" data-channel="${escapeHtml(video.channelId)}">${escapeHtml(video.channelTitle)}</button><span class="card-meta">${escapeHtml(streamStatus ? liveMeta : meta)}</span></div>
      <button class="video-title" data-video="${escapeHtml(video.id)}">${escapeHtml(video.title)}</button>
      <div class="card-bottom"><span>${escapeHtml(video.scheduledStartTime && (mode === 'upcoming' || video.liveBroadcastContent === 'upcoming') ? scheduled(video.scheduledStartTime) : formatDate(video.publishedAt))}</span><span class="card-arrow" aria-hidden="true">↗</span></div>
    </div>
  </article>`;
}
function renderItems(append = false, addedItems = state.items) {
  if (!append) resultsEl.innerHTML = '';
  resultsEl.insertAdjacentHTML(append ? 'beforeend' : 'afterbegin', (append ? addedItems : state.items).map(videoCard).join(''));
  emptyEl.hidden = state.items.length !== 0;
  moreButton.hidden = !(state.pageToken || state.channelNext);
  countEl.innerHTML = `${state.total ? `<span>${formatNumber(state.total)}</span> results` : ''}${!state.channelId && state.mode === 'live' && state.lastFetchedAt ? `<button class="refresh-inline" id="refresh-live" title="Refresh live broadcasts">↻ <span>Refresh</span></button>` : ''}`;
  const refresh = $('#refresh-live');
  refresh?.addEventListener('click', () => loadResults(false));
}
function setMode(mode) {
  if (mode !== state.mode) state.queries[state.mode] = searchInput.value.trim();
  state.mode = mode;
  searchInput.value = state.queries[mode] || '';
  searchInput.placeholder = mode === 'videos' ? 'Search videos, creators, or a feeling…' : 'Optional topic or channel filter…';
  durationSelect.closest('.sort-control').hidden = mode !== 'videos';
  document.querySelectorAll('.mode-tab').forEach((tab) => {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  if (mode === 'live') titleEl.textContent = 'Happening right now';
  else if (mode === 'upcoming') titleEl.textContent = 'On the horizon';
  else titleEl.textContent = 'A little inspiration';
}
async function api(path, signal) {
  const response = await fetch(path, { headers: { Accept: 'application/json' }, signal });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Request failed (${response.status}).`);
    error.code = body.code;
    error.status = response.status;
    throw error;
  }
  return body;
}
function friendlyError(error) {
  if (error.name === 'AbortError') return '';
  if (error.code === 'api_key_missing') return 'Add your YouTube Data API key: copy .env.example to .env, set YOUTUBE_API_KEY, then restart the server. Your key stays on this computer.';
  if (error.code === 'api_key_invalid') return 'This API key is invalid, or YouTube Data API v3 is not enabled for its Google Cloud project.';
  if (error.code === 'quota_exceeded') return error.message;
  if (error.code === 'local_rate_limit') return 'A lot of requests were made in a short time. Pause briefly, then try again.';
  return error.message || 'Something went wrong. Please try again.';
}
async function loadResults(append = false) {
  if (state.busy) return;
  const query = searchInput.value.trim();
  if ((state.mode === 'videos' && query.length < 2) || query.length === 1) {
    notice(state.mode === 'videos' ? 'Enter at least two characters to search.' : 'Enter at least two characters, or clear the topic to browse all broadcasts.', 'warn');
    searchInput.focus();
    return;
  }
  state.query = query;
  state.queries[state.mode] = query;
  state.duration = durationSelect.value;
  state.channelId = null;
  state.channel = null;
  state.channelNext = null;
  if (!append) { state.items = []; state.pageToken = null; state.total = 0; }
  if (state.controller) state.controller.abort();
  const controller = new AbortController(); state.controller = controller;
  hideNotice(); emptyEl.hidden = true;
  titleEl.textContent = state.mode === 'live' ? (query ? `Live: “${query}”` : 'All live broadcasts') : state.mode === 'upcoming' ? (query ? `Upcoming: “${query}”` : 'All upcoming broadcasts') : `Results for “${query}”`;
  setBusy(true);
  const params = new URLSearchParams({ mode: state.mode, order: sortSelect.value });
  if (query) params.set('q', query);
  if (state.mode === 'videos') params.set('duration', state.duration);
  if (append && state.pageToken) params.set('pageToken', state.pageToken);
  try {
    const data = await api(`/api/search?${params}`, controller.signal);
    if (controller.signal.aborted) return;
    const previousCount = state.items.length;
    state.items = append ? [...state.items, ...data.items] : data.items;
    state.pageToken = data.nextPageToken;
    state.total = data.totalResults;
    state.lastFetchedAt = Date.now();
    renderItems(append, state.items.slice(previousCount));
    if (!state.items.length) emptyEl.hidden = false;
  } catch (error) {
    const message = friendlyError(error);
    if (message) { resultsEl.innerHTML = ''; notice(message, 'error'); emptyEl.hidden = true; moreButton.hidden = true; }
  } finally {
    if (state.controller === controller) { state.controller = null; setBusy(false); }
  }
}
function showToast(text) {
  toastEl.textContent = text;
  toastEl.classList.add('is-visible');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toastEl.classList.remove('is-visible'), 2500);
}
async function openVideo(videoId) {
  detailContent.innerHTML = '<div class="detail-loading"><span class="spinner"></span><p>Tuning in…</p></div>';
  if (!dialog.open) dialog.showModal();
  try {
    const { video, channel } = await api(`/api/videos/${encodeURIComponent(videoId)}`);
    const channelAvatar = channel?.thumbnail ? `<img src="${escapeHtml(channel.thumbnail)}" alt="" referrerpolicy="no-referrer">` : '<span class="avatar-fallback">S</span>';
    const stats = [video.viewCount ? `${formatNumber(video.viewCount)} views` : '', video.likeCount ? `${formatNumber(video.likeCount)} likes` : '', video.publishedAt ? formatDate(video.publishedAt) : ''].filter(Boolean).join(' <span>·</span> ');
    const broadcast = video.liveBroadcastContent === 'live' ? '<span class="status-badge is-live"><i></i> Live now</span>' : video.liveBroadcastContent === 'upcoming' ? `<span class="status-badge is-upcoming"><i>◷</i> ${escapeHtml(scheduled(video.scheduledStartTime))}</span>` : '';
    detailContent.innerHTML = `<div class="player-wrap"><iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(video.id)}?autoplay=1&rel=0" title="${escapeHtml(video.title)}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></div>
      <div class="detail-body"><div class="detail-kicker">NOW PLAYING <span>·</span> YOUTUBE</div><div class="detail-title-row"><h2>${escapeHtml(video.title)}</h2>${broadcast}</div>
      <div class="detail-meta">${stats}</div><button class="detail-channel" data-channel="${escapeHtml(channel?.id || video.channelId)}">${channelAvatar}<span><strong>${escapeHtml(channel?.title || video.channelTitle)}</strong><small>${channel && !channel.hiddenSubscriberCount ? `${formatNumber(channel.subscriberCount)} subscribers` : 'YouTube channel'}</small></span><span class="channel-open">Explore channel ↗</span></button>
      <p class="detail-description">${escapeHtml(video.description || 'No description provided.').replace(/\n/g, '<br>')}</p>
      <a class="youtube-link" href="https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}" target="_blank" rel="noreferrer">Open on YouTube ↗</a></div>`;
  } catch (error) {
    detailContent.innerHTML = `<div class="detail-error"><span class="empty-mark">∿</span><h2>That signal slipped away.</h2><p>${escapeHtml(friendlyError(error))}</p></div>`;
  }
}
async function openChannel(channelId, pageToken = '', mode = 'videos') {
  if (!channelId) return showToast('Channel details are not available for this video.');
  if (state.controller) state.controller.abort();
  const controller = new AbortController(); state.controller = controller;
  const append = Boolean(pageToken);
  state.channelId = channelId;
  if (!append) { state.channelMode = mode; state.channel = null; state.channelNext = null; state.pageToken = null; state.items = []; state.total = 0; resultsEl.innerHTML = ''; }
  hideNotice(); emptyEl.hidden = true;
  if (!append) titleEl.textContent = 'Loading channel…';
  setBusy(true);
  const params = new URLSearchParams({ mode: state.channelMode });
  if (pageToken) params.set('pageToken', pageToken);
  try {
    const data = await api(`/api/channels/${encodeURIComponent(channelId)}?${params}`, controller.signal);
    if (controller.signal.aborted) return;
    const previousCount = state.items.length;
    state.channel = data.channel; state.channelNext = data.nextPageToken; state.items = [...state.items, ...data.items]; state.total = data.totalResults ?? data.channel.videoCount;
    const channel = data.channel;
    titleEl.innerHTML = `<button class="back-to-search" id="back-search">← Back to search</button><div class="channel-heading">${channel.thumbnail ? `<img src="${escapeHtml(channel.thumbnail)}" alt="" referrerpolicy="no-referrer">` : ''}<span><strong>${escapeHtml(channel.title)}</strong><small>${formatNumber(channel.videoCount)} videos${!channel.hiddenSubscriberCount ? ` · ${formatNumber(channel.subscriberCount)} subscribers` : ''}</small></span></div><div class="channel-tools">${[['videos','Uploads'],['live','Live now'],['upcoming','Upcoming']].map(([key,label]) => `<button class="channel-mode-tab${state.channelMode===key?' is-active':''}" data-channel-mode="${key}" aria-pressed="${state.channelMode===key}">${label}</button>`).join('')}</div>`;
    $('#back-search')?.addEventListener('click', () => { state.channelId = null; state.items = []; loadResults(false); });
    countEl.textContent = `${formatNumber(channel.videoCount)} videos`;
    renderItems(append, state.items.slice(previousCount));
    if (!state.items.length) emptyEl.hidden = false;
  } catch (error) {
    const message = friendlyError(error);
    if (message) { titleEl.textContent = 'Channel'; notice(message, 'error'); }
  } finally {
    if (state.controller === controller) { state.controller = null; setBusy(false); }
  }
}

$('#search-form').addEventListener('submit', (event) => { event.preventDefault(); loadResults(false); });
document.querySelectorAll('.mode-tab').forEach((tab) => tab.addEventListener('click', () => {
  if (state.mode === tab.dataset.mode && state.items.length) return;
  setMode(tab.dataset.mode); loadResults(false);
}));
sortSelect.addEventListener('change', () => loadResults(false));
durationSelect.addEventListener('change', () => loadResults(false));
moreButton.addEventListener('click', () => state.channelId ? openChannel(state.channelId, state.channelNext, state.channelMode) : loadResults(true));
titleEl.addEventListener('click', (event) => {
  const tab = event.target.closest('[data-channel-mode]');
  if (tab && state.channelId) openChannel(state.channelId, '', tab.dataset.channelMode);
});
resultsEl.addEventListener('click', (event) => {
  const video = event.target.closest('[data-video]');
  const channel = event.target.closest('[data-channel]');
  if (video) openVideo(video.dataset.video);
  else if (channel) openChannel(channel.dataset.channel);
});
detailContent.addEventListener('click', (event) => {
  const channel = event.target.closest('[data-channel]');
  if (channel) { dialog.close(); openChannel(channel.dataset.channel); }
});
$('#close-dialog').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
dialog.addEventListener('close', () => { detailContent.innerHTML = ''; });
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchInput.focus(); searchInput.select(); }
});

// First load gives the discovery page real results immediately; all requests stay behind the local proxy.
loadResults(false);
