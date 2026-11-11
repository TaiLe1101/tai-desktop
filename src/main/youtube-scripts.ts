// Runs only inside the isolated, unprivileged YouTube WebContents.
// executeJavaScript runs in YouTube's main world. Read the live player only.
const readPlayerResponse = `function readPlayerResponse() {
 const player = document.getElementById('movie_player');
 if (!player || typeof player.getPlayerResponse !== 'function') return null;
 try {
   const response = player.getPlayerResponse();
   return typeof response === 'string' ? JSON.parse(response) : response;
 } catch { return null; }
}`;
export const inspectVideo = `(() => {
 ${readPlayerResponse}
 const v = document.querySelector('video');
 const r = readPlayerResponse();
 const id = new URL(location.href).searchParams.get('v') || location.pathname.match(/^\\/shorts\\/([^/]+)/)?.[1] || '';
 const ad = !!document.querySelector('.ad-showing');
 return { id, title: r?.videoDetails?.videoId === id ? r.videoDetails.title : document.title,
   valid: !!v && r?.videoDetails?.videoId === id, ad, live: !!r?.videoDetails?.isLiveContent,
   time: v?.currentTime || 0, paused: v?.paused ?? true, rate: v?.playbackRate || 1,
   muted: v?.muted ?? false, volume: v?.volume ?? 1 };
})()`;
// Method 2: select a source track, then capture YouTube's own request.
export function requestNativeCaptions(language = 'en', videoId = '') {
 return `(async () => {
 ${readPlayerResponse}
 const language = ${JSON.stringify(language)};
 const expectedId = ${JSON.stringify(videoId)};
 const names = { en: 'Tiếng Anh', zh: 'Tiếng Trung', ja: 'Tiếng Nhật', ko: 'Tiếng Hàn' };
 const matches = code => {
   const base = String(code || '').toLowerCase().split('-')[0];
   return base === language || (language === 'zh' && base === 'cmn');
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
 let track;
 for (let i = 0; i < 30; i++) {
   if (expectedId && currentId() !== expectedId) throw new Error('Video đã thay đổi trong khi chọn phụ đề.');
   const response = readPlayerResponse();
   const liveTracks = player.getOption?.('captions', 'tracklist');
   const metadataTracks = response?.videoDetails?.videoId === currentId()
     ? response?.captions?.playerCaptionsTracklistRenderer?.captionTracks : [];
   const tracks = Array.isArray(liveTracks) && liveTracks.length ? liveTracks : (metadataTracks || []);
   const candidates = tracks.filter(t => matches(t.languageCode) && !t.translationLanguage);
   track = candidates.find(t => t.kind !== 'asr') || candidates[0];
   if (track) break;
   await new Promise(resolve => setTimeout(resolve, 250));
 }
 if (!track) throw new Error('Video không có phụ đề nguồn ' + (names[language] || language) + '.');
 if (button.getAttribute('aria-pressed') === 'true') {
   button.click();
   await new Promise(resolve => setTimeout(resolve, 200));
 }
 if (button.getAttribute('aria-pressed') !== 'true') button.click();
 // Use the actual track object and clear auto-translation, never rewrite its URL.
 player.setOption('captions', 'track', { ...track, translationLanguage: null });
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
 const actual = (url.searchParams.get('lang') || '').toLowerCase().split('-')[0];
 if (url.searchParams.has('tlang') || !(actual === language || (language === 'zh' && actual === 'cmn'))) throw new Error('YouTube trả track khác ngôn ngữ nguồn đã chọn.');
 const currentId = new URL(location.href).searchParams.get('v') || location.pathname.split('/shorts/')[1]?.split('/')[0];
 if (currentId !== expectedId || url.searchParams.get('v') !== expectedId) throw new Error('Video đã thay đổi trong khi lấy phụ đề.');
 if (url.protocol !== 'https:' || !(url.hostname === 'youtube.com' || url.hostname.endsWith('.youtube.com')) || url.pathname !== '/api/timedtext') throw new Error('URL phụ đề không hợp lệ.');
 // Replay the exact URL requested by YouTube, in the same cookie/origin context.
 const res = await fetch(url.href, { credentials: 'include', signal: AbortSignal.timeout(20000) });
 if (!res.ok) throw new Error('Request phụ đề bắt được trả HTTP ' + res.status + '.');
 const raw = await res.text();
 if (!raw.trim()) throw new Error('Đã bắt được request timedtext nhưng YouTube vẫn trả body rỗng (cách 2).');
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
export const extractCaptions = `(async () => {
 ${readPlayerResponse}
 const id = new URL(location.href).searchParams.get('v') || location.pathname.split('/shorts/')[1]?.split('/')[0];
 let r;
 for (let i = 0; i < 30; i++) {
   const currentId = new URL(location.href).searchParams.get('v') || location.pathname.split('/shorts/')[1]?.split('/')[0];
   if (currentId !== id) throw new Error('Video đã thay đổi trong khi lấy phụ đề.');
   r = readPlayerResponse();
   const tracks = r?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
   if (r?.videoDetails?.videoId === id && Array.isArray(tracks) && tracks.some(t => typeof t.baseUrl === 'string' && t.baseUrl)) break;
   if (i === 29) {
     if (r?.videoDetails?.videoId !== id) throw new Error('Chưa đọc được dữ liệu video hiện tại từ YouTube Player. Hãy chờ video tải xong rồi thử lại.');
     return [];
   }
   await new Promise(resolve => setTimeout(resolve, 500));
 }
 const tracks = (r?.captions?.playerCaptionsTracklistRenderer?.captionTracks || []).filter(t => typeof t.baseUrl === 'string' && t.baseUrl);
 // Prefer authored captions in the original audio language; accept ASR in every language.
 const original = r?.captions?.playerCaptionsTracklistRenderer?.audioTracks?.[0]?.defaultCaptionTrackIndex;
 const track = tracks.find(t => t.kind !== 'asr' && t.languageCode === tracks[original]?.languageCode)
   || tracks[original] || tracks.find(t => t.kind !== 'asr') || tracks[0];
 if (!track) return [];
 const url = new URL(track.baseUrl);
 if (url.protocol !== 'https:' || !(url.hostname === 'youtube.com' || url.hostname.endsWith('.youtube.com'))) throw new Error('URL phụ đề không hợp lệ.');
 url.searchParams.set('fmt', 'json3');
 const res = await fetch(url.href, { signal: AbortSignal.timeout(20000), credentials: 'include' });
 if (!res.ok) throw new Error('YouTube trả HTTP ' + res.status + ' khi lấy phụ đề.');
 const raw = await res.text();
 if (!raw.trim()) throw new Error('YouTube trả phụ đề rỗng. Bật CC rồi bấm Thử lại.');
 if (raw.trim().startsWith('{')) {
   const data = JSON.parse(raw);
   return (data.events || []).filter(e => e.segs && e.dDurationMs > 0).map(e => ({
     start: e.tStartMs / 1000, end: (e.tStartMs + e.dDurationMs) / 1000,
     text: e.segs.map(s => s.utf8 || '').join('').trim()
   })).filter(s => s.text);
 }
 const xml = new DOMParser().parseFromString(raw, 'text/xml');
 return [...xml.querySelectorAll('text, p')].map(e => {
   const start = Number(e.getAttribute('start') ?? Number(e.getAttribute('t')) / 1000);
   const duration = Number(e.getAttribute('dur') ?? Number(e.getAttribute('d')) / 1000);
   return { start, end: start + duration, text: e.textContent || '' };
 }).filter(s => s.text && s.end > s.start);
})()`;
