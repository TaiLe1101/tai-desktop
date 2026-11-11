import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider, createTheme, CssBaseline, Box, Typography, Button, IconButton, Stack, ButtonBase, TextField, LinearProgress, Alert, Switch, FormControlLabel, Paper, Divider, MenuItem, Autocomplete, createFilterOptions, Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions } from '@mui/material';
import YouTube from '@mui/icons-material/YouTube';
import SettingsIcon from '@mui/icons-material/Settings';
import ArrowBack from '@mui/icons-material/ArrowBack';
import Home from '@mui/icons-material/Home';
import ClosedCaption from '@mui/icons-material/ClosedCaption';
import Translate from '@mui/icons-material/Translate';
import FolderOpen from '@mui/icons-material/FolderOpen';
import ChevronLeft from '@mui/icons-material/ChevronLeft';
import ChevronRight from '@mui/icons-material/ChevronRight';
import Refresh from '@mui/icons-material/Refresh';
import SystemUpdate from '@mui/icons-material/SystemUpdate';
import { sourceLanguages, type SourceLanguage, type DesktopApi, type SettingsInput, type VideoSession, type UpdateState } from '../shared/types';
import { VoicePlayer } from './player';
import './style.css';
declare global { interface Window { tai: DesktopApi } }
const theme = createTheme({
  palette: { mode: 'dark', primary: { main: '#98baff' }, background: { default: '#0b1018', paper: '#141c28' } },
  typography: { fontFamily: 'Segoe UI, sans-serif', button: { textTransform: 'none', fontWeight: 600 } },
  shape: { borderRadius: 12 },
  components: {
    MuiButtonBase: { styleOverrides: { root: { cursor: 'default' } } },
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          scrollbarColor: 'rgba(255, 255, 255, 0.2) transparent',
          '&::-webkit-scrollbar, & *::-webkit-scrollbar': { width: 8, height: 8 },
          '&::-webkit-scrollbar-track, & *::-webkit-scrollbar-track': { background: 'transparent' },
          '&::-webkit-scrollbar-thumb, & *::-webkit-scrollbar-thumb': {
            borderRadius: 8,
            backgroundColor: 'rgba(255, 255, 255, 0.18)',
            border: '2px solid transparent',
            backgroundClip: 'padding-box'
          },
          '&::-webkit-scrollbar-thumb:hover, & *::-webkit-scrollbar-thumb:hover': {
            backgroundColor: 'rgba(255, 255, 255, 0.35)'
          },
          '&::-webkit-scrollbar-thumb:active, & *::-webkit-scrollbar-thumb:active': {
            backgroundColor: '#98baff'
          },
          '&::-webkit-scrollbar-button, & *::-webkit-scrollbar-button': {
            display: 'none',
            width: 0,
            height: 0
          },
          '&::-webkit-scrollbar-corner, & *::-webkit-scrollbar-corner': { background: 'transparent' }
        }
      }
    }
  }
});
const labels: Record<VideoSession['phase'], string> = { IDLE: 'Chọn video rồi nhấn Lấy phụ đề.', EXTRACTING: 'Đang lấy phụ đề YouTube…', CAPTIONS_READY: '', BUFFERING: 'Đang chuẩn bị các pack đầu…', PLAYING: 'Đang phát · tiếp tục dịch nền', COMPLETE: 'Đã xử lý toàn bộ video', ERROR: 'Xử lý bị gián đoạn', NO_SUBTITLES: 'Video chưa có phụ đề khả dụng' };
const stamp = (s: number) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
const filterCaptionLanguages = createFilterOptions<{ value: string; label: string }>({
  ignoreAccents: true, ignoreCase: true, trim: true,
  stringify: language => `${language.label} ${language.value}`
});
function App() {
  const [screen, setScreen] = useState<'home' | 'youtube' | 'settings'>('home');
  const [session, setSession] = useState<VideoSession | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [voice, setVoice] = useState(true);
  const [sourceLanguage, setSourceLanguage] = useState<SourceLanguage>('');
  const languageChoice = useRef({ videoId: '', manual: false });
  const [form, setForm] = useState<SettingsInput>({ workerUrl: '', targetLang: 'vi', launchAtLogin: false });
  const [envInfo, setEnvInfo] = useState<{ isWorkerFromEnv: boolean; isApiKeyFromEnv: boolean }>({ isWorkerFromEnv: false, isApiKeyFromEnv: false });
  const [updateState, setUpdateState] = useState<UpdateState>({ phase: 'idle' });
  const [showUpdateDialog, setShowUpdateDialog] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cache, setCache] = useState('');
  const [opened, setOpened] = useState(false);
  const [panelExpanded, setPanelExpanded] = useState(() => localStorage.getItem('tai:captions-expanded') !== 'false');
  const slot = useRef<HTMLDivElement>(null);
  const player = useRef(new VoicePlayer());
  const activeVoice = useRef(false);
  activeVoice.current = voice && screen === 'youtube';
  const run = async (fn: () => Promise<unknown>) => { try { setError(''); await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  useEffect(() => {
    void run(async () => {
      const s = await window.tai.settings();
      setForm({ workerUrl: s.workerUrl, targetLang: s.targetLang, launchAtLogin: s.launchAtLogin });
      setEnvInfo({ isWorkerFromEnv: s.isWorkerFromEnv ?? false, isApiKeyFromEnv: s.isApiKeyFromEnv ?? false });
      setHasKey(s.hasApiKey);
      setCache((await window.tai.status()).cachePath);
    });
    const unsubUpdate = window.tai.onUpdateStatus((state) => {
      setUpdateState(state);
      if (state.phase === 'available') setShowUpdateDialog(true);
    });
    let dead = false, busy = false;
    const tick = async () => {
      if (busy) return; busy = true;
      try { const s = await window.tai.session(); if (!dead) { setSession(s); await player.current.sync(s, activeVoice.current); } }
      catch (e) { if (!dead) setError(String(e)); } finally { busy = false; }
    };
    const timer = setInterval(() => { void tick(); }, 200);
    return () => { dead = true; clearInterval(timer); unsubUpdate(); player.current.stop(); };
  }, []);
  useEffect(() => {
    const id = session?.videoId || '';
    if (languageChoice.current.videoId !== id) {
      languageChoice.current = { videoId: id, manual: false };
      setSourceLanguage('');
    }
    if (languageChoice.current.manual || session?.phase !== 'IDLE') return;
    const detected = session.detectedSourceLanguage || '';
    if (!detected) return;
    const choices = [...sourceLanguages, ...(session.captionLanguages || [])];
    const base = detected.toLowerCase().split('-')[0];
    const selected = choices.find(l => l.value.toLowerCase() === detected.toLowerCase())
      || choices.find(l => l.value.toLowerCase() === base)
      || (base === 'cmn' ? choices.find(l => l.value === 'zh-Hans' || l.value === 'zh') : undefined);
    setSourceLanguage(selected?.value || detected);
  }, [session?.videoId, session?.detectedSourceLanguage, session?.phase]);
  useEffect(() => {
    if (screen !== 'youtube') { player.current.stop(); void window.tai.bounds(null); return; }
    const update = () => { if (slot.current) { const r = slot.current.getBoundingClientRect(); void window.tai.bounds({ x: r.x, y: r.y, width: r.width, height: r.height }); } };
    const observer = new ResizeObserver(update); if (slot.current) observer.observe(slot.current);
    window.addEventListener('resize', update); update();
    return () => { observer.disconnect(); window.removeEventListener('resize', update); void window.tai.bounds(null); };
  }, [screen]);
  async function openYoutube() { setScreen('youtube'); if (!opened) { setOpened(true); await run(() => window.tai.navigate('https://www.youtube.com')); } }
  const percent = session?.total ? Math.round(session.ready / session.total * 100) : 0;
  const captionLanguages = [...sourceLanguages, ...(session?.captionLanguages || []).filter(language => !sourceLanguages.some(defaultLanguage => defaultLanguage.value === language.value))];
  if (sourceLanguage && !captionLanguages.some(language => language.value === sourceLanguage)) {
    let label = sourceLanguage;
    try { label = new Intl.DisplayNames(['vi'], { type: 'language' }).of(sourceLanguage) || sourceLanguage; } catch { }
    captionLanguages.push({ value: sourceLanguage, label });
  }
  return <Box sx={{ height: '100%', display: 'flex' }}>
    <Stack sx={{ width: 88, borderRight: '1px solid #263242', alignItems: 'center', py: 3, gap: 3 }}>
      <Box sx={{ background: '#98baff', color: '#0b1018', p: 1.3, borderRadius: 3, fontWeight: 900, fontSize: 22 }}>T</Box>
      <IconButton aria-label="Trang chủ" onClick={() => setScreen('home')} color={screen === 'home' ? 'primary' : 'default'}><Home /></IconButton>
      <IconButton aria-label="YouTube" onClick={() => void openYoutube()} color={screen === 'youtube' ? 'primary' : 'default'}><YouTube /></IconButton>
      <Box sx={{ flex: 1 }} /><IconButton aria-label="Cấu hình" onClick={() => setScreen('settings')}><SettingsIcon /></IconButton>
      <Typography variant="caption" color="text.secondary">v{updateState.currentVersion}</Typography>
    </Stack>
    <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', p: screen === 'youtube' ? 1 : 3, gap: 2 }}>
      {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}
      {screen === 'youtube' && session?.navigationError && <Alert severity="warning">{session.navigationError}</Alert>}
      {screen === 'home' && <Box aria-label="Nền tảng" sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, 100px)', alignContent: 'start', gap: 2, flex: 1 }}>
        <ButtonBase aria-label="Mở YouTube" onClick={() => void openYoutube()} sx={{ flexDirection: 'column', gap: 1, p: 1.5, borderRadius: 2, alignSelf: 'start', '&:hover': { bgcolor: 'action.hover' }, '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main' } }}>
          <Box sx={{ width: 60, height: 60, borderRadius: 2, bgcolor: '#f53142', display: 'grid', placeItems: 'center', boxShadow: '0 4px 16px #0004' }}><YouTube sx={{ fontSize: 42, color: '#fff' }} /></Box>
          <Typography variant="body2">YouTube</Typography>
        </ButtonBase>
      </Box>}
      {screen === 'youtube' && <>
        <Box sx={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: `minmax(0, 1fr) ${panelExpanded ? 350 : 48}px`, gap: 1 }}>
          <Box ref={slot} className="web-slot" />
          <Paper variant="outlined" sx={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <Stack direction="row" sx={{ alignItems: 'center', gap: 1, p: panelExpanded ? 1.5 : .5 }}>
              {panelExpanded && <><ClosedCaption color="primary" /><Typography sx={{ fontWeight: 700, flex: 1 }}>Phụ đề & tiến trình</Typography></>}
              <IconButton aria-label={panelExpanded ? 'Thu gọn phụ đề' : 'Mở rộng phụ đề'} title={panelExpanded ? 'Thu gọn phụ đề' : 'Mở rộng phụ đề'} aria-expanded={panelExpanded} onClick={() => { const expanded = !panelExpanded; setPanelExpanded(expanded); localStorage.setItem('tai:captions-expanded', String(expanded)); }}>{panelExpanded ? <ChevronRight /> : <ChevronLeft />}</IconButton>
            </Stack>
            {panelExpanded && <>
              <Box sx={{ px: 2, pb: 2 }}>
                <Typography sx={{ fontWeight: 600, mt: 2, mb: 1 }}>{session?.title || 'Chưa chọn video'}</Typography>
                {session?.phase !== 'CAPTIONS_READY' && <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>{session ? labels[session.phase] : 'Đang kết nối…'}</Typography>}
                {session && ['IDLE', 'EXTRACTING', 'CAPTIONS_READY', 'ERROR', 'NO_SUBTITLES'].includes(session.phase) && <Stack sx={{ gap: 1, mb: 2 }}>
                  <Autocomplete
                    fullWidth size="small" openOnFocus autoHighlight
                    options={captionLanguages}
                    value={captionLanguages.find(language => language.value === sourceLanguage) || null}
                    getOptionLabel={language => language.label}
                    isOptionEqualToValue={(option, value) => option.value === value.value}
                    filterOptions={filterCaptionLanguages}
                    disabled={session.phase === 'EXTRACTING'}
                    onChange={(_event, language) => { languageChoice.current = { videoId: session.videoId, manual: true }; setSourceLanguage(language?.value || ''); }}
                    noOptionsText="Không tìm thấy ngôn ngữ"
                    openText="Mở danh sách" closeText="Đóng danh sách"
                    slotProps={{
                      listbox: {
                        sx: {
                          maxHeight: '216px', py: '8px', overflowY: 'auto',
                          '& .MuiAutocomplete-option': { minHeight: '40px', height: '40px', py: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block', lineHeight: '40px' }
                        }
                      }
                    }}
                    renderInput={params => <TextField {...params} label="Dịch tự động YouTube sang" placeholder={session.detectedSourceLanguage ? 'Tìm ngôn ngữ…' : 'Chọn ngôn ngữ khi chưa nhận diện được…'} />}
                  />
                  <Stack direction="row" sx={{ gap: 1 }}>
                    <Button fullWidth variant="outlined" startIcon={<ClosedCaption />} disabled={!session.videoId || !sourceLanguage || session.phase === 'EXTRACTING'} onClick={() => { languageChoice.current = { videoId: session.videoId, manual: true }; void run(() => window.tai.loadSubtitles(session.videoId, sourceLanguage)); }}>{session.phase === 'EXTRACTING' ? 'Đang lấy phụ đề…' : 'Lấy phụ đề'}</Button>
                    {session.phase === 'CAPTIONS_READY' && (
                      <IconButton title="Lấy lại phụ đề mới từ YouTube (bỏ cache cũ)" aria-label="Lấy lại phụ đề mới từ YouTube" color="primary" onClick={() => { languageChoice.current = { videoId: session.videoId, manual: true }; void run(() => window.tai.loadSubtitles(session.videoId, sourceLanguage, true)); }}>
                        <Refresh fontSize="small" />
                      </IconButton>
                    )}
                  </Stack>
                  <Button fullWidth variant="contained" startIcon={<Translate />} disabled={!session.chunks.length || sourceLanguage !== (session.sourceLanguage || 'en') || !['CAPTIONS_READY', 'ERROR'].includes(session.phase)} onClick={() => void run(() => window.tai.startTranslation(session.videoId))}>Dịch</Button>
                </Stack>}
                {session?.phase === 'EXTRACTING' && <LinearProgress sx={{ mb: 2 }} />}
                {session?.phase === 'NO_SUBTITLES' && <Alert severity="info">{session.error || 'YouTube chưa trả phụ đề khả dụng. Bạn có thể bấm Lấy phụ đề để thử lại.'}</Alert>}
                {session?.phase === 'ERROR' && <Alert severity="error">{session.error}</Alert>}
                {session && ['BUFFERING', 'PLAYING', 'COMPLETE'].includes(session.phase) && <>
                  <LinearProgress variant="determinate" value={percent} />
                  <Stack direction="row" sx={{ justifyContent: "space-between", mt: 1 }}><Typography variant="caption">{session?.ready || 0}/{session?.total || 0} pack</Typography><Typography variant="caption">{percent}% {session?.cached ? '· Cache' : ''}</Typography></Stack>
                  <FormControlLabel control={<Switch checked={voice} onChange={e => { setVoice(e.target.checked); if (!e.target.checked) player.current.stop(); }} />} label="Giọng dịch AI" />
                </>}
              </Box><Divider />
              <Box className="subtitle-list">{!session?.chunks.length && <Typography color="text.secondary" variant="body2" sx={{ mt: 3 }}>Nhấn Lấy phụ đề để kiểm tra nội dung và mốc thời gian trước khi dịch.</Typography>}
                {session?.chunks.map(c => <Box key={c.id} className={`cue ${session.time >= c.start && session.time < c.end ? 'active' : ''}`} role="button" tabIndex={0} onClick={() => void run(() => window.tai.playback('seek', c.start))} onKeyDown={e => { if (e.key === 'Enter') void run(() => window.tai.playback('seek', c.start)); }}><Stack direction="row" sx={{ justifyContent: "space-between" }}><Typography variant="caption" color="primary">{stamp(c.start)} — {stamp(c.end)}</Typography><Typography variant="caption" color={c.ready ? 'success.main' : 'text.secondary'}>{c.ready ? 'Sẵn sàng' : session.phase === 'CAPTIONS_READY' ? 'Chưa dịch' : 'Đang chờ'}</Typography></Stack><p>{c.text}</p></Box>)}
              </Box>
            </>}
          </Paper>
        </Box>
      </>}
      {screen === 'settings' && <Box sx={{ maxWidth: 760, width: '100%', mx: 'auto', overflow: 'auto', pb: 4 }}>
        <Button startIcon={<ArrowBack />} onClick={() => setScreen(opened ? 'youtube' : 'home')}>Quay lại</Button>
        <Typography variant="h4" sx={{ my: 3 }}>Cài đặt ứng dụng</Typography>
        <Paper component="form" variant="outlined" sx={{ p: 3 }} onSubmit={e => { e.preventDefault(); setSaving(true); void run(async () => { await window.tai.save(form); setForm({ ...form, apiKey: undefined }); setHasKey((await window.tai.settings()).hasApiKey); setNotice('Đã lưu cấu hình.'); }).finally(() => setSaving(false)); }}>
          <Stack sx={{ gap: 3 }}>
            {envInfo.isWorkerFromEnv ? (
              <Alert severity="info" variant="outlined">
                URL Worker đã được cấu hình từ biến môi trường <strong>.env</strong> (WORKER_URL: {form.workerUrl || 'Đã cấu hình'}).
              </Alert>
            ) : (
              <TextField label="URL worker" placeholder="https://your-worker.trycloudflare.com" value={form.workerUrl} onChange={e => setForm({ ...form, workerUrl: e.target.value })} />
            )}
            <TextField select label="Ngôn ngữ dịch" value={form.targetLang} onChange={e => setForm({ ...form, targetLang: e.target.value })}>{[['vi', 'Tiếng Việt'], ['en', 'English'], ['ja', '日本語']].map(([v, l]) => <MenuItem key={v} value={v}>{l}</MenuItem>)}</TextField>
            {envInfo.isApiKeyFromEnv ? (
              <Alert severity="info" variant="outlined">
                Worker access key đã được cấu hình từ biến môi trường <strong>.env</strong> (WORKER_API_KEY).
              </Alert>
            ) : (
              <>
                <TextField label="Worker access key" type="password" autoComplete="off" value={form.apiKey || ''} helperText={hasKey ? 'Đã lưu an toàn. Để trống để giữ key hiện tại.' : 'WORKER_API_KEY của worker, không phải Gemini API key.'} onChange={e => setForm({ ...form, apiKey: e.target.value || undefined })} />
                <Button onClick={() => setForm({ ...form, apiKey: '' })}>Xóa key khi lưu</Button>
              </>
            )}
            <FormControlLabel control={<Switch checked={form.launchAtLogin} onChange={e => setForm({ ...form, launchAtLogin: e.target.checked })} />} label="Khởi động cùng Windows" />
            <Button type="submit" variant="contained" startIcon={<Translate />} disabled={saving}>Lưu cấu hình</Button>
            {notice && <Alert severity="success">{notice}</Alert>}
          </Stack>
        </Paper>
        <Paper variant="outlined" sx={{ p: 3, mt: 3 }}>
          <Typography sx={{ fontWeight: 700 }}>Cache trên máy</Typography>
          <Typography variant="body2" sx={{ my: 2, overflowWrap: 'anywhere' }}>{cache}</Typography>
          <Stack direction="row" sx={{ gap: 2 }}><Button startIcon={<FolderOpen />} onClick={() => void run(() => window.tai.openCache())}>Mở thư mục</Button><Button onClick={() => void run(async () => { const p = await window.tai.chooseAudioDirectory(); if (p) setCache(p); })}>Đổi thư mục</Button></Stack>
        </Paper>
        <Paper variant="outlined" sx={{ p: 3, mt: 3 }}>
          <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
            <Box>
              <Typography sx={{ fontWeight: 700 }}>Cập nhật ứng dụng</Typography>
              <Typography variant="body2" color="text.secondary">
                Phiên bản hiện tại: v{updateState.currentVersion}
              </Typography>
            </Box>
            <Button
              variant="outlined"
              startIcon={<SystemUpdate />}
              disabled={updateState.phase === 'checking' || updateState.phase === 'downloading'}
              onClick={() => void run(async () => { await window.tai.checkUpdate(); })}
            >
              {updateState.phase === 'checking' ? 'Đang kiểm tra…' : 'Kiểm tra cập nhật'}
            </Button>
          </Stack>
          {updateState.phase === 'checking' && <LinearProgress sx={{ my: 1 }} />}
          {updateState.phase === 'not-available' && (
            <Alert severity="success" sx={{ mt: 1 }}>
              Bạn đang sử dụng phiên bản mới nhất (v{updateState.version || updateState.currentVersion}).
            </Alert>
          )}
          {updateState.phase === 'available' && (
            <Alert
              severity="info"
              sx={{ mt: 1 }}
              action={
                <Button color="primary" size="small" variant="contained" onClick={() => void run(() => window.tai.downloadUpdate())}>
                  Tải và cập nhật
                </Button>
              }
            >
              Đã có phiên bản mới: <strong>v{updateState.version}</strong>!
            </Alert>
          )}
          {updateState.phase === 'downloading' && (
            <Box sx={{ mt: 2 }}>
              <Stack direction="row" sx={{ justifyContent: 'space-between', mb: 1 }}>
                <Typography variant="body2">Đang tải bản cập nhật…</Typography>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>{updateState.progress || 0}%</Typography>
              </Stack>
              <LinearProgress variant="determinate" value={updateState.progress || 0} />
              {updateState.bytesPerSecond ? (
                <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
                  Tốc độ: {((updateState.bytesPerSecond) / 1024 / 1024).toFixed(1)} MB/s
                </Typography>
              ) : null}
            </Box>
          )}
          {updateState.phase === 'downloaded' && (
            <Alert
              severity="success"
              sx={{ mt: 1 }}
              action={
                <Button color="success" size="small" variant="contained" onClick={() => void window.tai.installUpdate()}>
                  Khởi động lại ngay
                </Button>
              }
            >
              Đã tải xong bản cập nhật <strong>v{updateState.version}</strong>!
            </Alert>
          )}
          {updateState.phase === 'error' && (
            <Alert severity="warning" sx={{ mt: 1 }}>
              {updateState.error}
            </Alert>
          )}
        </Paper>
      </Box>}
      <Dialog open={showUpdateDialog} onClose={() => setShowUpdateDialog(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>Có phiên bản mới!</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Đã có phiên bản <strong>v{updateState.version}</strong> trên máy chủ. Bạn có muốn tải về và cập nhật ngay bây giờ không?
          </DialogContentText>
          {updateState.releaseNotes && (
            <Typography variant="caption" sx={{ mt: 1, display: 'block', color: 'text.secondary' }}>
              {updateState.releaseNotes}
            </Typography>
          )}
        </DialogContent>
        <DialogActions sx={{ p: 2, pt: 0 }}>
          <Button onClick={() => setShowUpdateDialog(false)} color="inherit">Để sau</Button>
          <Button variant="contained" onClick={() => { setShowUpdateDialog(false); void run(() => window.tai.downloadUpdate()); }}>
            Cập nhật ngay
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  </Box>;
}
createRoot(document.getElementById('root')!).render(<ThemeProvider theme={theme}><CssBaseline /><App /></ThemeProvider>);
