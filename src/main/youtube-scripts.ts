import type { OverlayStatePayload, VideoControlCommand } from '../shared/types';

// Runs only inside the isolated, unprivileged YouTube WebContents main world.

const readPlayerResponse = `function readPlayerResponse() {
  const player = document.getElementById('movie_player');
  if (!player || typeof player.getPlayerResponse !== 'function') return null;
  try {
    const response = player.getPlayerResponse();
    return typeof response === 'string' ? JSON.parse(response) : response;
  } catch { return null; }
}`;

const readTranslationLanguages = `function readTranslationLanguages(player, response) {
  try {
    const live = player?.getOption?.('captions', 'translationLanguages');
    if (Array.isArray(live) && live.length) return live;
  } catch {}
  return response?.captions?.playerCaptionsTracklistRenderer?.translationLanguages || [];
}`;

const detectOriginalLanguage = `function detectOriginalLanguage(player, response) {
  const code = value => {
    if (typeof value !== 'string') return '';
    const normalized = value.replace(/_/g, '-').trim();
    return /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(normalized) ? normalized : '';
  };

  // 1. Decode base64url xtags from streamingData.adaptiveFormats for "original" audio track
  try {
    const formats = response?.streamingData?.adaptiveFormats || [];
    for (const fmt of formats) {
      const mime = String(fmt?.mimeType || '');
      if (!mime.startsWith('audio/')) continue;
      const track = fmt?.audioTrack;
      const xtags = typeof fmt?.xtags === 'string' ? fmt.xtags : '';
      let isOrig = Boolean(track?.audioIsDefault && !track?.isAutoDubbed);
      if (xtags) {
        try {
          const decoded = atob(xtags.replace(/-/g, '+').replace(/_/g, '/'));
          if (decoded.toLowerCase().includes('original')) isOrig = true;
        } catch {}
        if (xtags.toLowerCase().includes('acont=original') || xtags.toLowerCase().includes('original')) {
          isOrig = true;
        }
      }
      if (isOrig) {
        const c = code(track?.id?.split('.')?.[0]) || code(track?.languageCode);
        if (c) return c;
      }
    }
  } catch {}

  // 2. Declared defaultAudioLanguage
  const declared = code(response?.videoDetails?.defaultAudioLanguage)
    || code(response?.microformat?.playerMicroformatRenderer?.defaultAudioLanguage)
    || code(response?.snippet?.defaultAudioLanguage);
  if (declared) return declared;

  // 3. Player audio tracks
  let audioTracks = [];
  try { audioTracks = player?.getAvailableAudioTracks?.() || []; } catch {}
  if (!Array.isArray(audioTracks)) audioTracks = [];
  const audioCode = track => code(track?.languageCode || track?.language)
    || code(track?.id?.split('.')[0]);
  const original = audioTracks.find(t => t.isOriginal === true || t.is_original === true || t.audioIsOriginal === true || (t.audioIsDefault === true && !t.isAutoDubbed));
  if (audioCode(original)) return audioCode(original);

  // 4. Sole ASR caption track
  const captions = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  const asrLanguages = [...new Set(captions.filter(t => t.kind === 'asr').map(t => code(t.languageCode)).filter(Boolean))];
  if (asrLanguages.length === 1) return asrLanguages[0];
  if (audioTracks.length === 1) return audioCode(audioTracks[0]);
  return '';
}`;

/**
 * Self-superseding runtime installer:
 * - Disposes any prior injected instance via `tai:content-instance-started`
 * - Installs PerformanceObserver for `/api/timedtext` XHRs (Layer 1 sniffing + 60s expiry + pot check)
 * - Hooks fetch/XHR to capture timedtext response bodies (429 prevention)
 * - Installs MutationObserver on `#movie_player` (`ad-showing`/`ad-interrupting`)
 * - Installs `<video>` event listeners (`waiting`, `playing`, `pause`, `seeked`, `ended`)
 */
