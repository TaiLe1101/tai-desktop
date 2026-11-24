import ArrowBack from '@mui/icons-material/ArrowBack';
import ChevronLeft from '@mui/icons-material/ChevronLeft';
import ChevronRight from '@mui/icons-material/ChevronRight';
import ClosedCaption from '@mui/icons-material/ClosedCaption';
import FolderOpen from '@mui/icons-material/FolderOpen';
import GraphicEq from '@mui/icons-material/GraphicEq';
import Home from '@mui/icons-material/Home';
import Logout from '@mui/icons-material/Logout';
import Refresh from '@mui/icons-material/Refresh';
import SettingsIcon from '@mui/icons-material/Settings';
import StopCircle from '@mui/icons-material/StopCircle';
import SystemUpdate from '@mui/icons-material/SystemUpdate';
import Translate from '@mui/icons-material/Translate';
import Tune from '@mui/icons-material/Tune';
import WorkspacePremium from '@mui/icons-material/WorkspacePremium';
import YouTube from '@mui/icons-material/YouTube';
import {
  Autocomplete,
  Box,
  Button,
  ButtonBase,
  Chip,
  Collapse,
  createFilterOptions,
  createTheme,
  CssBaseline,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  FormControlLabel,
  IconButton,
  LinearProgress,
  MenuItem,
  Paper,
  Slider,
  Stack,
  Switch,
  TextField,
  ThemeProvider,
  Typography
} from '@mui/material';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  sourceLanguages,
  type AuthState,
  type DesktopApi,
  type DubbingBlockCode,
  type DubbingPreferences,
  type DubbingRuntimeStatus,
  type OriginalAudioMode,
  type QuotaDto,
  type SettingsInput,
  type SourceLanguage,
  type SubtitleDisplayMode,
  type UpdateState,
  type VideoSession
} from '../shared/types';
import {
  computeQuotaPercent,
  formatDubbingBlockMessage,
  formatQuotaLabel,
  formatUiError
} from '../shared/saas';
import {
  DEFAULT_DUBBING_PREFERENCES,
  SPEECH_RATE_OPTIONS,
  TARGET_LANGUAGES,
  getSelectedVoice,
  getVoicesForLang
} from '../shared/voices';
import logoUrl from './assets/logo.png';
import { AuthScreen } from './components/AuthScreen';
import { SplashScreen } from './components/SplashScreen';
import { TitleBar } from './components/TitleBar';
import { ToastProvider, useToast } from './components/ToastProvider';
import { UpgradeModal } from './components/UpgradeModal';
import { VoicePlayer } from './player';
import './style.css';

declare global { interface Window { tai: DesktopApi } }

const MANUAL_SCROLL_PAUSE_MS = 5_000;
const LOADING_HIDE_MS = 1_500;
const SLIDER_DEBOUNCE_MS = 200;

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
          '&::-webkit-scrollbar-button, & *::-webkit-scrollbar-button': { display: 'none', width: 0, height: 0 },
          '&::-webkit-scrollbar-corner, & *::-webkit-scrollbar-corner': { background: 'transparent' }
        }
      }
    }
  }
});

const labels: Record<VideoSession['phase'], string> = {
  IDLE: 'Chọn video rồi nhấn Bật lồng tiếng.',
  EXTRACTING: 'Đang lấy phụ đề YouTube…',
  CAPTIONS_READY: 'Phụ đề sẵn sàng',
  BUFFERING: 'Đang dịch đoạn hiện tại…',
  PLAYING: 'Đang lồng tiếng trực tiếp · tải tiến trình nền',
  COMPLETE: 'Đã sẵn sàng toàn bộ phụ đề',
  ERROR: 'Xử lý bị gián đoạn',
  NO_SUBTITLES: 'Video chưa có phụ đề khả dụng'
};

const stamp = (s: number) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;

const filterCaptionLanguages = createFilterOptions<{ value: string; label: string }>({
  ignoreAccents: true,
  ignoreCase: true,
  trim: true,
  stringify: language => `${language.label} ${language.value}`
});

