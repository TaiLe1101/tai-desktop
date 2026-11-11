import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider, createTheme, CssBaseline, Box, Typography, Button, IconButton, Stack, ButtonBase, TextField, LinearProgress, Alert, Switch, FormControlLabel, Paper, Divider, MenuItem } from '@mui/material';
import YouTube from '@mui/icons-material/YouTube';
import SettingsIcon from '@mui/icons-material/Settings';
import ArrowBack from '@mui/icons-material/ArrowBack';
import Refresh from '@mui/icons-material/Refresh';
import Home from '@mui/icons-material/Home';
import ClosedCaption from '@mui/icons-material/ClosedCaption';
import Translate from '@mui/icons-material/Translate';
import FolderOpen from '@mui/icons-material/FolderOpen';
import type { DesktopApi, SettingsInput, VideoSession } from '../shared/types';
import { VoicePlayer } from './player';
import './style.css';
declare global { interface Window { tai: DesktopApi } }
const theme = createTheme({ palette: { mode: 'dark', primary: { main: '#98baff' }, background: { default: '#0b1018', paper: '#141c28' } }, typography: { fontFamily: 'Segoe UI, sans-serif', button: { textTransform: 'none', fontWeight: 600 } }, shape: { borderRadius: 12 }, components: { MuiButtonBase: { styleOverrides: { root: { cursor: 'default' } } } } });
const labels: Record<VideoSession['phase'], string> = { IDLE: 'Chọn một video để bắt đầu', EXTRACTING: 'Đang lấy phụ đề YouTube…', BUFFERING: 'Đang chuẩn bị các pack đầu…', PLAYING: 'Đang phát · tiếp tục dịch nền', COMPLETE: 'Đã xử lý toàn bộ video', ERROR: 'Xử lý bị gián đoạn', NO_SUBTITLES: 'Video chưa có phụ đề khả dụng' };
const stamp = (s: number) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
function App() {
  const [screen, setScreen] = useState<'home' | 'youtube' | 'settings'>('home');
  const [session, setSession] = useState<VideoSession | null>(null);
    const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [voice, setVoice] = useState(true);
  const [form, setForm] = useState<SettingsInput>({ workerUrl: '', targetLang: 'vi', launchAtLogin: false });
  const [hasKey, setHasKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cache, setCache] = useState('');
  const [opened, setOpened] = useState(false);
  const slot = useRef<HTMLDivElement>(null);
  const player = useRef(new VoicePlayer());
  const activeVoice = useRef(false);
  activeVoice.current = voice && screen === 'youtube';
  const run = async (fn: () => Promise<unknown>) => { try { setError(''); await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  useEffect(() => {
    void run(async () => { const s = await window.tai.settings(); setForm({ workerUrl: s.workerUrl, targetLang: s.targetLang, launchAtLogin: s.launchAtLogin }); setHasKey(s.hasApiKey); setCache((await window.tai.status()).cachePath); });
    let dead = false, busy = false;
    const tick = async () => {
      if (busy) return; busy = true;
      try { const s = await window.tai.session(); if (!dead) { setSession(s); await player.current.sync(s, activeVoice.current); } }
      catch (e) { if (!dead) setError(String(e)); } finally { busy = false; }
    };
    const timer = setInterval(() => { void tick(); }, 200);
    return () => { dead = true; clearInterval(timer); player.current.stop(); };
  }, []);
  useEffect(() => {
    if (screen !== 'youtube') { player.current.stop(); void window.tai.bounds(null); return; }
    const update = () => { if (slot.current) { const r = slot.current.getBoundingClientRect(); void window.tai.bounds({ x: r.x, y: r.y, width: r.width, height: r.height }); } };
    const observer = new ResizeObserver(update); if (slot.current) observer.observe(slot.current);
    window.addEventListener('resize', update); update();
    return () => { observer.disconnect(); window.removeEventListener('resize', update); void window.tai.bounds(null); };
  }, [screen]);
  async function openYoutube() { setScreen('youtube'); if (!opened) { setOpened(true); await run(() => window.tai.navigate('https://www.youtube.com')); } }
  const percent = session?.total ? Math.round(session.ready / session.total * 100) : 0;
  return <Box sx={{ height: '100%', display: 'flex' }}>
    <Stack sx={{ width: 88, borderRight: '1px solid #263242', alignItems: 'center', py: 3, gap: 3 }}>
      <Box sx={{ background: '#98baff', color: '#0b1018', p: 1.3, borderRadius: 3, fontWeight: 900, fontSize: 22 }}>T</Box>
      <IconButton aria-label="Trang chủ" onClick={() => setScreen('home')} color={screen === 'home' ? 'primary' : 'default'}><Home/></IconButton>
      <IconButton aria-label="YouTube" onClick={() => void openYoutube()} color={screen === 'youtube' ? 'primary' : 'default'}><YouTube/></IconButton>
      <Box sx={{ flex: 1 }}/><IconButton aria-label="Cấu hình" onClick={() => setScreen('settings')}><SettingsIcon/></IconButton>
      <Typography variant="caption" color="text.secondary">v2.0.0</Typography>
    </Stack>
    <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', p: screen === 'youtube' ? 1 : 3, gap: 2 }}>
      {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}
      {screen === 'home' && <Box aria-label="Nền tảng" sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, 100px)', alignContent: 'start', gap: 2, flex: 1 }}>
        <ButtonBase aria-label="Mở YouTube" onClick={() => void openYoutube()} sx={{ flexDirection: 'column', gap: 1, p: 1.5, borderRadius: 2, alignSelf: 'start', '&:hover': { bgcolor: 'action.hover' }, '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main' } }}>
          <Box sx={{ width: 60, height: 60, borderRadius: 2, bgcolor: '#f53142', display: 'grid', placeItems: 'center', boxShadow: '0 4px 16px #0004' }}><YouTube sx={{ fontSize: 42, color: '#fff' }}/></Box>
          <Typography variant="body2">YouTube</Typography>
        </ButtonBase>
      </Box>}
      {screen === 'youtube' && <>
        <Box sx={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 350px', gap: 2 }}>
          <Box ref={slot} className="web-slot"/>
          <Paper variant="outlined" sx={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <Box sx={{ p: 2 }}><Stack direction="row" sx={{ alignItems: "center", gap: 1 }}><ClosedCaption color="primary"/><Typography sx={{ fontWeight: 700 }}>Phụ đề & tiến trình</Typography></Stack>
              <Typography sx={{ fontWeight: 600, mt: 2, mb: 1 }}>{session?.title || 'Chưa chọn video'}</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>{session?.phase === 'IDLE' && session.videoId ? 'Nhấn Dịch để bắt đầu xử lý video này.' : session ? labels[session.phase] : 'Đang kết nối…'}</Typography>
              {session?.phase === 'IDLE' && <Button fullWidth variant="contained" startIcon={<Translate/>} disabled={!session.videoId} sx={{ mb: 2 }} onClick={() => void run(() => window.tai.startTranslation(session.videoId))}>Dịch</Button>}
              {session?.phase !== 'IDLE' && <>
              <LinearProgress variant={session?.phase === 'EXTRACTING' ? 'indeterminate' : 'determinate'} value={percent}/>
              <Stack direction="row" sx={{ justifyContent: "space-between", mt: 1 }}><Typography variant="caption">{session?.ready || 0}/{session?.total || 0} pack</Typography><Typography variant="caption">{percent}% {session?.cached ? '· Cache' : ''}</Typography></Stack>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>Phát từ 0:00 khi đủ {session?.initialRequired || '20%'} pack đầu. Các pack còn lại tiếp tục xử lý.</Typography>
              <FormControlLabel control={<Switch checked={voice} onChange={e => { setVoice(e.target.checked); if (!e.target.checked) player.current.stop(); }}/>} label="Giọng dịch AI"/>
              {session?.phase === 'NO_SUBTITLES' && <Alert severity="info">{session.error || 'Bật CC trên YouTube rồi thử lại. V2 chưa xử lý video không có phụ đề.'}</Alert>}
              {session?.phase === 'ERROR' && <Alert severity="error">{session.error}</Alert>}
              {session && ['ERROR', 'NO_SUBTITLES'].includes(session.phase) && <Button size="small" startIcon={<Refresh/>} onClick={() => void run(() => window.tai.retry())}>Thử lại / tiếp tục</Button>}
              </>}
            </Box><Divider/>
            <Box className="subtitle-list">{!session?.chunks.length && <Typography color="text.secondary" variant="body2" sx={{ mt: 3 }}>Chọn video trên YouTube rồi nhấn Dịch để xem phụ đề và tiến trình.</Typography>}
              {session?.chunks.map(c => <Box key={c.id} className={`cue ${session.time >= c.start && session.time < c.end ? 'active' : ''}`} role="button" tabIndex={0} onClick={() => void run(() => window.tai.playback('seek', c.start))} onKeyDown={e => { if (e.key === 'Enter') void run(() => window.tai.playback('seek', c.start)); }}><Stack direction="row" sx={{ justifyContent: "space-between" }}><Typography variant="caption" color="primary">{stamp(c.start)} — {stamp(c.end)}</Typography><Typography variant="caption" color={c.ready ? 'success.main' : 'text.secondary'}>{c.ready ? 'Sẵn sàng' : 'Đang chờ'}</Typography></Stack><p>{c.text}</p></Box>)}
            </Box>
          </Paper>
        </Box>
      </>}
      {screen === 'settings' && <Box sx={{ maxWidth: 760, width: '100%', mx: 'auto', overflow: 'auto' }}>
        <Button startIcon={<ArrowBack/>} onClick={() => setScreen(opened ? 'youtube' : 'home')}>Quay lại</Button>
        <Typography variant="h4" sx={{ my: 3 }}>Cấu hình AI worker</Typography>
        <Paper component="form" variant="outlined" sx={{ p: 3 }} onSubmit={e => { e.preventDefault(); setSaving(true); void run(async () => { await window.tai.save(form); setForm({ ...form, apiKey: undefined }); setHasKey((await window.tai.settings()).hasApiKey); setNotice('Đã lưu cấu hình.'); }).finally(() => setSaving(false)); }}>
          <Stack sx={{ gap: 3 }}><TextField label="URL worker" placeholder="https://your-worker.trycloudflare.com" value={form.workerUrl} onChange={e => setForm({ ...form, workerUrl: e.target.value })}/>
          <TextField select label="Ngôn ngữ dịch" value={form.targetLang} onChange={e => setForm({ ...form, targetLang: e.target.value })}>{[['vi', 'Tiếng Việt'], ['en', 'English'], ['ja', '日本語']].map(([v, l]) => <MenuItem key={v} value={v}>{l}</MenuItem>)}</TextField>
          <TextField label="Worker access key" type="password" autoComplete="off" value={form.apiKey || ''} helperText={hasKey ? 'Đã lưu an toàn. Để trống để giữ key hiện tại.' : 'WORKER_API_KEY của worker, không phải Gemini API key.'} onChange={e => setForm({ ...form, apiKey: e.target.value || undefined })}/>
          <Button onClick={() => setForm({ ...form, apiKey: '' })}>Xóa key khi lưu</Button>
          <FormControlLabel control={<Switch checked={form.launchAtLogin} onChange={e => setForm({ ...form, launchAtLogin: e.target.checked })}/>} label="Khởi động cùng Windows"/>
          <Button type="submit" variant="contained" startIcon={<Translate/>} disabled={saving}>Lưu cấu hình</Button>
          {notice && <Alert severity="success">{notice}</Alert>}</Stack>
        </Paper>
        <Paper variant="outlined" sx={{ p: 3, mt: 3 }}><Typography sx={{ fontWeight: 700 }}>Cache trên máy</Typography><Typography variant="body2" sx={{ my: 2, overflowWrap: 'anywhere' }}>{cache}</Typography><Stack direction="row" sx={{ gap: 2 }}><Button startIcon={<FolderOpen/>} onClick={() => void run(() => window.tai.openCache())}>Mở thư mục</Button><Button onClick={() => void run(async () => { const p = await window.tai.chooseAudioDirectory(); if (p) setCache(p); })}>Đổi thư mục</Button></Stack></Paper>
      </Box>}
    </Box>
  </Box>;
}
createRoot(document.getElementById('root')!).render(<ThemeProvider theme={theme}><CssBaseline/><App/></ThemeProvider>);