const installRuntimeHooks = `(() => {
  const RUNTIME_VERSION = 'v2-realtime';
  if (window.__taiRuntimeVersion === RUNTIME_VERSION && window.__taiRuntimeActive) return;

  // Dispose any older injected instance cleanly
  window.dispatchEvent(new CustomEvent('tai:content-instance-started', { detail: { version: RUNTIME_VERSION } }));

  const instanceId = Math.random().toString(36).slice(2);
  window.__taiRuntimeVersion = RUNTIME_VERSION;
  window.__taiRuntimeActive = true;
  window.__taiInstanceId = instanceId;
  window.__taiCapturedCaptions = window.__taiCapturedCaptions || {};
  window.__taiObservedTimedtext = window.__taiObservedTimedtext || [];
  window.__taiPlayerEvents = window.__taiPlayerEvents || {
    seekVersion: 0,
    buffering: false,
    adShowing: false,
    lastVideoEl: null
  };

  const cleanups = [];

  // Layer 1: PerformanceObserver for /api/timedtext XHR entries
  try {
    const recordPerfEntry = entry => {
      try {
        if (!entry || typeof entry.name !== 'string') return;
        if (!entry.name.includes('/api/timedtext')) return;
        if (entry.initiatorType && entry.initiatorType !== 'xmlhttprequest' && entry.initiatorType !== 'fetch') return;
        const parsed = new URL(entry.name, location.href);
        const v = parsed.searchParams.get('v') || '';
        if (!v) return;
        const hasPot = Boolean(parsed.searchParams.get('pot'));
        const encodedSize = Number(entry.encodedBodySize || 0);
        const source = (hasPot || encodedSize > 0) ? 'page' : 'potless';
        const list = window.__taiObservedTimedtext;
        list.push({ url: parsed.href, videoId: v, source, hasPot, at: Date.now() });
        if (list.length > 40) list.splice(0, list.length - 40);
      } catch {}
    };
    const perfObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) recordPerfEntry(entry);
    });
    perfObserver.observe({ type: 'resource', buffered: true });
    cleanups.push(() => perfObserver.disconnect());
  } catch {}

  // Hook fetch/XHR once per page lifetime to capture response bodies
  if (!window.__taiNetworkHooked) {
    window.__taiNetworkHooked = true;
    try {
      const origFetch = window.fetch;
      window.fetch = async function(...args) {
        const res = await origFetch.apply(this, args);
        try {
          const u = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
          if (typeof u === 'string' && u.includes('/api/timedtext')) {
            const parsed = new URL(u, location.href);
            const v = parsed.searchParams.get('v');
            const tlang = parsed.searchParams.get('tlang');
            const lang = parsed.searchParams.get('lang');
            if (v) {
              const hasPot = Boolean(parsed.searchParams.get('pot'));
              window.__taiObservedTimedtext.push({
                url: parsed.href,
                videoId: v,
                source: hasPot ? 'page' : 'potless',
                hasPot,
                at: Date.now()
              });
            }
            res.clone().text().then(text => {
              if (!text) return;
              window.__taiCapturedCaptions[parsed.href] = text;
              if (v) window.__taiCapturedCaptions[v + '/' + (tlang || lang || '')] = text;
            }).catch(() => {});
          }
        } catch {}
        return res;
      };

      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this.__taiUrl = typeof url === 'string' ? url : String(url || '');
        return origOpen.call(this, method, url, ...rest);
      };
      XMLHttpRequest.prototype.send = function(...args) {
        this.addEventListener('load', () => {
          try {
            if (typeof this.__taiUrl === 'string' && this.__taiUrl.includes('/api/timedtext') && this.responseText) {
              const parsed = new URL(this.__taiUrl, location.href);
              const v = parsed.searchParams.get('v');
              const tlang = parsed.searchParams.get('tlang');
              const lang = parsed.searchParams.get('lang');
              window.__taiCapturedCaptions[parsed.href] = this.responseText;
              if (v) {
                window.__taiCapturedCaptions[v + '/' + (tlang || lang || '')] = this.responseText;
                const hasPot = Boolean(parsed.searchParams.get('pot'));
                window.__taiObservedTimedtext.push({
                  url: parsed.href,
                  videoId: v,
                  source: (hasPot || this.responseText.length > 0) ? 'page' : 'potless',
                  hasPot,
                  at: Date.now()
                });
              }
            }
          } catch {}
        });
        return origSend.apply(this, args);
      };
    } catch {}
  }

  // Ad MutationObserver + video element lifecycle hooks
  let adObserver = null;
  let boundPlayer = null;
  let boundVideo = null;
  let videoCleanups = [];

  const bindPlayerAndVideo = () => {
    const player = document.getElementById('movie_player');
    if (player && player !== boundPlayer) {
      if (adObserver) adObserver.disconnect();
      boundPlayer = player;
      const updateAd = () => {
        window.__taiPlayerEvents.adShowing =
          player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting');
      };
      updateAd();
      adObserver = new MutationObserver(updateAd);
      adObserver.observe(player, { attributes: true, attributeFilter: ['class'] });
    }

    const v = document.querySelector('video');
    if (v && v !== boundVideo) {
      for (const fn of videoCleanups) fn();
      videoCleanups = [];
      boundVideo = v;
      const onWaiting = () => { window.__taiPlayerEvents.buffering = true; };
      const onPlaying = () => { window.__taiPlayerEvents.buffering = false; };
      const onCanPlay = () => { window.__taiPlayerEvents.buffering = false; };
      const onSeeked = () => { window.__taiPlayerEvents.seekVersion = (window.__taiPlayerEvents.seekVersion || 0) + 1; };
      v.addEventListener('waiting', onWaiting);
      v.addEventListener('stalled', onWaiting);
      v.addEventListener('playing', onPlaying);
      v.addEventListener('canplay', onCanPlay);
      v.addEventListener('seeked', onSeeked);
      videoCleanups.push(() => {
        v.removeEventListener('waiting', onWaiting);
        v.removeEventListener('stalled', onWaiting);
        v.removeEventListener('playing', onPlaying);
        v.removeEventListener('canplay', onCanPlay);
        v.removeEventListener('seeked', onSeeked);
      });
    }
  };

  bindPlayerAndVideo();
  const rebindTimer = setInterval(bindPlayerAndVideo, 1000);
  cleanups.push(() => {
    clearInterval(rebindTimer);
    if (adObserver) adObserver.disconnect();
    for (const fn of videoCleanups) fn();
  });

  const onSupersede = () => {
    if (window.__taiInstanceId !== instanceId) return;
    window.__taiRuntimeActive = false;
    for (const fn of cleanups) { try { fn(); } catch {} }
    window.removeEventListener('tai:content-instance-started', onSupersede);
  };
  window.addEventListener('tai:content-instance-started', onSupersede);
})()`;

