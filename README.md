# Signal

> **YouTube discovery, tuned to what you’re looking for.**

![Signal brand mark](public/signal.svg)

Signal is a local-first video and livestream discovery app built around a simple idea: finding something worth watching should feel deliberate, not like sorting through noise. Search videos and creators, scan what is live now, see what is coming up, and open a YouTube player without leaving the discovery flow.

It uses the **official YouTube Data API v3** for discovery and metadata, and YouTube’s privacy-enhanced embed for playback. It does not scrape YouTube pages, invent sample results, or send the API key to the browser.

## Why Signal

Signal follows YouTube’s familiar shell in both light and dark themes: the wordmark and compact top bar, rounded search and voice controls, create/notification/account actions, responsive navigation rail, filter chips, and video-first result cards. The implementation keeps Signal’s independent API-backed discovery features and identifies itself as an independent project; it is not an official YouTube product.

## What you can do

- **Search videos and creators.** Search titles, channels, and topics. Sort by relevance, newest, views, or rating. Filter regular videos by length. Voice search is available in browsers that support the Web Speech API; microphone permission is requested only after clicking the microphone button.
- **Discover live broadcasts.** Browse current broadcasts broadly or narrow the list with an optional topic or channel phrase. Cards distinguish live content and show concurrent viewers when YouTube provides them.
- **Find upcoming streams.** Browse scheduled broadcasts or narrow by topic. Scheduled start times are presented in the viewer’s local time zone when available.
- **Explore a channel.** Open a channel from a result and switch between its uploads, current live broadcasts, and upcoming broadcasts. Each list supports pagination.
- **Watch with context and ambient light.** Open a video to see its description, available statistics, channel details, and an official privacy-enhanced YouTube player. An optional, softly blurred glow derived from the video thumbnail follows the player, and its on/off preference is remembered locally.
- **Browse comfortably.** Desktop uses a familiar navigation rail; tablet widths compact it to an icon rail, and phones move navigation to the bottom. The chips switch between all videos, live, upcoming, short-duration results, long videos, and newest results. The **Shorts** chip currently means YouTube Data API videos under four minutes; it is not a dedicated Shorts feed. Press `/` or `Ctrl/⌘ K` to jump to search.
- **Set the mood.** Use the moon/sun control in the header to switch themes. The first visit follows the operating-system color preference; a manual choice is saved locally and persists across visits.
- **Stay oriented.** Loading placeholders, empty results, input validation, provider errors, quota guidance, and pagination help keep the interface useful when data is delayed or unavailable.

All video, channel, viewer-count, and schedule details are live API data. Some fields are omitted by YouTube for particular videos or streams, so the interface only shows values the API actually returns. The app stores only the ambient-light, theme, and collapsed-navigation preferences in the browser; it does not keep search history or watch history.

## Architecture

```mermaid
flowchart LR
  UI[Responsive browser UI\nVanilla JavaScript + CSS] -->|same-origin JSON| SERVER[Local Node.js server]
  SERVER --> CACHE{Bounded TTL cache\n+ in-flight deduplication}
  CACHE -->|cache miss| YT[Official YouTube Data API v3]
  YT -->|normalized public metadata| CACHE
  CACHE --> SERVER --> UI
  UI -->|privacy-enhanced embed| PLAYER[YouTube player]
  ENV[Local .env / process environment] -. API key stays server-side .-> SERVER
```

### Technology choices

- **Node.js 20+**, using its built-in HTTP server and `fetch`; no runtime dependencies or install step.
- **Vanilla JavaScript and CSS** for a fast, responsive front end without a client framework or bundle pipeline.
- **YouTube Data API v3** for search, video details, channel metadata, uploads, and live/upcoming broadcast discovery.
- **Process-local cache** because the application has no user accounts, saved lists, or database. YouTube remains the source of truth for public metadata, and cached entries can be safely rebuilt after a restart. The API key stays server-side; the three small interface preferences use browser local storage.

