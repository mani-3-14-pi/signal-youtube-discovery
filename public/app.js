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
const appFrame = $('.app-frame');
const navToggle = $('#nav-toggle');
const themeToggle = $('#theme-toggle');
const themeColorMeta = $('meta[name="theme-color"]');
const voiceButton = $('#voice-search');
const feedChips = $('#feed-chips');
const channelProfileEl = $('#channel-profile');
const channelToolsEl = $('#channel-tools');
const backButton = $('#back-search');

const state = {
  mode: 'videos', query: 'nature documentary', queries: { videos: 'nature documentary', live: '', upcoming: '' }, order: 'relevance', duration: 'any',
  pageToken: null, total: 0, items: [], busy: false, controller: null,
  channelId: null, channel: null, channelMode: 'videos', channelNext: null, lastFetchedAt: null
};
searchInput.value = state.query;

function readSavedTheme() {
  try {
    const saved = localStorage.getItem('signal.theme');
    return saved === 'dark' || saved === 'light' ? saved : null;
  } catch { return null; }
}
function applyTheme(theme, persist = false) {
  const chosen = theme === 'dark' ? 'dark' : 'light';
  const dark = chosen === 'dark';
  document.documentElement.dataset.theme = chosen;
  const nextLabel = `Switch to ${dark ? 'light' : 'dark'} theme`;
  themeToggle.setAttribute('aria-pressed', String(dark));
  themeToggle.setAttribute('aria-label', nextLabel);
  themeToggle.title = nextLabel;
  themeColorMeta.setAttribute('content', dark ? '#0f0f0f' : '#ffffff');
  if (persist) {
    try { localStorage.setItem('signal.theme', chosen); }
    catch { /* The in-memory theme still works if browser storage is unavailable. */ }
  }
}
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
applyTheme(readSavedTheme() || (systemTheme.matches ? 'dark' : 'light'));
const updateFromSystemTheme = (event) => {
  if (!readSavedTheme()) applyTheme(event.matches ? 'dark' : 'light');
};
if (systemTheme.addEventListener) systemTheme.addEventListener('change', updateFromSystemTheme);
else systemTheme.addListener?.(updateFromSystemTheme);

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
  const liveMeta = video.concurrentViewers ? `${formatNumber(video.concurrentViewers)} watching` : (mode === 'upcoming' || video.liveBroadcastContent === 'upcoming' ? 'Scheduled broadcast' : 'Live broadcast');
  const channelInitial = (video.channelTitle || 'Y').trim().slice(0, 1).toUpperCase() || 'Y';
  const avatarUrl = video.channelThumbnail || (state.channel?.id === video.channelId ? state.channel.thumbnail : '');
  const channelAvatar = avatarUrl ? `<img class="channel-avatar" data-fallback="${escapeHtml(channelInitial)}" src="${escapeHtml(avatarUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="channel-avatar" aria-hidden="true">${escapeHtml(channelInitial)}</span>`;
  return `<article class="video-card stagger-${index % 12}">
    <button class="poster-button" data-video="${escapeHtml(video.id)}" aria-label="Play ${escapeHtml(video.title)}">
      <img class="poster" src="${thumbnail}" alt="" loading="lazy" referrerpolicy="no-referrer">
      <span class="poster-shade"></span><span class="play-symbol" aria-hidden="true">▶</span>
      ${statusFor(video)}${duration && !streamStatus ? `<span class="duration-badge">${duration}</span>` : ''}
      ${(mode === 'upcoming' || video.liveBroadcastContent === 'upcoming') && video.scheduledStartTime ? `<span class="scheduled-badge">${escapeHtml(scheduled(video.scheduledStartTime))}</span>` : ''}
    </button>
    <div class="card-copy">
      ${channelAvatar}
      <div class="video-card-details">
        <button class="video-title" data-video="${escapeHtml(video.id)}">${escapeHtml(video.title)}</button>
        <div class="card-meta-line"><button class="channel-link" data-channel="${escapeHtml(video.channelId)}">${escapeHtml(video.channelTitle)}</button><span class="card-meta-dot" aria-hidden="true">·</span><span>${escapeHtml(streamStatus ? liveMeta : meta)}</span></div>
        <div class="card-bottom"><span>${escapeHtml(video.scheduledStartTime && (mode === 'upcoming' || video.liveBroadcastContent === 'upcoming') ? scheduled(video.scheduledStartTime) : formatDate(video.publishedAt))}</span><span class="card-arrow" aria-hidden="true">↗</span></div>
      </div>
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
  searchInput.placeholder = 'Search';
  durationSelect.closest('.sort-control').hidden = mode !== 'videos';
  syncFeedState();
  if (mode === 'live') titleEl.textContent = 'Happening right now';
  else if (mode === 'upcoming') titleEl.textContent = 'On the horizon';
  else titleEl.textContent = 'A little inspiration';
}
function selectedCategory() {
  if (state.mode === 'live') return 'live';
  if (state.mode === 'upcoming') return 'upcoming';
  if (durationSelect.value === 'short') return 'shorts';
  if (durationSelect.value === 'long') return 'long';
  if (durationSelect.value === 'any' && sortSelect.value === 'date') return 'latest';
  if (durationSelect.value === 'any' && sortSelect.value === 'relevance') return 'all';
  return '';
}
function syncFeedState() {
  const selected = selectedCategory();
  feedChips?.querySelectorAll('[data-category]').forEach((chip) => {
    const active = chip.dataset.category === selected;
    chip.classList.toggle('is-active', active);
    chip.setAttribute('aria-pressed', String(active));
  });
  document.querySelectorAll('.mode-tab').forEach((tab) => {
    const active = tab.dataset.mode === state.mode && (state.mode !== 'videos' || (tab.dataset.duration || 'any') === durationSelect.value);
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-pressed', String(active));
  });
}
function selectFeedCategory(chip) {
  const mode = chip.dataset.mode || 'videos';
  if (mode === 'videos') durationSelect.value = chip.dataset.duration || 'any';
  sortSelect.value = chip.dataset.order || 'relevance';
  setMode(mode);
  syncFeedState();
  loadResults(false);
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
  clearChannelHeader();
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
function getAmbientPreference() {
  try { return localStorage.getItem('signal.ambient-light') !== 'off'; }
  catch { return true; }
}
function setAmbientPreference(button, enabled) {
  const stage = button.closest('.player-stage');
  stage?.classList.toggle('ambient-off', !enabled);
  button.setAttribute('aria-pressed', String(enabled));
  button.setAttribute('aria-label', `Turn ambient light ${enabled ? 'off' : 'on'}`);
  const stateLabel = button.querySelector('.ambient-state');
  if (stateLabel) stateLabel.textContent = enabled ? 'On' : 'Off';
  try { localStorage.setItem('signal.ambient-light', enabled ? 'on' : 'off'); }
  catch { /* The in-memory toggle still works when browser storage is unavailable. */ }
}
function clearChannelHeader() {
  backButton.hidden = true;
  channelProfileEl.hidden = true;
  channelProfileEl.innerHTML = '';
  channelToolsEl.hidden = true;
  channelToolsEl.innerHTML = '';
}
async function openVideo(videoId) {
  detailContent.innerHTML = '<div class="detail-loading"><span class="spinner"></span><p>Tuning in…</p></div>';
  if (!dialog.open) dialog.showModal();
  try {
    const { video, channel } = await api(`/api/videos/${encodeURIComponent(videoId)}`);
    const channelAvatar = channel?.thumbnail ? `<img src="${escapeHtml(channel.thumbnail)}" alt="" referrerpolicy="no-referrer">` : '<span class="avatar-fallback">S</span>';
    const stats = [video.viewCount ? `${formatNumber(video.viewCount)} views` : '', video.likeCount ? `${formatNumber(video.likeCount)} likes` : '', video.publishedAt ? formatDate(video.publishedAt) : ''].filter(Boolean).join(' <span>·</span> ');
    const broadcast = video.liveBroadcastContent === 'live' ? '<span class="status-badge is-live"><i></i> Live now</span>' : video.liveBroadcastContent === 'upcoming' ? `<span class="status-badge is-upcoming"><i>◷</i> ${escapeHtml(scheduled(video.scheduledStartTime))}</span>` : '';
    const ambientEnabled = getAmbientPreference();
    const ambientImage = video.thumbnail ? `<img class="ambient-source" src="${escapeHtml(video.thumbnail)}" alt="" aria-hidden="true" referrerpolicy="no-referrer">` : '';
    detailContent.innerHTML = `<div class="player-stage${ambientEnabled ? '' : ' ambient-off'}">${ambientImage}<div class="player-wrap"><iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(video.id)}?autoplay=1&rel=0" title="${escapeHtml(video.title)}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></div>
      <div class="player-controls"><span class="player-source-label"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="4"></rect><path d="m10 9 5 3-5 3z"></path></svg> YOUTUBE PLAYER</span><button id="ambient-toggle" class="ambient-toggle" type="button" aria-pressed="${ambientEnabled}" aria-label="Turn ambient light ${ambientEnabled ? 'off' : 'on'}" title="Toggle ambient light"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18h6M10 21h4M8.5 14.5a6 6 0 1 1 7 0c-.8.6-1.2 1.3-1.3 2h-4.4c-.1-.7-.5-1.4-1.3-2Z"></path><path d="M12 1v2M4.2 4.2l1.4 1.4M1 12h2M21 12h2M18.4 5.6l1.4-1.4"></path></svg><span>Ambient light</span><span class="ambient-state">${ambientEnabled ? 'On' : 'Off'}</span></button></div></div>
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
  if (!append) { clearChannelHeader(); state.channelMode = mode; state.channel = null; state.channelNext = null; state.pageToken = null; state.items = []; state.total = 0; resultsEl.innerHTML = ''; }
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
    titleEl.textContent = channel.title;
    backButton.hidden = false;
    channelProfileEl.hidden = false;
    channelProfileEl.innerHTML = `${channel.thumbnail ? `<img src="${escapeHtml(channel.thumbnail)}" alt="" referrerpolicy="no-referrer">` : '<span class="avatar-fallback">S</span>'}<span>${formatNumber(channel.videoCount)} videos${!channel.hiddenSubscriberCount ? ` · ${formatNumber(channel.subscriberCount)} subscribers` : ''}</span>`;
    channelToolsEl.hidden = false;
    channelToolsEl.innerHTML = [['videos','Uploads'],['live','Live now'],['upcoming','Upcoming']].map(([key,label]) => `<button class="channel-mode-tab${state.channelMode===key?' is-active':''}" type="button" data-channel-mode="${key}" aria-pressed="${state.channelMode===key}">${label}</button>`).join('');
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