export const inspectVideo = `(() => {
  ${installRuntimeHooks}
  ${readPlayerResponse}
  ${readTranslationLanguages}
  ${detectOriginalLanguage}
  const v = document.querySelector('video');
  const player = document.getElementById('movie_player');
  const r = readPlayerResponse();
  const id = new URL(location.href).searchParams.get('v') || location.pathname.match(/^\\/shorts\\/([^/]+)/)?.[1] || '';
  const adDom = Boolean(
    player?.classList?.contains('ad-showing')
    || player?.classList?.contains('ad-interrupting')
    || document.querySelector('.ad-showing, .ad-interrupting')
  );
  const adShowing = adDom || Boolean(window.__taiPlayerEvents?.adShowing);
  const matchesId = r?.videoDetails?.videoId === id;

  const captionLanguages = matchesId
    ? readTranslationLanguages(player, r)
        .filter(t => typeof t.languageCode === 'string')
        .map(t => ({
          value: t.languageCode,
          label: typeof t.languageName === 'string'
            ? t.languageName
            : t.languageName?.simpleText || t.languageName?.runs?.map(x => x.text).join('') || t.languageCode
        }))
    : [];

  const rawTracks = matchesId ? (r?.captions?.playerCaptionsTracklistRenderer?.captionTracks || []) : [];
  const tracks = rawTracks.map(t => ({
    baseUrl: typeof t.baseUrl === 'string' ? t.baseUrl : undefined,
    languageCode: String(t.languageCode || ''),
    name: typeof t.name === 'string' ? t.name : t.name?.simpleText || t.name?.runs?.map(x => x.text).join('') || '',
    kind: typeof t.kind === 'string' ? t.kind : undefined,
    isAutoGenerated: t.kind === 'asr',
    isTranslatable: t.isTranslatable !== false && t.is_translatable !== false
  })).filter(t => t.languageCode);

  const nowMs = Date.now();
  const observed = (window.__taiObservedTimedtext || []).filter(item => {
    if (item.videoId !== id) return false;
    try {
      const u = new URL(item.url);
      const exp = Number(u.searchParams.get('expire'));
      if (Number.isFinite(exp) && exp > 0 && exp * 1000 <= nowMs + 60000) return false;
      return true;
    } catch { return false; }
  });

  const buffering = Boolean(
    window.__taiPlayerEvents?.buffering
    || (v && !v.paused && !v.ended && v.readyState < 3)
  );

  return {
    id,
    title: matchesId ? (r.videoDetails.title || document.title) : document.title,
    captionLanguages,
    tracks,
    detectedSourceLanguage: matchesId ? detectOriginalLanguage(player, r) : '',
    valid: Boolean(v) && matchesId,
    ad: adShowing,
    live: Boolean(r?.videoDetails?.isLiveContent),
    time: Number.isFinite(v?.currentTime) ? v.currentTime : 0,
    duration: Number.isFinite(v?.duration) ? v.duration : 0,
    paused: v?.paused ?? true,
    ended: v?.ended ?? false,
    buffering,
    rate: Number.isFinite(v?.playbackRate) ? v.playbackRate : 1,
    muted: v?.muted ?? false,
    volume: Number.isFinite(v?.volume) ? v.volume : 1,
    seekVersion: window.__taiPlayerEvents?.seekVersion || 0,
    observedTimedtext: observed.slice(-8),
    overlayAnchor: window.__taiOverlayAnchor || null
  };
})()`;

