// Runs only inside the isolated, unprivileged YouTube WebContents.
export const inspectVideo = `(() => {
 const v = document.querySelector('video');
 const p = document.querySelector('#movie_player');
 const r = p?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
 const id = new URL(location.href).searchParams.get('v') || location.pathname.match(/^\\/shorts\\/([^/]+)/)?.[1] || '';
 const ad = !!document.querySelector('.ad-showing');
 return { id, title: r?.videoDetails?.videoId === id ? r.videoDetails.title : document.title,
   valid: !!v && r?.videoDetails?.videoId === id, ad, live: !!r?.videoDetails?.isLiveContent,
   time: v?.currentTime || 0, paused: v?.paused ?? true, rate: v?.playbackRate || 1,
   muted: v?.muted ?? false, volume: v?.volume ?? 1 };
})()`;
export const extractCaptions = `(async () => {
 const id = new URL(location.href).searchParams.get('v') || location.pathname.split('/shorts/')[1]?.split('/')[0];
 let r;
 for (let i = 0; i < 20; i++) {
   const p = document.querySelector('#movie_player');
   r = p?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
   if (r?.videoDetails?.videoId === id && r?.captions?.playerCaptionsTracklistRenderer) break;
   if (i === 19) return [];
   await new Promise(resolve => setTimeout(resolve, 500));
 }
 const tracks = r?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
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