themeToggle.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next, true);
  showToast(`${next === 'dark' ? 'Dark' : 'Light'} theme enabled.`);
});
$('#search-form').addEventListener('submit', (event) => { event.preventDefault(); syncFeedState(); loadResults(false); });
let navCollapsed = window.matchMedia('(max-width: 1000px)').matches;
try {
  const storedNav = localStorage.getItem('signal.nav-collapsed');
  if (storedNav !== null) navCollapsed = storedNav === 'true';
} catch { /* Use the viewport-appropriate default when browser storage is unavailable. */ }
appFrame.classList.toggle('nav-collapsed', navCollapsed);
navToggle.setAttribute('aria-expanded', String(!navCollapsed));
navToggle.setAttribute('aria-label', `${navCollapsed ? 'Expand' : 'Collapse'} navigation`);
syncFeedState();
navToggle.addEventListener('click', () => {
  navCollapsed = appFrame.classList.toggle('nav-collapsed');
  navToggle.setAttribute('aria-expanded', String(!navCollapsed));
  navToggle.setAttribute('aria-label', `${navCollapsed ? 'Expand' : 'Collapse'} navigation`);
  try { localStorage.setItem('signal.nav-collapsed', String(navCollapsed)); } catch { /* The navigation remains usable without storage. */ }
});
document.querySelectorAll('.mode-tab').forEach((tab) => tab.addEventListener('click', () => {
  if (tab.dataset.mode === 'videos') durationSelect.value = tab.dataset.duration || 'any';
  const sameMode = state.mode === tab.dataset.mode;
  const sameDuration = tab.dataset.mode !== 'videos' || state.duration === durationSelect.value;
  if (sameMode && sameDuration && state.items.length && !state.channelId) return;
  setMode(tab.dataset.mode); loadResults(false);
}));
feedChips.addEventListener('click', (event) => {
  const chip = event.target.closest('[data-category]');
  if (chip) selectFeedCategory(chip);
});
sortSelect.addEventListener('change', () => { syncFeedState(); loadResults(false); });
durationSelect.addEventListener('change', () => { syncFeedState(); loadResults(false); });
voiceButton.addEventListener('click', () => {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return showToast('Voice search is not supported by this browser.');
  const recognition = new SpeechRecognition();
  recognition.lang = navigator.language || 'en-US';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.onstart = () => { voiceButton.classList.add('is-listening'); showToast('Listening…'); };
  recognition.onresult = (event) => {
    const transcript = event.results?.[0]?.[0]?.transcript?.trim();
    if (!transcript) return showToast('I didn’t catch that. Try again.');
    searchInput.value = transcript;
    syncFeedState();
    loadResults(false);
  };
  recognition.onerror = (event) => showToast(event.error === 'not-allowed' ? 'Allow microphone access to use voice search.' : 'Voice search stopped. Try again.');
  recognition.onend = () => voiceButton.classList.remove('is-listening');
  try { recognition.start(); }
  catch { voiceButton.classList.remove('is-listening'); showToast('Voice search could not start.'); }
});
moreButton.addEventListener('click', () => state.channelId ? openChannel(state.channelId, state.channelNext, state.channelMode) : loadResults(true));
backButton.addEventListener('click', () => { state.channelId = null; state.items = []; clearChannelHeader(); loadResults(false); });
channelToolsEl.addEventListener('click', (event) => {
  const tab = event.target.closest('[data-channel-mode]');
  if (tab && state.channelId) openChannel(state.channelId, '', tab.dataset.channelMode);
});
resultsEl.addEventListener('error', (event) => {
  const target = event.target;
  const avatar = target.closest('img.channel-avatar');
  if (avatar) {
    const fallback = document.createElement('span');
    fallback.className = 'channel-avatar';
    fallback.setAttribute('aria-hidden', 'true');
    fallback.textContent = avatar.dataset.fallback || 'Y';
    avatar.replaceWith(fallback);
    return;
  }
  const image = target.closest('img.poster');
  if (image && image.getAttribute('src') !== '/signal.svg') image.src = '/signal.svg';
}, true);
resultsEl.addEventListener('click', (event) => {
  const video = event.target.closest('[data-video]');
  const channel = event.target.closest('[data-channel]');
  if (video) openVideo(video.dataset.video);
  else if (channel) openChannel(channel.dataset.channel);
});
detailContent.addEventListener('click', (event) => {
  const ambientToggle = event.target.closest('#ambient-toggle');
  if (ambientToggle) {
    const enabled = ambientToggle.getAttribute('aria-pressed') !== 'true';
    setAmbientPreference(ambientToggle, enabled);
    showToast(`Ambient light ${enabled ? 'on' : 'off'}.`);
    return;
  }
  const channel = event.target.closest('[data-channel]');
  if (channel) { dialog.close(); openChannel(channel.dataset.channel); }
});
$('#close-dialog').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
dialog.addEventListener('close', () => { detailContent.innerHTML = ''; });
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchInput.focus(); searchInput.select(); }
  const target = event.target;
  const isEditing = target instanceof Element && target.matches('input,textarea,select,[contenteditable="true"]');
  if (!dialog.open && !isEditing && event.key === '/') { event.preventDefault(); searchInput.focus(); }
});

// First load gives the discovery page real results immediately; all requests stay behind the local proxy.
loadResults(false);