/**
 * Polls `#movie_player.getPlayerResponse()` for up to 3,000ms (300ms retry sleep)
 * validating `videoId === expectedId`.
 */
export function pollPlayerMetadataScript(expectedVideoId: string) {
  return `(async () => {
    ${installRuntimeHooks}
    ${readPlayerResponse}
    ${readTranslationLanguages}
    ${detectOriginalLanguage}
    const expectedId = ${JSON.stringify(expectedVideoId)};
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const player = document.getElementById('movie_player');
      const r = readPlayerResponse();
      if (r?.videoDetails?.videoId === expectedId) {
        const rawTracks = r?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
        const tracks = rawTracks.map(t => ({
          baseUrl: typeof t.baseUrl === 'string' ? t.baseUrl : undefined,
          languageCode: String(t.languageCode || ''),
          name: typeof t.name === 'string' ? t.name : t.name?.simpleText || t.name?.runs?.map(x => x.text).join('') || '',
          kind: typeof t.kind === 'string' ? t.kind : undefined,
          isAutoGenerated: t.kind === 'asr',
          isTranslatable: t.isTranslatable !== false && t.is_translatable !== false
        })).filter(t => t.languageCode);
        const translationLanguages = readTranslationLanguages(player, r)
          .filter(t => typeof t.languageCode === 'string')
          .map(t => ({
            languageCode: t.languageCode,
            languageName: typeof t.languageName === 'string'
              ? t.languageName
              : t.languageName?.simpleText || t.languageName?.runs?.map(x => x.text).join('') || t.languageCode
          }));
        return {
          ok: true,
          videoId: expectedId,
          title: r.videoDetails.title || document.title,
          live: Boolean(r.videoDetails.isLiveContent),
          originalAudioLanguage: detectOriginalLanguage(player, r),
          tracks,
          translationLanguages
        };
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    return { ok: false, videoId: expectedId };
  })()`;
}

/**
 * Triggers YouTube's CC button to force an authorized `/api/timedtext` XHR with `pot`.
 * Remembers original CC pressed state in `window.__taiPrevCcPressed` so stop/dispose can revert it.
 */
export function toggleCaptionsForCaptureScript(videoId: string, forceToggle = false) {
  return `(async () => {
    const currentId = () => new URL(location.href).searchParams.get('v') || location.pathname.split('/shorts/')[1]?.split('/')[0];
    if (currentId() !== ${JSON.stringify(videoId)}) return { toggled: false, reason: 'video-changed' };
    const button = document.querySelector('.ytp-subtitles-button');
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') {
      return { toggled: false, reason: 'no-cc-button' };
    }
    const wasPressed = button.getAttribute('aria-pressed') === 'true';
    if (window.__taiPrevCcPressed === undefined) {
      window.__taiPrevCcPressed = wasPressed;
    }
    if (wasPressed && ${JSON.stringify(forceToggle)}) {
      button.click();
      await new Promise(resolve => setTimeout(resolve, 150));
      button.click();
      return { toggled: true, wasPressed };
    }
    if (!wasPressed) {
      button.click();
      return { toggled: true, wasPressed };
    }
    // Already pressed: cycle off -> 150ms -> on to emit a fresh timedtext request
    button.click();
    await new Promise(resolve => setTimeout(resolve, 150));
    button.click();
    return { toggled: true, wasPressed };
  })()`;
}

export function revertCaptionsToggleScript(videoId: string) {
  return `(() => {
    const currentId = new URL(location.href).searchParams.get('v') || location.pathname.split('/shorts/')[1]?.split('/')[0];
    if (videoIdMatch(currentId, ${JSON.stringify(videoId)})) {
      const button = document.querySelector('.ytp-subtitles-button');
      const prev = window.__taiPrevCcPressed;
      if (button && typeof prev === 'boolean') {
        const nowPressed = button.getAttribute('aria-pressed') === 'true';
        if (nowPressed !== prev) button.click();
      }
    }
    window.__taiPrevCcPressed = undefined;
    function videoIdMatch(a, b) { return !b || a === b; }
  })()`;
}

/**
 * Downloads a YouTube `/api/timedtext` URL inside the YouTube WebContents context
 * (carrying user cookies and avoiding CORS), checking intercepted cache first.
 */
