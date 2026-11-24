import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from 'electron';
import { setDefaultResultOrder } from 'node:dns';
import { join } from 'node:path';
import { AuthService } from './auth-service';
import { SettingsStore } from './settings';
import { VoiceoverService } from './voiceover';
import { DubbingClient } from './dubbing-client';
import { ensureAudioDirectory } from './storage';
import { YoutubeSession } from './youtube';
import { AppUpdater } from './updater';
import { DubbingAuthOrQuotaError, encodeBlockError } from '../shared/saas';
import type {
  AuthLoginInput,
  AuthRegisterInput,
  CreatePaymentOrderInput,
  CreateUpgradeRequestInput,
  DubbingPreferences,
  OverlayStatePayload,
  SettingsInput,
  StartDubbingOptions,
  TelemetrySession,
  TtsSynthesizeRequest,
  VideoControlCommand
} from '../shared/types';

// localtest.me resolves to both 127.0.0.1 and ::1. Local Nginx is commonly
// bound only to IPv4, so an IPv6-first lookup makes worker fetches fail before
// they ever reach Nginx. Keep Node/Electron main-process requests deterministic.
setDefaultResultOrder('ipv4first');

app.setName('TAI Desktop');
let window: BrowserWindow;
let youtube: YoutubeSession;
let service: VoiceoverService;
let authService: AuthService;
let dubbingClient: DubbingClient;
let updater: AppUpdater;
let quitting = false;
const settings = new SettingsStore();

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting || !service) return;
    event.preventDefault();
    quitting = true;
    void Promise.allSettled([youtube?.persistSession(), service.stop()]).then(() => {
      youtube?.close();
      app.quit();
    });
  });

  void app.whenReady().then(async () => {
    await settings.load();
    await ensureAudioDirectory(settings.getAudioDirectory());
    service = new VoiceoverService(settings.getAudioDirectory(), () => settings.worker());
    authService = new AuthService(settings);
    dubbingClient = new DubbingClient(() => settings.server(), () => settings.worker(), authService);

    const currentVersion = app.getVersion() || (typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '');
    const iconImage = nativeImage.createFromPath(join(__dirname, '../../build/icon.png'));
    window = new BrowserWindow({
      width: 1440,
      height: 920,
      minWidth: 1000,
      minHeight: 680,
      title: currentVersion ? `TAI Desktop v${currentVersion}` : 'TAI Desktop',
      ...(iconImage.isEmpty() ? {} : { icon: iconImage }),
      backgroundColor: '#0b1018',
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.on('close', event => { if (!quitting) { event.preventDefault(); app.quit(); } });
    window.webContents.on('will-navigate', e => e.preventDefault());

    authService.setWindow(window);
    youtube = new YoutubeSession(
      window,
      service,
      dubbingClient,
      () => settings.getDubbingPrefs().targetLang
    );
    updater = new AppUpdater();
    updater.setWindow(window);

    function handle(channel: string, action: (...args: any[]) => unknown) {
      ipcMain.handle(channel, (event, ...args) => {
        if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
          throw new Error('IPC sender không hợp lệ.');
        }
        return action(...args);
      });
    }

    handle('tai:navigate', (url: string) => youtube.navigate(url));
    handle('tai:voice', (_enabled: boolean) => {
      if (!youtube.view.webContents.isDestroyed()) {
        youtube.view.webContents.setAudioMuted(false);
      }
    });
    handle('tai:bounds', b => youtube.bounds(b));
    handle('tai:playback', (action, time) => youtube.playback(action, time));
    handle('tai:session', () => youtube.state);
    handle('tai:start-translation', id => youtube.startTranslation(id));
    handle('tai:load-subtitles', (id, language, forceRefresh) => youtube.loadSubtitles(id, language, forceRefresh === true));
    handle('tai:retry', () => youtube.retry());
    handle('tai:audio', (id, chunk, language) => service.readAudio(id, chunk, language));
    handle('tai:settings', () => settings.publicValue());
    handle('tai:save', async (input: SettingsInput) => {
      if (service.activeJobs) throw new Error('Chờ xử lý xong trước khi đổi cấu hình.');
      await settings.save(input);
      youtube.reset();
    });
    handle('tai:status', () => ({
      running: true,
      error: '',
      address: '',
      cachePath: service.root,
      activeJobs: service.activeJobs,
      lastError: service.lastError
    }));
    handle('tai:open-cache', async () => {
      const error = await shell.openPath(service.root);
      if (error) throw new Error(error);
    });
    handle('tai:choose-audio-directory', async () => {
      if (service.activeJobs) throw new Error('Chờ xử lý xong trước khi đổi thư mục.');
      const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] });
      if (result.canceled) return null;
      await service.changeAudioDirectory(result.filePaths[0], () => settings.setAudioDirectory(result.filePaths[0]));
      youtube.reset();
      return service.root;
    });
    handle('tai:check-update', () => updater.checkForUpdates());
    handle('tai:download-update', () => updater.downloadUpdate());
    handle('tai:install-update', () => updater.installUpdate());
    handle('tai:app-version', () => app.getVersion() || (typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''));

    // Realtime v2 IPC handlers
    handle('tai:start-dubbing', (videoId: string, options?: StartDubbingOptions) => youtube.startDubbing(videoId, options));
    handle('tai:stop-dubbing', () => youtube.stopDubbing());
    handle('tai:set-transcript-open', (open: boolean) => youtube.setTranscriptOpen(open === true));
    handle('tai:synthesize-tts', async (req: TtsSynthesizeRequest) => {
      try {
        return await dubbingClient.synthesizeTts(req);
      } catch (err) {
        if (err instanceof DubbingAuthOrQuotaError) {
          throw new Error(encodeBlockError(err.code, err.message));
        }
        throw err;
      }
    });
    handle('tai:control-video', (cmd: VideoControlCommand) => youtube.controlVideo(cmd));
    handle('tai:update-overlay', (payload: OverlayStatePayload) => youtube.updateOverlay(payload));
    handle('tai:get-overlay-anchor', () => youtube.getOverlayAnchor());
    handle('tai:report-sessions', (sessions: TelemetrySession[]) => dubbingClient.reportSessions(Array.isArray(sessions) ? sessions : []));
    handle('tai:save-dubbing-prefs', (prefs: Partial<DubbingPreferences>) => settings.saveDubbingPrefs(prefs));
    handle('tai:dubbing-health', () => dubbingClient.health());

    // SaaS Auth & Plans IPC handlers
    handle('tai:auth-state', () => authService.getState());
    handle('tai:auth-login', (input: AuthLoginInput) => authService.login(input));
    handle('tai:auth-register', (input: AuthRegisterInput) => authService.register(input));
    handle('tai:auth-logout', async () => {
      youtube.reset();
      await authService.logout();
    });
    handle('tai:saas-entitlement', () => authService.getEntitlement());
    handle('tai:saas-plans', () => authService.listPublicPlans());
    handle('tai:saas-upgrade-requests', () => authService.listUpgradeRequests());
    handle('tai:saas-create-upgrade-request', (input: CreateUpgradeRequestInput) => authService.createUpgradeRequest(input));
    // SePay Payment IPC handlers
    handle('tai:saas-payment-config', () => authService.getPaymentConfig());
    handle('tai:saas-create-payment-order', (input: CreatePaymentOrderInput) => authService.createPaymentOrder(input));
    handle('tai:saas-payment-orders', () => authService.listPaymentOrders());
    handle('tai:saas-payment-order-status', (paymentCode: string) => authService.getPaymentOrderStatus(paymentCode));
    handle('tai:saas-cancel-payment-order', (paymentCode: string) => authService.cancelPaymentOrder(paymentCode));

    await authService.init().catch(() => {});
    setTimeout(() => { void updater.checkForUpdates(); }, 5000);
    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL);
    else await window.loadFile(join(__dirname, '../renderer/index.html'));
  }).catch(error => {
    dialog.showErrorBox('Không khởi động được TAI Desktop', error.message);
    app.quit();
  });
}