### Request and quota strategy

The server validates query lengths, modes, IDs, sorts, and duration filters before making provider calls. Search result IDs are enriched in one batched `videos.list` request rather than one request per card. A single optional batched `channels.list` lookup adds creator avatars to result cards; if that cosmetic lookup fails, the video results still load. Identical in-flight API calls share the same promise. A bounded least-recently-used TTL cache uses shorter lifetimes for current broadcasts and longer ones for stable video and channel details.

The server also applies a per-IP request limit, an upstream timeout, and clear error mapping for an invalid key, unavailable provider, network failure, or exhausted quota. Google's current quota documentation lists a default of **100 `search.list` calls per day** and **10,000 units per day combined for other endpoints**, with daily quotas resetting at midnight Pacific Time. These are project-level limits and Google can change them; check [the official quota page](https://developers.google.com/youtube/v3/determine_quota_cost) for the live rules. Search requests are the scarcest operation, so automatic live polling is intentionally avoided; use the explicit refresh control when you want fresh live results.

## Run locally

### Requirements

- Node.js 20 or newer
- A Google Cloud project with **YouTube Data API v3** enabled and an API key
- Internet access while searching or loading YouTube data

### Start the app

1. Copy `.env.example` to `.env` in the project root.
2. Add your own key in `.env`:

   ```dotenv
   YOUTUBE_API_KEY=your_key_here
   ```

3. Start the local server:

   ```powershell
   npm start
   ```

4. Open `http://127.0.0.1:3000`.

The server reads `YOUTUBE_API_KEY` from `.env` or the process environment. **Never commit `.env` or paste a real key into source code.** `.gitignore` excludes `.env`; `.env.example` contains only a blank placeholder. Restrict a real key to YouTube Data API v3 in Google Cloud. The app binds to loopback (`127.0.0.1`) and is intended for local single-user development, not direct public deployment.

No `npm install` is required. To restart the server after changing `.env`, stop it with `Ctrl+C` and run `npm start` again. For Node’s built-in file watching during development, run `npm run dev`.

## API surface

The local server exposes these read-only JSON endpoints:

- `GET /api/search?q=...&mode=videos|live|upcoming&order=...&duration=...&pageToken=...`
- `GET /api/videos/:videoId`
- `GET /api/channels/:channelId?mode=videos|live|upcoming&pageToken=...`

Video search requires a phrase. Live and upcoming search can omit `q` to browse broadly, or accept a phrase to narrow discovery. `pageToken` is passed through for provider pagination.

## Project structure

```text
.
├── public/
│   ├── app.js          # Search, cards, channel views, player dialog, UI states
│   ├── index.html      # Accessible app shell and navigation
│   ├── signal.svg      # Project mark and favicon
│   └── styles.css      # Responsive visual system and motion rules
├── .env.example        # Safe key placeholder; contains no credential
├── .gitignore          # Excludes credentials and generated files
├── package.json        # Node scripts and runtime requirements
├── README.md           # Project, architecture, and setup documentation
└── server.mjs          # Local API proxy, normalization, cache, and static server
```

## Verification

- `npm run check` parses both server and browser JavaScript with Node’s syntax checker.
- The local HTTP smoke suite verified the home page, assets, security headers, input validation, API method restrictions, and the no-key setup path.
- With the configured API key, video search, broad live discovery, and broad upcoming discovery each returned HTTP 200 with live API results.

## Scope and trade-offs

Signal intentionally does not add a database, account system, or persistent cache: it stores no user-specific data, and YouTube owns the public catalog being presented. Its in-memory cache resets when the process exits and is not shared across multiple server instances. A future hosted, multi-user version would need shared caching and rate limiting, deployment hardening, and a clear decision about any user data before choosing persistent storage.

The app’s results remain subject to YouTube Data API quota, API-key restrictions, embed availability, and the fields each broadcast exposes. The UI handles missing metadata; it cannot make unavailable YouTube data appear.