export function downloadTimedtextInPageScript(targetUrl: string, expectedVideoId: string) {
  return `(async () => {
    const url = new URL(${JSON.stringify(targetUrl)});
    const expectedId = ${JSON.stringify(expectedVideoId)};
    if (url.protocol !== 'https:' || !(url.hostname === 'youtube.com' || url.hostname.endsWith('.youtube.com')) || url.pathname !== '/api/timedtext') {
      return { ok: false, status: 400, error: 'Invalid timedtext URL' };
    }
    if (url.searchParams.get('v') !== expectedId) {
      return { ok: false, status: 400, error: 'Video mismatch' };
    }
    const cached = window.__taiCapturedCaptions?.[url.href];
    if (typeof cached === 'string' && cached.trim()) {
      return { ok: true, status: 200, text: cached, fromIntercept: true };
    }
    try {
      const res = await fetch(url.href, { credentials: 'include', signal: AbortSignal.timeout(20000) });
      const retryAfter = res.headers.get('retry-after');
      if (res.status === 429) {
        return { ok: false, status: 429, rateLimited: true, retryAfter };
      }
      if (!res.ok) {
        return { ok: false, status: res.status, error: 'HTTP ' + res.status };
      }
      const text = await res.text();
      if (!text.trim()) {
        return { ok: false, status: 204, error: 'Empty caption response' };
      }
      window.__taiCapturedCaptions = window.__taiCapturedCaptions || {};
      window.__taiCapturedCaptions[url.href] = text;
      return { ok: true, status: 200, text, fromIntercept: false };
    } catch (err) {
      return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
    }
  })()`;
}

/**
 * Direct `<video>` control script: controls real volume, sentinel playbackRate,
 * pause, play, and seek inside YouTube's DOM without hard-muting WebContents.
 */
export function controlVideoScript(cmd: VideoControlCommand) {
  return `(async () => {
    const v = document.querySelector('video');
    if (!v) return false;
    const type = ${JSON.stringify(cmd.type)};
    const value = ${JSON.stringify(cmd.value ?? null)};
    if (type === 'setVolume' && typeof value === 'number' && Number.isFinite(value)) {
      v.volume = Math.min(1, Math.max(0, value));
      return true;
    }
    if (type === 'setRate' && typeof value === 'number' && Number.isFinite(value)) {
      v.playbackRate = Math.min(4, Math.max(0.25, value));
      return true;
    }
    if (type === 'seek' && typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      v.currentTime = value;
      return true;
    }
    if (type === 'play') {
      await v.play().catch(() => {});
      return true;
    }
    if (type === 'pause') {
      v.pause();
      return true;
    }
    return false;
  })()`;
}

/**
 * Renders and updates the in-player subtitle overlay inside `#movie_player`:
 * - Modes: `bilingual` (`#ffd700` translated + `0.85em` source, deduped if identical), `translated`, `hidden`
 * - Shows `sounds[]` in speech gaps when mode is `bilingual`
 * - Mirrors YouTube `yt-player-caption-display-settings` when available
 * - 2-pass auto-shrink (`40%` max player height, `0.5` min scale)
 * - Vertical drag (`3px` threshold, snaps `top`/`bottom` %, persists in `window.__taiOverlayAnchor`)
 * - Live status indicator (3-dot pulse preparing / 3-bar equalizer speaking)
 */