function App() {
  const { notify } = useToast();
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  const [screen, setScreen] = useState<'home' | 'youtube' | 'settings'>('home');
  const [session, setSession] = useState<VideoSession | null>(null);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [runtimeStatus, setRuntimeStatus] = useState<DubbingRuntimeStatus>('idle');
  const [showLoadingBar, setShowLoadingBar] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);

  const [sourceLanguage, setSourceLanguage] = useState<SourceLanguage>('');
  const languageChoice = useRef({ videoId: '', manual: false });

  const [prefs, setPrefs] = useState<DubbingPreferences>({ ...DEFAULT_DUBBING_PREFERENCES });
  const prefsRef = useRef<DubbingPreferences>(prefs);
  prefsRef.current = prefs;

  const [duckLevelUi, setDuckLevelUi] = useState(DEFAULT_DUBBING_PREFERENCES.duckLevel);
  const [dubVolumeUi, setDubVolumeUi] = useState(DEFAULT_DUBBING_PREFERENCES.dubVolume);
  const duckDebounce = useRef<number | null>(null);
  const dubVolDebounce = useRef<number | null>(null);

  const [authLoaded, setAuthLoaded] = useState(false);
  const [minSplashElapsed, setMinSplashElapsed] = useState(false);
  const [authState, setAuthState] = useState<AuthState>({ authenticated: false, user: null, entitlement: null });
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [isMaximized, setIsMaximized] = useState(true);

  const [form, setForm] = useState<SettingsInput>({ serverUrl: '', workerUrl: '', targetLang: 'vi', launchAtLogin: false });
  const [appVersion, setAppVersion] = useState<string>(() => (typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''));
  const [updateState, setUpdateState] = useState<UpdateState>({ phase: 'idle' });
  const [showUpdateDialog, setShowUpdateDialog] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cache, setCache] = useState('');
  const [opened, setOpened] = useState(false);
  const [panelExpanded, setPanelExpanded] = useState(() => localStorage.getItem('tai:captions-expanded') !== 'false');

  const slot = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const manualScrollUntil = useRef(0);
  const lastActiveCueId = useRef<number | null>(null);
  const loadingTimer = useRef<number | null>(null);
  const lastNotifiedNavError = useRef('');
  const lastNotifiedSessionSignal = useRef('');
  const lastNotifiedBlockKey = useRef('');
  const lastNotifiedUpdateKey = useRef('');

  const showBlockToast = (code: DubbingBlockCode, message: string) => {
    const cleanMsg = formatUiError(message, formatDubbingBlockMessage(code));
    notifyRef.current({
      severity: 'error',
      message: cleanMsg,
      actionLabel: code !== 'AUTH_REQUIRED' ? 'Nâng cấp gói' : undefined,
      onAction: code !== 'AUTH_REQUIRED' ? () => setUpgradeOpen(true) : undefined,
      dedupeKey: `block:${code}:${cleanMsg}`
    });
  };

  const applyLiveQuota = (quota: QuotaDto) => {
    setAuthState(prev => {
      if (!prev.entitlement) return prev;
      return {
        ...prev,
        entitlement: {
          ...prev.entitlement,
          quota
        }
      };
    });
  };

  const player = useRef<VoicePlayer | null>(null);
  if (!player.current) {
    player.current = new VoicePlayer({
      onStatusChange: status => setRuntimeStatus(status),
      onToast: msg => notifyRef.current({ severity: 'warning', message: formatUiError(msg) }),
      onFirstAudioStart: () => setControlsOpen(false),
      onQuotaUpdate: quota => applyLiveQuota(quota),
      onBlocked: (code, message) => showBlockToast(code, message)
    });
  }

  const activeVoice = useRef(false);
  activeVoice.current = voiceEnabled && screen === 'youtube';

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      notifyRef.current({ severity: 'error', message: formatUiError(e) });
    }
  };

  const updatePrefs = (partial: Partial<DubbingPreferences>) => {
    setPrefs(prev => {
      const next: DubbingPreferences = {
        ...prev,
        ...partial,
        voiceByLang: { ...prev.voiceByLang, ...(partial.voiceByLang || {}) }
      };
      prefsRef.current = next;
      void window.tai.saveDubbingPrefs(partial).catch(() => {});
      return next;
    });
  };

  // Auto-hide loading bar 1.5s after entering active playback
  useEffect(() => {
    if (session?.phase === 'EXTRACTING' || session?.phase === 'BUFFERING') {
      setShowLoadingBar(true);
      if (loadingTimer.current) window.clearTimeout(loadingTimer.current);
    } else if (showLoadingBar) {
      if (loadingTimer.current) window.clearTimeout(loadingTimer.current);
      loadingTimer.current = window.setTimeout(() => setShowLoadingBar(false), LOADING_HIDE_MS);
    }
  }, [session?.phase]);

  // Inform main process whether transcript panel is expanded (eager transcript backfill)
  useEffect(() => {
    void window.tai.setTranscriptOpen(panelExpanded).catch(() => {});
  }, [panelExpanded]);

  useEffect(() => {
    void run(async () => {
      const s = await window.tai.settings();
      setForm({
        serverUrl: s.serverUrl || '',
        workerUrl: s.workerUrl,
        targetLang: s.targetLang,
        launchAtLogin: s.launchAtLogin
      });
      if (s.dubbing) {
        const merged: DubbingPreferences = {
          ...DEFAULT_DUBBING_PREFERENCES,
          ...s.dubbing,
          targetLang: s.dubbing.targetLang || s.targetLang || 'vi',
          voiceByLang: { ...(s.dubbing.voiceByLang || {}) }
        };
        setPrefs(merged);
        setDuckLevelUi(merged.duckLevel);
        setDubVolumeUi(merged.dubVolume);
      }
      setCache((await window.tai.status()).cachePath);
      const liveVersion = await window.tai.appVersion().catch(() => '');
      if (liveVersion) setAppVersion(liveVersion);
      const initialAuth = await window.tai.authState().catch(
        (): AuthState => ({ authenticated: false, user: null, entitlement: null })
      );
      setAuthState(initialAuth);
      setAuthLoaded(true);
    });

    const splashTimer = window.setTimeout(() => setMinSplashElapsed(true), 700);
    void window.tai.windowIsMaximized().then(setIsMaximized).catch(() => {});
    const unsubWinState = window.tai.onWindowState(st => setIsMaximized(Boolean(st.isMaximized)));
    const unsubCloseReq = window.tai.onRequestCloseConfirm(() => setCloseDialogOpen(true));

    const unsubAuth = window.tai.onAuthState(nextAuth => {
      setAuthState(nextAuth);
      setAuthLoaded(true);
      if (!nextAuth.authenticated) {
        player.current?.stop();
        setUpgradeOpen(false);
      }
    });

    const unsubUpdate = window.tai.onUpdateStatus(state => {
      setUpdateState(state);
      if (state.phase === 'available') setShowUpdateDialog(true);
    });

    // 100ms responsive session polling driving realtime alignment + ducking
    let dead = false;
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const s = await window.tai.session();
        if (!dead) {
          setSession(s);
          // Persist overlay anchor if user dragged the in-player subtitle box
          if (
            s.overlayAnchor
            && (s.overlayAnchor.edge !== prefsRef.current.overlayAnchor?.edge
              || s.overlayAnchor.pct !== prefsRef.current.overlayAnchor?.pct)
          ) {
            updatePrefs({ overlayAnchor: s.overlayAnchor });
          }
          await player.current?.sync(s, activeVoice.current, prefsRef.current);
        }
      } catch (e) {
        if (!dead) notifyRef.current({ severity: 'error', message: formatUiError(e) });
      } finally {
        busy = false;
      }
    };

    const timer = setInterval(() => { void tick(); }, 100);
    return () => {
      dead = true;
      window.clearTimeout(splashTimer);
      clearInterval(timer);
      unsubWinState();
      unsubCloseReq();
      unsubAuth();
      unsubUpdate();
      player.current?.dispose();
    };
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

  // Deduplicated Snackbar notifications driven by state transitions (never spam on 100ms poll!)
  useEffect(() => {
    if (session?.blockCode) {
      const key = `${session.videoId}|${session.blockCode}|${session.error}`;
      if (lastNotifiedBlockKey.current !== key) {
        lastNotifiedBlockKey.current = key;
        showBlockToast(session.blockCode, session.error || formatDubbingBlockMessage(session.blockCode));
      }
    } else if (session?.dubbingActive && session.phase === 'PLAYING') {
      lastNotifiedBlockKey.current = '';
    }
  }, [session?.videoId, session?.blockCode, session?.error, session?.dubbingActive, session?.phase]);

  useEffect(() => {
    const navErr = screen === 'youtube' ? (session?.navigationError || '') : '';
    if (navErr && navErr !== lastNotifiedNavError.current) {
      lastNotifiedNavError.current = navErr;
      notifyRef.current({ severity: 'warning', message: navErr, dedupeKey: `nav:${navErr}` });
    } else if (!navErr) {
      lastNotifiedNavError.current = '';
    }
  }, [screen, session?.navigationError]);

  useEffect(() => {
    if (!session) return;
    if (session.phase === 'NO_SUBTITLES') {
      const msg = session.error || 'Video không có phụ đề khả dụng.';
      const key = `nosub:${session.videoId}:${msg}`;
      if (lastNotifiedSessionSignal.current !== key) {
        lastNotifiedSessionSignal.current = key;
        notifyRef.current({ severity: 'info', message: msg, dedupeKey: key });
      }
    } else if (session.phase === 'ERROR' && !session.blockCode && session.error) {
      const msg = formatUiError(session.error);
      const key = `err:${session.videoId}:${msg}`;
      if (lastNotifiedSessionSignal.current !== key) {
        lastNotifiedSessionSignal.current = key;
        notifyRef.current({ severity: 'error', message: msg, dedupeKey: key });
      }
    } else if (session.phase === 'PLAYING' || session.phase === 'IDLE') {
      lastNotifiedSessionSignal.current = '';
    }
  }, [session?.videoId, session?.phase, session?.error, session?.blockCode]);

  useEffect(() => {
    const key = `${updateState.phase}|${updateState.version || ''}|${updateState.error || ''}`;
    if (key === lastNotifiedUpdateKey.current) return;
    if (updateState.phase === 'not-available') {
      lastNotifiedUpdateKey.current = key;
      notifyRef.current({
        severity: 'success',
        message: `Bạn đang dùng phiên bản mới nhất (v${updateState.currentVersion || appVersion}).`,
        dedupeKey: key
      });
    } else if (updateState.phase === 'available' && updateState.version) {
      lastNotifiedUpdateKey.current = key;
      notifyRef.current({
        severity: 'info',
        message: `Đã có phiên bản mới v${updateState.version}!`,
        actionLabel: 'Tải và cập nhật',
        onAction: () => void run(() => window.tai.downloadUpdate()),
        dedupeKey: key
      });
    } else if (updateState.phase === 'downloaded' && updateState.version) {
      lastNotifiedUpdateKey.current = key;
      notifyRef.current({
        severity: 'success',
        message: `Đã tải xong bản cập nhật v${updateState.version}!`,
        actionLabel: 'Khởi động lại ngay',
        onAction: () => void window.tai.installUpdate(),
        dedupeKey: key
      });
    } else if (updateState.phase === 'error' && updateState.error) {
      lastNotifiedUpdateKey.current = key;
      notifyRef.current({
        severity: 'warning',
        message: formatUiError(updateState.error),
        dedupeKey: key
      });
    }
  }, [updateState.phase, updateState.version, updateState.error, updateState.currentVersion, appVersion]);

  const splashVisible = !authLoaded || !minSplashElapsed;
  const hideYoutubeView = splashVisible || !authState.authenticated || screen !== 'youtube' || upgradeOpen || showUpdateDialog || closeDialogOpen;

  useEffect(() => {
    if (hideYoutubeView) {
      if (!authState.authenticated || screen !== 'youtube') {
        player.current?.stop();
      }
      void window.tai.bounds(null);
      return;
    }
    const update = () => {
      if (slot.current) {
        const r = slot.current.getBoundingClientRect();
        void window.tai.bounds({ x: r.x, y: r.y, width: r.width, height: r.height });
      }
    };
    const observer = new ResizeObserver(update);
    if (slot.current) observer.observe(slot.current);
    window.addEventListener('resize', update);
    const raf = window.requestAnimationFrame(update);
    return () => {
      window.cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener('resize', update);
      void window.tai.bounds(null);
    };
  }, [hideYoutubeView, authState.authenticated, screen, isMaximized]);

  // Auto-scroll active transcript cue with 5,000ms manual-scroll pause
  const activeCueId = useMemo(() => {
    if (!session?.chunks?.length) return null;
    let found: number | null = null;
    for (const c of session.chunks) {
      if (session.time >= c.start && session.time <= c.end) {
        found = c.id;
      }
    }
    return found;
  }, [session?.chunks, session?.time]);

  useEffect(() => {
    if (activeCueId === null || activeCueId === lastActiveCueId.current) return;
    lastActiveCueId.current = activeCueId;
    if (Date.now() < manualScrollUntil.current) return;
    const el = listRef.current?.querySelector(`[data-cue-id="${activeCueId}"]`) as HTMLElement | null;
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [activeCueId]);

  async function openYoutube() {
    setScreen('youtube');
    if (!opened) {
      setOpened(true);
      await run(() => window.tai.navigate('https://www.youtube.com'));
    }
  }

  const voicesForTarget = useMemo(() => getVoicesForLang(prefs.targetLang), [prefs.targetLang]);
  const selectedVoice = useMemo(
    () => getSelectedVoice(prefs.targetLang, prefs.voiceByLang),
    [prefs.targetLang, prefs.voiceByLang]
  );

  const segmentPercent = session?.totalSegments
    ? Math.round(((session.loadedSegments || 0) / session.totalSegments) * 100)
    : 0;

  const captionLanguages = [
    ...sourceLanguages,
    ...(session?.captionLanguages || []).filter(
      language => !sourceLanguages.some(defaultLanguage => defaultLanguage.value === language.value)
    )
  ];
  if (sourceLanguage && !captionLanguages.some(language => language.value === sourceLanguage)) {
    let label = sourceLanguage;
    try { label = new Intl.DisplayNames(['vi'], { type: 'language' }).of(sourceLanguage) || sourceLanguage; } catch {}
    captionLanguages.push({ value: sourceLanguage, label });
  }

  const isDubbingRunning = Boolean(session?.dubbingActive);
  const currentVersion = updateState.currentVersion || appVersion;
  const userDisplayName = authState.user
    ? (`${authState.user.lastName || ''} ${authState.user.firstName || ''}`.trim() || authState.user.username)
    : '';
  const entitlement = authState.entitlement;
  const quota = entitlement?.quota ?? null;
  const quotaPct = computeQuotaPercent(quota);
  const quotaLabel = formatQuotaLabel(quota);

  useEffect(() => {
    document.title = currentVersion ? `TAI Desktop v${currentVersion}` : 'TAI Desktop';
  }, [currentVersion]);

  const handleLogout = async () => {
    player.current?.stop();
    await run(() => window.tai.authLogout());
    setAuthState({ authenticated: false, user: null, entitlement: null });
    setScreen('home');
    setOpened(false);
    lastNotifiedBlockKey.current = '';
  };

  const closeConfirmDialog = (
    <Dialog open={closeDialogOpen} onClose={() => setCloseDialogOpen(false)} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontWeight: 700 }}>Xác nhận thoát</DialogTitle>
      <DialogContent>
        <DialogContentText>
          Bạn có chắc chắn muốn thoát TAI Desktop không?
        </DialogContentText>
      </DialogContent>
      <DialogActions sx={{ p: 2, pt: 0 }}>
        <Button onClick={() => setCloseDialogOpen(false)} color="inherit">Hủy</Button>
        <Button
          variant="contained"
          color="error"
          onClick={() => {
            setCloseDialogOpen(false);
            player.current?.stop();
            void window.tai.windowConfirmClose();
          }}
        >
          Thoát ứng dụng
        </Button>
      </DialogActions>
    </Dialog>
  );

  if (splashVisible) {
    return (
      <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <TitleBar currentVersion={currentVersion} isMaximized={isMaximized} onRequestClose={() => setCloseDialogOpen(true)} />
        <SplashScreen currentVersion={currentVersion} />
        {closeConfirmDialog}
      </Box>
    );
  }

  if (!authState.authenticated) {
    return (
      <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <TitleBar currentVersion={currentVersion} isMaximized={isMaximized} onRequestClose={() => setCloseDialogOpen(true)} />
        <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <AuthScreen
            currentVersion={currentVersion}
            initialNotice={
              authState.reason === 'SESSION_EXPIRED' || authState.reason === 'AUTH_REQUIRED'
                ? 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại để tiếp tục.'
                : undefined
            }
            onAuthenticated={next => {
              setAuthState(next);
              lastNotifiedBlockKey.current = '';
            }}
          />
        </Box>
        {closeConfirmDialog}
      </Box>
    );
  }

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <TitleBar currentVersion={currentVersion} isMaximized={isMaximized} onRequestClose={() => setCloseDialogOpen(true)} />
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <Stack sx={{ width: 88, borderRight: '1px solid #263242', alignItems: 'center', py: 3, gap: 3 }}>
        <ButtonBase
          aria-label="TAI Desktop"
          title={currentVersion ? `TAI Desktop v${currentVersion}` : 'TAI Desktop'}
          onClick={() => setScreen('home')}
          sx={{
            width: 54,
            height: 54,
            borderRadius: 3,
            overflow: 'hidden',
            border: '1px solid rgba(152, 186, 255, 0.28)',
            boxShadow: '0 4px 14px rgba(0, 0, 0, 0.45)',
            transition: 'transform 0.15s ease, border-color 0.15s ease',
            '&:hover': { transform: 'scale(1.04)', borderColor: '#98baff' }
          }}
        >
          <Box component="img" src={logoUrl} alt="TAI Desktop logo" sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        </ButtonBase>
        <IconButton aria-label="Trang chủ" onClick={() => setScreen('home')} color={screen === 'home' ? 'primary' : 'default'}><Home /></IconButton>
        <IconButton aria-label="YouTube" onClick={() => void openYoutube()} color={screen === 'youtube' ? 'primary' : 'default'}><YouTube /></IconButton>
        <Box sx={{ flex: 1 }} />
        <IconButton aria-label="Cấu hình" onClick={() => setScreen('settings')} color={screen === 'settings' ? 'primary' : 'default'}><SettingsIcon /></IconButton>
        <Typography variant="caption" color="text.secondary">{currentVersion ? `v${currentVersion}` : ''}</Typography>
      </Stack>

      <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', p: screen === 'youtube' ? 1 : 3, gap: 1.5 }}>
        {/* Authenticated Top Account & Quota Strip */}
        <Paper
          variant="outlined"
          sx={{
            px: 1.5,
            py: 0.9,
            display: 'flex',
            alignItems: 'center',
            gap: 1.5,
            flexWrap: 'wrap',
            bgcolor: 'rgba(20, 28, 40, 0.9)',
            borderColor: '#263242'
          }}
        >
          <Stack direction="row" sx={{ alignItems: 'center', gap: 1, minWidth: 0 }}>
            <Typography variant="body2" sx={{ fontWeight: 700 }} noWrap>{userDisplayName}</Typography>
            {entitlement?.tenant?.name && (
              <Typography variant="caption" color="text.secondary" noWrap>· {entitlement.tenant.name}</Typography>
            )}
            <Chip
              size="small"
              label={entitlement?.plan?.name || 'Chưa có gói'}
              color={entitlement?.plan?.priceMonthly ? 'primary' : 'default'}
              variant="outlined"
              sx={{ height: 22, fontWeight: 600 }}
            />
          </Stack>

          <Stack sx={{ flex: 1, minWidth: 160, maxWidth: 320, gap: 0.4 }}>
            <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <Typography variant="caption" color="text.secondary">Hạn mức tháng này</Typography>
              <Typography variant="caption" sx={{ fontWeight: 600, color: quota?.canDub === false ? 'error.main' : 'text.primary' }}>
                {quotaLabel}
              </Typography>
            </Stack>
            <LinearProgress
              variant="determinate"
              value={quota?.isUnlimited ? 0 : quotaPct}
              color={quotaPct >= 90 || quota?.canDub === false ? 'error' : quotaPct >= 75 ? 'warning' : 'primary'}
              sx={{ height: 5, borderRadius: 3 }}
            />
          </Stack>

          <Box sx={{ flex: 1 }} />

          <Stack direction="row" sx={{ gap: 1, alignItems: 'center' }}>
            <Button
              size="small"
              variant="contained"
              startIcon={<WorkspacePremium fontSize="small" />}
              onClick={() => setUpgradeOpen(true)}
            >
              Nâng cấp
            </Button>
          </Stack>
        </Paper>

        {screen === 'home' && (
          <Box aria-label="Nền tảng" sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, 100px)', alignContent: 'start', gap: 2, flex: 1 }}>
            <ButtonBase
              aria-label="Mở YouTube"
              onClick={() => void openYoutube()}
              sx={{
                flexDirection: 'column', gap: 1, p: 1.5, borderRadius: 2, alignSelf: 'start',
                '&:hover': { bgcolor: 'action.hover' },
                '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main' }
              }}
            >
              <Box sx={{ width: 60, height: 60, borderRadius: 2, bgcolor: '#f53142', display: 'grid', placeItems: 'center', boxShadow: '0 4px 16px #0004' }}>
                <YouTube sx={{ fontSize: 42, color: '#fff' }} />
              </Box>
              <Typography variant="body2">YouTube</Typography>
            </ButtonBase>
          </Box>
        )}

        {screen === 'youtube' && (
          <Box sx={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: `minmax(0, 1fr) ${panelExpanded ? 370 : 48}px`, gap: 1 }}>
            <Box ref={slot} className="web-slot" />
            <Paper variant="outlined" sx={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <Stack direction="row" sx={{ alignItems: 'center', gap: 1, p: panelExpanded ? 1.5 : 0.5 }}>
                {panelExpanded && (
                  <>
                    <ClosedCaption color="primary" />
                    <Typography sx={{ fontWeight: 700, flex: 1, fontSize: 15 }}>Lồng tiếng trực tiếp</Typography>
                    {runtimeStatus === 'preparing' || runtimeStatus === 'buffering' ? (
                      <span className="status-dots" title="Đang chuẩn bị"><span /><span /><span /></span>
                    ) : runtimeStatus === 'speaking' ? (
                      <span className="status-bars" title="Đang đọc"><span /><span /><span /></span>
                    ) : null}
                    <IconButton
                      size="small"
                      aria-label="Tùy chỉnh giọng đọc"
                      title="Tùy chỉnh giọng đọc & âm thanh"
                      color={controlsOpen ? 'primary' : 'default'}
                      onClick={() => setControlsOpen(v => !v)}
                    >
                      <Tune fontSize="small" />
                    </IconButton>
                  </>
                )}
                <IconButton
                  aria-label={panelExpanded ? 'Thu gọn phụ đề' : 'Mở rộng phụ đề'}
                  title={panelExpanded ? 'Thu gọn phụ đề' : 'Mở rộng phụ đề'}
                  aria-expanded={panelExpanded}
                  onClick={() => {
                    const expanded = !panelExpanded;
                    setPanelExpanded(expanded);
                    localStorage.setItem('tai:captions-expanded', String(expanded));
                  }}
                >
                  {panelExpanded ? <ChevronRight /> : <ChevronLeft />}
                </IconButton>
              </Stack>

              {panelExpanded && (
                <>
                  <Box sx={{ px: 2, pb: 1.5 }}>
                    <Typography sx={{ fontWeight: 600, mb: 0.5, fontSize: 14 }} noWrap title={session?.title || ''}>
                      {session?.title || 'Chưa chọn video'}
                    </Typography>

                    <Stack direction="row" sx={{ alignItems: 'center', gap: 1, mb: 1.2, flexWrap: 'wrap' }}>
                      <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
                        {session ? labels[session.phase] : 'Đang kết nối…'}
                      </Typography>
                      {session?.translationSource && (
                        <Chip
                          size="small"
                          label={session.translationSource === 'youtube' ? 'Fast Path' : session.translationSource === 'ai' ? 'AI Stream' : 'Direct Worker'}
                          color={session.translationSource === 'youtube' ? 'success' : 'primary'}
                          variant="outlined"
                          sx={{ height: 20, fontSize: 11 }}
                        />
                      )}
                    </Stack>

                    {/* Primary Start / Stop + Refresh + Source Lang */}
                    <Stack sx={{ gap: 1, mb: 1 }}>
                      <Stack direction="row" sx={{ gap: 1 }}>
                        {!isDubbingRunning ? (
                          <Button
                            fullWidth
                            variant="contained"
                            startIcon={<GraphicEq />}
                            disabled={!session?.videoId || session.phase === 'EXTRACTING'}
                            onClick={() => {
                              if (!session?.videoId) return;
                              languageChoice.current = { videoId: session.videoId, manual: true };
                              void run(() => window.tai.startDubbing(session.videoId, {
                                targetLang: prefs.targetLang,
                                sourceLang: sourceLanguage || undefined,
                                transcriptOpen: panelExpanded
                              }));
                            }}
                          >
                            {session?.phase === 'EXTRACTING' ? 'Đang khởi tạo…' : 'Bật lồng tiếng'}
                          </Button>
                        ) : (
                          <Button
                            fullWidth
                            variant="outlined"
                            color="warning"
                            startIcon={<StopCircle />}
                            onClick={() => {
                              player.current?.stop();
                              void run(() => window.tai.stopDubbing());
                            }}
                          >
                            Dừng lồng tiếng
                          </Button>
                        )}
                        <IconButton
                          title="Tải lại phụ đề mới (bỏ cache cũ)"
                          aria-label="Tải lại phụ đề mới"
                          color="primary"
                          disabled={!session?.videoId || session.phase === 'EXTRACTING'}
                          onClick={() => {
                            if (!session?.videoId) return;
                            player.current?.stop();
                            void run(() => window.tai.startDubbing(session.videoId, {
                              targetLang: prefs.targetLang,
                              sourceLang: sourceLanguage || undefined,
                              forceRefresh: true,
                              transcriptOpen: panelExpanded
                            }));
                          }}
                        >
                          <Refresh fontSize="small" />
                        </IconButton>
                      </Stack>

                      {isDubbingRunning && (
                        <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                          <FormControlLabel
                            sx={{ m: 0 }}
                            control={
                              <Switch
                                size="small"
                                checked={voiceEnabled}
                                onChange={e => {
                                  setVoiceEnabled(e.target.checked);
                                  if (!e.target.checked) player.current?.interruptSpeech();
                                }}
                              />
                            }
                            label={<Typography variant="caption">Giọng dịch AI</Typography>}
                          />
                          {session?.totalSegments ? (
                            <Typography variant="caption" color="text.secondary">
                              {session.loadedSegments || 0}/{session.totalSegments} đoạn ({segmentPercent}%)
                            </Typography>
                          ) : null}
                        </Stack>
                      )}
                    </Stack>

                    {showLoadingBar && (
                      <LinearProgress
                        variant={session?.totalSegments ? 'determinate' : 'indeterminate'}
                        value={segmentPercent}
                        sx={{ mb: 1, borderRadius: 2 }}
                      />
                    )}

                    {/* Collapsible Dubbing Controls (auto-closes on first audio start) */}
                    <Collapse in={controlsOpen}>
                      <Stack sx={{ gap: 1.2, p: 1.2, mt: 0.5, mb: 1, borderRadius: 2, bgcolor: 'rgba(255,255,255,0.03)', border: '1px solid #263242' }}>
                        <Autocomplete
                          fullWidth
                          size="small"
                          openOnFocus
                          autoHighlight
                          options={captionLanguages}
                          value={captionLanguages.find(l => l.value === sourceLanguage) || null}
                          getOptionLabel={l => l.label}
                          isOptionEqualToValue={(o, v) => o.value === v.value}
                          filterOptions={filterCaptionLanguages}
                          onChange={(_e, lang) => {
                            languageChoice.current = { videoId: session?.videoId || '', manual: true };
                            setSourceLanguage(lang?.value || '');
                          }}
                          renderInput={params => <TextField {...params} label="Ngôn ngữ nguồn (tự nhận diện)" />}
                        />

                        <TextField
                          select
                          size="small"
                          label="Ngôn ngữ đích"
                          value={prefs.targetLang}
                          onChange={e => updatePrefs({ targetLang: e.target.value })}
                        >
                          {TARGET_LANGUAGES.map(lang => (
                            <MenuItem key={lang.code} value={lang.code}>
                              {lang.nativeLabel} ({lang.code})
                            </MenuItem>
                          ))}
                        </TextField>

                        <TextField
                          select
                          size="small"
                          label="Giọng đọc Neural"
                          value={selectedVoice}
                          onChange={e => updatePrefs({
                            voiceByLang: { ...prefs.voiceByLang, [prefs.targetLang]: e.target.value }
                          })}
                        >
                          {voicesForTarget.map(v => (
                            <MenuItem key={v.id} value={v.id}>{v.name}</MenuItem>
                          ))}
                        </TextField>

                        <Stack direction="row" sx={{ gap: 1 }}>
                          <TextField
                            select
                            fullWidth
                            size="small"
                            label="Tốc độ đọc"
                            value={prefs.speechRate}
                            onChange={e => updatePrefs({ speechRate: Number(e.target.value) })}
                          >
                            {SPEECH_RATE_OPTIONS.map(r => (
                              <MenuItem key={r} value={r}>{r}x</MenuItem>
                            ))}
                          </TextField>

                          <TextField
                            select
                            fullWidth
                            size="small"
                            label="Phụ đề trên video"
                            value={prefs.subtitleMode}
                            onChange={e => updatePrefs({ subtitleMode: e.target.value as SubtitleDisplayMode })}
                          >
                            <MenuItem value="bilingual">Song ngữ</MenuItem>
                            <MenuItem value="translated">Chỉ bản dịch</MenuItem>
                            <MenuItem value="hidden">Ẩn</MenuItem>
                          </TextField>
                        </Stack>

                        <TextField
                          select
                          size="small"
                          label="Âm thanh gốc YouTube"
                          value={prefs.originalAudioMode}
                          onChange={e => updatePrefs({ originalAudioMode: e.target.value as OriginalAudioMode })}
                        >
                          <MenuItem value="duck">Hạ nhỏ khi đang đọc (Duck)</MenuItem>
                          <MenuItem value="duckAlways">Luôn hạ nhỏ (Duck Always)</MenuItem>
                          <MenuItem value="keep">Giữ nguyên (Keep)</MenuItem>
                          <MenuItem value="silence">Tắt hoàn toàn (Silence)</MenuItem>
                        </TextField>

                        <Box>
                          <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                            <Typography variant="caption" color="text.secondary">Mức hạ âm thanh gốc</Typography>
                            <Typography variant="caption">{duckLevelUi}%</Typography>
                          </Stack>
                          <Slider
                            size="small"
                            min={0}
                            max={90}
                            step={5}
                            value={duckLevelUi}
                            onChange={(_e, val) => {
                              const next = Number(val);
                              setDuckLevelUi(next);
                              if (duckDebounce.current) window.clearTimeout(duckDebounce.current);
                              duckDebounce.current = window.setTimeout(() => updatePrefs({ duckLevel: next }), SLIDER_DEBOUNCE_MS);
                            }}
                          />
                        </Box>

                        <Box>
                          <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                            <Typography variant="caption" color="text.secondary">Âm lượng giọng dịch</Typography>
                            <Typography variant="caption">{dubVolumeUi}%</Typography>
                          </Stack>
                          <Slider
                            size="small"
                            min={0}
                            max={100}
                            step={5}
                            value={dubVolumeUi}
                            onChange={(_e, val) => {
                              const next = Number(val);
                              setDubVolumeUi(next);
                              player.current?.applyDubVolumeLive(next);
                              if (dubVolDebounce.current) window.clearTimeout(dubVolDebounce.current);
                              dubVolDebounce.current = window.setTimeout(() => updatePrefs({ dubVolume: next }), SLIDER_DEBOUNCE_MS);
                            }}
                          />
                        </Box>
                      </Stack>
                    </Collapse>
                  </Box>

                  <Divider />

                  {/* Bilingual Transcript List with 5s manual-scroll override */}
                  <Box
                    ref={listRef}
                    className="subtitle-list"
                    onWheel={() => { manualScrollUntil.current = Date.now() + MANUAL_SCROLL_PAUSE_MS; }}
                    onTouchMove={() => { manualScrollUntil.current = Date.now() + MANUAL_SCROLL_PAUSE_MS; }}
                    onPointerDown={() => { manualScrollUntil.current = Date.now() + MANUAL_SCROLL_PAUSE_MS; }}
                  >
                    {!session?.chunks?.length && (
                      <Typography color="text.secondary" variant="body2" sx={{ mt: 2 }}>
                        Nhấn <strong>Bật lồng tiếng</strong> để dịch và lồng tiếng ngay theo vị trí phát hiện tại.
                      </Typography>
                    )}
                    {session?.chunks?.map(c => {
                      const isActive = activeCueId === c.id;
                      const showSource = Boolean(
                        c.sourceText
                        && c.sourceText.trim().toLowerCase() !== c.text.trim().toLowerCase()
                      );
                      return (
                        <Box
                          key={c.id}
                          data-cue-id={c.id}
                          className={`cue ${isActive ? 'active' : ''}`}
                          role="button"
                          tabIndex={0}
                          onClick={() => void run(() => window.tai.playback('seek', c.start))}
                          onKeyDown={e => { if (e.key === 'Enter') void run(() => window.tai.playback('seek', c.start)); }}
                        >
                          <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                            <Typography variant="caption" color="primary">{stamp(c.start)} — {stamp(c.end)}</Typography>
                          </Stack>
                          <p className="cue-translated">{c.text}</p>
                          {showSource && <p className="cue-source">{c.sourceText}</p>}
                        </Box>
                      );
                    })}
                  </Box>
                </>
              )}
            </Paper>
          </Box>
        )}

        {screen === 'settings' && (
          <Box sx={{ maxWidth: 760, width: '100%', mx: 'auto', overflow: 'auto', pb: 4 }}>
            <Button startIcon={<ArrowBack />} onClick={() => setScreen(opened ? 'youtube' : 'home')}>Quay lại</Button>
            <Stack direction="row" sx={{ alignItems: 'center', gap: 2, my: 3 }}>
              <Box
                component="img"
                src={logoUrl}
                alt="TAI Desktop logo"
                sx={{ width: 48, height: 48, borderRadius: 2.5, objectFit: 'cover', border: '1px solid rgba(152, 186, 255, 0.28)' }}
              />
              <Box>
                <Typography variant="h4" sx={{ lineHeight: 1.15 }}>Cài đặt ứng dụng</Typography>
                {currentVersion && (
                  <Typography variant="caption" color="text.secondary">TAI Desktop v{currentVersion}</Typography>
                )}
              </Box>
            </Stack>

            <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
              <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1.5, mb: 2 }}>
                <Box>
                  <Typography sx={{ fontWeight: 700 }}>Tài khoản &amp; Gói dịch vụ</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {userDisplayName} ({authState.user?.email || authState.user?.username})
                    {entitlement?.tenant?.name ? ` · ${entitlement.tenant.name}` : ''}
                  </Typography>
                </Box>
                <Chip
                  label={entitlement?.plan?.name || 'Chưa có gói'}
                  color={entitlement?.plan?.priceMonthly ? 'primary' : 'default'}
                  variant="outlined"
                />
              </Stack>
              <Stack sx={{ gap: 1, mb: 2 }}>
                <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                  <Typography variant="body2" color="text.secondary">Hạn mức lồng tiếng ({quota?.period || 'tháng này'})</Typography>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>{quotaLabel}</Typography>
                </Stack>
                <LinearProgress
                  variant="determinate"
                  value={quota?.isUnlimited ? 0 : quotaPct}
                  color={quotaPct >= 90 || quota?.canDub === false ? 'error' : 'primary'}
                  sx={{ height: 6, borderRadius: 3 }}
                />
                {entitlement?.subscription?.expiresAt && (
                  <Typography variant="caption" color="text.secondary">
                    Hết hạn: {new Date(entitlement.subscription.expiresAt).toLocaleDateString('vi-VN')}
                  </Typography>
                )}
              </Stack>
              <Stack direction="row" sx={{ gap: 1.5, flexWrap: 'wrap' }}>
                <Button variant="contained" startIcon={<WorkspacePremium />} onClick={() => setUpgradeOpen(true)}>
                  Nâng cấp gói
                </Button>
                <Button
                  variant="outlined"
                  startIcon={<Refresh />}
                  onClick={() => void run(async () => { await window.tai.refreshEntitlement(); })}
                >
                  Làm mới hạn mức
                </Button>
                <Button variant="outlined" color="inherit" startIcon={<Logout />} onClick={() => void handleLogout()}>
                  Đăng xuất
                </Button>
              </Stack>
            </Paper>

            <Paper
              component="form"
              variant="outlined"
              sx={{ p: 3 }}
              onSubmit={e => {
                e.preventDefault();
                setSaving(true);
                void run(async () => {
                  await window.tai.save({
                    ...form,
                    dubbing: { ...prefs, targetLang: form.targetLang }
                  });
                  setPrefs(prev => ({ ...prev, targetLang: form.targetLang }));
                  notify({ severity: 'success', message: 'Đã lưu cấu hình.' });
                }).finally(() => setSaving(false));
              }}
            >
              <Stack sx={{ gap: 2.5 }}>
                <TextField
                  select
                  label="Ngôn ngữ dịch mặc định"
                  value={form.targetLang}
                  onChange={e => setForm({ ...form, targetLang: e.target.value })}
                >
                  {TARGET_LANGUAGES.map(lang => (
                    <MenuItem key={lang.code} value={lang.code}>
                      {lang.nativeLabel} — {lang.label} ({lang.code})
                    </MenuItem>
                  ))}
                </TextField>
                <FormControlLabel
                  control={<Switch checked={form.launchAtLogin} onChange={e => setForm({ ...form, launchAtLogin: e.target.checked })} />}
                  label="Khởi động cùng Windows"
                />
                <Button type="submit" variant="contained" startIcon={<Translate />} disabled={saving}>Lưu cấu hình</Button>
              </Stack>
            </Paper>

            <Paper variant="outlined" sx={{ p: 3, mt: 3 }}>
              <Typography sx={{ fontWeight: 700 }}>Cache trên máy</Typography>
              <Typography variant="body2" sx={{ my: 2, overflowWrap: 'anywhere' }}>{cache}</Typography>
              <Stack direction="row" sx={{ gap: 2 }}>
                <Button startIcon={<FolderOpen />} onClick={() => void run(() => window.tai.openCache())}>Mở thư mục</Button>
                <Button onClick={() => void run(async () => { const p = await window.tai.chooseAudioDirectory(); if (p) setCache(p); })}>Đổi thư mục</Button>
              </Stack>
            </Paper>

            <Paper variant="outlined" sx={{ p: 3, mt: 3 }}>
              <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
                <Box>
                  <Typography sx={{ fontWeight: 700 }}>Cập nhật ứng dụng</Typography>
                  <Typography variant="body2" color="text.secondary">
                    Phiên bản hiện tại: {currentVersion ? `v${currentVersion}` : 'Đang xác định…'}
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
              {updateState.phase === 'available' && (
                <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mt: 1.5, gap: 1 }}>
                  <Typography variant="body2" color="primary.main">
                    Đã có phiên bản mới: <strong>v{updateState.version}</strong>
                  </Typography>
                  <Button color="primary" size="small" variant="contained" onClick={() => void run(() => window.tai.downloadUpdate())}>
                    Tải và cập nhật
                  </Button>
                </Stack>
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
                      Tốc độ: {(updateState.bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s
                    </Typography>
                  ) : null}
                </Box>
              )}
              {updateState.phase === 'downloaded' && (
                <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mt: 1.5, gap: 1 }}>
                  <Typography variant="body2" color="success.main">
                    Đã tải xong bản cập nhật <strong>v{updateState.version}</strong>!
                  </Typography>
                  <Button color="success" size="small" variant="contained" onClick={() => void window.tai.installUpdate()}>
                    Khởi động lại ngay
                  </Button>
                </Stack>
              )}
            </Paper>
          </Box>
        )}

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

        <UpgradeModal
          open={upgradeOpen}
          entitlement={entitlement}
          onClose={() => setUpgradeOpen(false)}
          onSubmitted={() => void window.tai.refreshEntitlement().catch(() => {})}
          onPaid={() => {
            lastNotifiedBlockKey.current = '';
            void window.tai.refreshEntitlement().catch(() => {});
          }}
        />
        {closeConfirmDialog}
      </Box>
      </Box>
    </Box>
  );
}

createRoot(document.getElementById('root')!).render(
  <ThemeProvider theme={theme}>
    <CssBaseline />
    <ToastProvider>
      <App />
    </ToastProvider>
  </ThemeProvider>
);