export function updateOverlayScript(payload: OverlayStatePayload) {
  return `(() => {
    const data = ${JSON.stringify(payload)};
    const player = document.getElementById('movie_player');
    if (!player) return;

    const STYLE_ID = 'tai-overlay-style';
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = \`
        #tai-subtitle-overlay {
          position: absolute;
          left: 50%;
          transform: translateX(-50%);
          z-index: 62;
          max-width: 86%;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 4px;
          pointer-events: auto;
          user-select: none;
          cursor: grab;
          padding: 8px 14px;
          border-radius: 10px;
          background: rgba(8, 12, 18, 0.78);
          backdrop-filter: blur(4px);
          text-align: center;
          line-height: 1.35;
          transition: opacity 0.12s ease;
          font-family: "YouTube Noto", Roboto, Arial, Helvetica, sans-serif;
          text-shadow: 0 1px 2px rgba(0,0,0,0.95), 0 0 4px rgba(0,0,0,0.8);
        }
        #tai-subtitle-overlay.tai-dragging { cursor: grabbing; }
        #tai-subtitle-overlay.tai-empty { display: none; }
        #tai-subtitle-overlay .tai-translated {
          color: #ffd700;
          font-weight: 700;
          word-break: break-word;
        }
        #tai-subtitle-overlay .tai-source {
          color: rgba(255, 255, 255, 0.92);
          font-size: 0.85em;
          font-weight: 500;
          word-break: break-word;
        }
        #tai-subtitle-overlay .tai-sound {
          color: #93c5fd;
          font-style: italic;
          font-size: 0.85em;
        }
        #tai-status-pill {
          position: absolute;
          top: 12px;
          right: 12px;
          z-index: 63;
          display: none;
          align-items: center;
          gap: 6px;
          padding: 5px 10px;
          border-radius: 999px;
          background: rgba(11, 16, 24, 0.76);
          border: 1px solid rgba(152, 186, 255, 0.35);
          color: #e6eefc;
          font-size: 12px;
          font-weight: 600;
          pointer-events: none;
        }
        #tai-status-pill.visible { display: inline-flex; }
        .tai-dots { display: inline-flex; gap: 3px; align-items: center; }
        .tai-dots span {
          width: 5px; height: 5px; border-radius: 50%; background: #98baff;
          animation: taiDotPulse 1.1s infinite ease-in-out;
        }
        .tai-dots span:nth-child(2) { animation-delay: 0.18s; }
        .tai-dots span:nth-child(3) { animation-delay: 0.36s; }
        .tai-bars { display: inline-flex; gap: 2px; align-items: flex-end; height: 12px; }
        .tai-bars span {
          width: 3px; border-radius: 2px; background: #ffd700;
          animation: taiBarEq 0.75s infinite ease-in-out;
        }
        .tai-bars span:nth-child(1) { height: 5px; }
        .tai-bars span:nth-child(2) { height: 11px; animation-delay: 0.15s; }
        .tai-bars span:nth-child(3) { height: 7px; animation-delay: 0.3s; }
        @keyframes taiDotPulse {
          0%, 80%, 100% { opacity: 0.25; transform: scale(0.8); }
          40% { opacity: 1; transform: scale(1.15); }
        }
        @keyframes taiBarEq {
          0%, 100% { transform: scaleY(0.35); }
          50% { transform: scaleY(1); }
        }
      \`;
      document.head.appendChild(style);
    }

    // Status pill
    let pill = document.getElementById('tai-status-pill');
    if (!pill) {
      pill = document.createElement('div');
      pill.id = 'tai-status-pill';
      player.appendChild(pill);
    }
    if (data.status === 'preparing' || data.status === 'buffering') {
      pill.className = 'visible';
      pill.innerHTML = '<span class="tai-dots"><span></span><span></span><span></span></span><span>Preparing</span>';
    } else if (data.status === 'speaking') {
      pill.className = 'visible';
      pill.innerHTML = '<span class="tai-bars"><span></span><span></span><span></span></span><span>Dubbing</span>';
    } else {
      pill.className = '';
      pill.innerHTML = '';
    }

    // Subtitle overlay element
    let el = document.getElementById('tai-subtitle-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'tai-subtitle-overlay';
      player.appendChild(el);

      // Vertical drag with 3px threshold + top/bottom % anchor persistence
      let dragging = false;
      let startY = 0;
      let startTop = 0;
      let moved = false;

      el.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        const rect = el.getBoundingClientRect();
        const pRect = player.getBoundingClientRect();
        dragging = true;
        moved = false;
        startY = e.clientY;
        startTop = rect.top - pRect.top;
        el.setPointerCapture?.(e.pointerId);
      });
      el.addEventListener('pointermove', e => {
        if (!dragging) return;
        const dy = e.clientY - startY;
        if (!moved && Math.abs(dy) < 3) return;
        moved = true;
        el.classList.add('tai-dragging');
        const pRect = player.getBoundingClientRect();
        const elH = el.offsetHeight || 40;
        const nextTop = Math.max(8, Math.min(pRect.height - elH - 8, startTop + dy));
        const topPct = Math.round((nextTop / Math.max(1, pRect.height)) * 100);
        const bottomPct = Math.round(((pRect.height - (nextTop + elH)) / Math.max(1, pRect.height)) * 100);
        if (topPct < 45) {
          el.style.top = topPct + '%';
          el.style.bottom = 'auto';
          window.__taiOverlayAnchor = { edge: 'top', pct: Math.min(95, Math.max(2, topPct)) };
        } else {
          el.style.top = 'auto';
          el.style.bottom = bottomPct + '%';
          window.__taiOverlayAnchor = { edge: 'bottom', pct: Math.min(95, Math.max(2, bottomPct)) };
        }
      });
      const endDrag = () => {
        if (!dragging) return;
        dragging = false;
        el.classList.remove('tai-dragging');
      };
      el.addEventListener('pointerup', endDrag);
      el.addEventListener('pointercancel', endDrag);
    }

    // Apply persisted anchor if not currently dragging
    const anchor = window.__taiOverlayAnchor || data.anchor || { edge: 'bottom', pct: 10 };
    if (!el.classList.contains('tai-dragging')) {
      if (anchor.edge === 'top') {
        el.style.top = anchor.pct + '%';
        el.style.bottom = 'auto';
      } else {
        el.style.top = 'auto';
        el.style.bottom = anchor.pct + '%';
      }
    }

    // Mirror YouTube caption display settings if available
    try {
      const rawYt = localStorage.getItem('yt-player-caption-display-settings');
      if (rawYt) {
        const parsed = JSON.parse(rawYt);
        const cfg = typeof parsed?.data === 'string' ? JSON.parse(parsed.data) : parsed?.data;
        if (cfg?.backgroundOpacity !== undefined) {
          el.style.background = 'rgba(8, 12, 18, ' + Math.min(0.95, Math.max(0.25, Number(cfg.backgroundOpacity))) + ')';
        }
      }
    } catch {}

    // Auto-coerce hidden -> bilingual when dubbing is off
    const effectiveMode = (!data.dubbingActive && data.mode === 'hidden') ? 'bilingual' : data.mode;
    if (effectiveMode === 'hidden') {
      el.classList.add('tai-empty');
      el.innerHTML = '';
      return;
    }

    const translated = (data.translatedText || '').trim();
    const source = (data.sourceText || '').trim();
    const sound = (data.soundText || '').trim();

    const showSoundOnly = !translated && !source && Boolean(sound) && effectiveMode === 'bilingual';
    if (!translated && !source && !showSoundOnly) {
      el.classList.add('tai-empty');
      el.innerHTML = '';
      return;
    }

    el.classList.remove('tai-empty');
    el.innerHTML = '';

    if (showSoundOnly) {
      const sDiv = document.createElement('div');
      sDiv.className = 'tai-sound';
      sDiv.textContent = sound;
      el.appendChild(sDiv);
    } else {
      if (translated) {
        const tDiv = document.createElement('div');
        tDiv.className = 'tai-translated';
        tDiv.textContent = translated;
        el.appendChild(tDiv);
      }
      const sameText = translated && source && translated.toLowerCase() === source.toLowerCase();
      if (effectiveMode === 'bilingual' && source && !sameText) {
        const sDiv = document.createElement('div');
        sDiv.className = 'tai-source';
        sDiv.textContent = source;
        el.appendChild(sDiv);
      }
    }

    // 2-pass auto-shrink if overlay height > 40% of player height (min scale 0.5)
    const playerH = player.clientHeight || 480;
    const basePx = Math.max(15, Math.min(28, Math.round(playerH * 0.042)));
    let scale = 1.0;
    el.style.fontSize = basePx + 'px';
    const maxH = playerH * 0.4;
    for (let pass = 0; pass < 2; pass++) {
      const h = el.offsetHeight;
      if (h > maxH && h > 0) {
        scale = Math.max(0.5, scale * Math.sqrt(maxH / h));
        el.style.fontSize = (basePx * scale).toFixed(1) + 'px';
      } else {
        break;
      }
    }
  })()`;
}

// Legacy native captions helpers retained for compatibility with manual subtitle refresh
export function requestNativeCaptions(language = 'en', videoId = '') {
  return `(async () => {
    ${installRuntimeHooks}
    ${readPlayerResponse}
    ${readTranslationLanguages}
    const language = ${JSON.stringify(language)};
    const expectedId = ${JSON.stringify(videoId)};
    const names = { en: 'Tiếng Anh', zh: 'Tiếng Trung', ja: 'Tiếng Nhật', ko: 'Tiếng Hàn' };
    const matches = code => {
      const normalized = String(code || '').toLowerCase();
      const base = normalized.split('-')[0];
      return normalized === language.toLowerCase() || base === language.toLowerCase() || (language === 'zh' && base === 'cmn');
    };
    const currentId = () => new URL(location.href).searchParams.get('v') || location.pathname.split('/shorts/')[1]?.split('/')[0];
    let button;
    for (let i = 0; i < 20; i++) {
      button = document.querySelector('.ytp-subtitles-button');
      if (button && !button.disabled && button.getAttribute('aria-disabled') !== 'true') break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') throw new Error('Không tìm thấy nút CC khả dụng. Hãy chọn video có phụ đề.');
    const player = document.getElementById('movie_player');
    if (!player || typeof player.setOption !== 'function') throw new Error('YouTube Player chưa sẵn sàng chọn ngôn ngữ phụ đề.');
    player.loadModule?.('captions');
    let track, translation;
    for (let i = 0; i < 30; i++) {
      if (expectedId && currentId() !== expectedId) throw new Error('Video đã thay đổi trong khi chọn phụ đề.');
      const response = readPlayerResponse();
      const liveTracks = player.getOption?.('captions', 'tracklist');
      const metadataTracks = response?.videoDetails?.videoId === currentId()
        ? response?.captions?.playerCaptionsTracklistRenderer?.captionTracks : [];
      const tracks = Array.isArray(liveTracks) && liveTracks.length ? liveTracks : (metadataTracks || []);
      const candidates = tracks.filter(t => t.is_translatable !== false && t.isTranslatable !== false);
      track = candidates.find(t => t.kind === 'asr') || candidates[0];
      const languages = readTranslationLanguages(player, response);
      translation = languages.find(t => t.languageCode === language) || (language === 'zh' ? languages.find(t => matches(t.languageCode)) : undefined);
      if (track && (translation || (track.kind === 'asr' && matches(track.languageCode)))) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!track) throw new Error('Video chưa có phụ đề đầu vào để YouTube Dịch tự động.');
    if (!translation && !(track.kind === 'asr' && matches(track.languageCode))) throw new Error('YouTube không có Dịch tự động sang ' + (names[language] || language) + ' cho video này.');
    const translatedName = typeof translation?.languageName === 'string' ? translation.languageName : translation?.languageName?.simpleText || translation?.languageCode;
    const translationLanguage = track.kind === 'asr' && matches(track.languageCode) ? null
      : translation ? { ...translation, languageName: translatedName } : null;
    let selected;
    try { selected = player.getOption?.('captions', 'track'); } catch {}
    const sameTrack = selected?.languageCode === track.languageCode
      && (selected?.kind || '') === (track.kind || '')
      && (selected?.translationLanguage?.languageCode || '') === (translationLanguage?.languageCode || '');
    if (!sameTrack) player.setOption('captions', 'track', { ...track, translationLanguage });
    if (button.getAttribute('aria-pressed') !== 'true') button.click();
  })()`;
}

export function stopNativeCaptions(videoId: string) {
  return `(() => {
    const currentId = new URL(location.href).searchParams.get('v') || location.pathname.split('/shorts/')[1]?.split('/')[0];
    if (currentId !== ${JSON.stringify(videoId)}) return;
    const button = document.querySelector('.ytp-subtitles-button');
    if (button?.getAttribute('aria-pressed') === 'true') button.click();
  })()`;
}

export function fetchCapturedCaptions(capturedUrl: string, videoId: string, language = 'en') {
  return `(async () => {
    const url = new URL(${JSON.stringify(capturedUrl)});
    const expectedId = ${JSON.stringify(videoId)};
    const language = ${JSON.stringify(language)};
    const translated = url.searchParams.get('tlang');
    const actual = (translated || (url.searchParams.get('kind') === 'asr' ? url.searchParams.get('lang') : '') || '').toLowerCase();
    if (!(actual === language.toLowerCase() || (language === 'zh' && actual.split('-')[0] === 'zh'))) throw new Error('YouTube chưa trả phụ đề Dịch tự động đúng ngôn ngữ đã chọn.');
    const currentId = new URL(location.href).searchParams.get('v') || location.pathname.split('/shorts/')[1]?.split('/')[0];
    if (currentId !== expectedId || url.searchParams.get('v') !== expectedId) throw new Error('Video đã thay đổi trong khi lấy phụ đề.');
    if (url.protocol !== 'https:' || !(url.hostname === 'youtube.com' || url.hostname.endsWith('.youtube.com')) || url.pathname !== '/api/timedtext') throw new Error('URL phụ đề không hợp lệ.');
    let raw = window.__taiCapturedCaptions?.[url.href] || window.__taiCapturedCaptions?.[expectedId + '/' + (translated || actual)];
    if (!raw && window.__taiCapturedCaptions) {
      for (const [k, v] of Object.entries(window.__taiCapturedCaptions)) {
        if (typeof v === 'string' && k.includes(expectedId) && (k.includes(language) || (translated && k.includes(translated)))) {
          raw = v;
          break;
        }
      }
    }
    if (!raw) {
      const res = await fetch(url.href, { credentials: 'include', signal: AbortSignal.timeout(20000) });
      if (res.status === 429) return { captionRateLimited: true, retryAfter: res.headers.get('retry-after') };
      if (!res.ok) throw new Error('Request phụ đề bắt được trả HTTP ' + res.status + '.');
      raw = await res.text();
    }
    if (!raw.trim()) throw new Error('Đã bắt được request timedtext nhưng YouTube vẫn trả body rỗng.');
    if (raw.trim().startsWith('{')) {
      const data = JSON.parse(raw);
      return (data.events || []).filter(e => e.segs && e.dDurationMs > 0).map(e => ({
        start: e.tStartMs / 1000, end: (e.tStartMs + e.dDurationMs) / 1000,
        text: e.segs.map(s => s.utf8 || '').join('').trim()
      })).filter(s => s.text);
    }
    const xml = new DOMParser().parseFromString(raw, 'text/xml');
    if (xml.querySelector('parsererror')) throw new Error('Request phụ đề trả dữ liệu không đọc được.');
    return [...xml.querySelectorAll('text, p')].map(e => {
      const start = Number(e.getAttribute('start') ?? Number(e.getAttribute('t')) / 1000);
      const duration = Number(e.getAttribute('dur') ?? Number(e.getAttribute('d')) / 1000);
      return { start, end: start + duration, text: e.textContent || '' };
    }).filter(s => s.text && s.end > s.start);
  })()`;
}
