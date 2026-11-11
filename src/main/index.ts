import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { SettingsStore } from './settings';
import { VoiceoverService } from './voiceover';
import { ensureAudioDirectory } from './storage';
import { YoutubeSession } from './youtube';
import { AppUpdater } from './updater';
import type { SettingsInput } from '../shared/types';

app.setName('TAI Desktop');
let window: BrowserWindow;
let youtube: YoutubeSession;
let service: VoiceoverService;
let updater: AppUpdater;
let quitting = false;
const settings = new SettingsStore();
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting || !service) return;
    event.preventDefault(); quitting = true;
    void Promise.allSettled([youtube?.persistSession(), service.stop()]).then(() => {
      youtube?.close(); app.quit();
    });
  });
  void app.whenReady().then(async () => {
    await settings.load();
    await ensureAudioDirectory(settings.getAudioDirectory());
    service = new VoiceoverService(settings.getAudioDirectory(), () => settings.worker());
    window = new BrowserWindow({ width: 1440, height: 920, minWidth: 1000, minHeight: 680,
      title: 'TAI Desktop', backgroundColor: '#0b1018', autoHideMenuBar: true,
      webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.on('close', event => { if (!quitting) { event.preventDefault(); app.quit(); } });
    window.webContents.on('will-navigate', e => e.preventDefault());
    youtube = new YoutubeSession(window, service);
    updater = new AppUpdater();
    updater.setWindow(window);
    function handle(channel: string, action: (...args: any[]) => unknown) {
      ipcMain.handle(channel, (event, ...args) => {
        if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('IPC sender không hợp lệ.');
        return action(...args);
      });
    }
    handle('tai:navigate', (url: string) => youtube.navigate(url));
    handle('tai:voice', enabled => youtube.view.webContents.setAudioMuted(enabled === true));
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
      await settings.save(input); youtube.reset();
    });
    handle('tai:status', () => ({ running: true, error: '', address: '', cachePath: service.root, activeJobs: service.activeJobs, lastError: service.lastError }));
    handle('tai:open-cache', async () => { const error = await shell.openPath(service.root); if (error) throw new Error(error); });
    handle('tai:choose-audio-directory', async () => {
      if (service.activeJobs) throw new Error('Chờ xử lý xong trước khi đổi thư mục.');
      const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] });
      if (result.canceled) return null;
      await service.changeAudioDirectory(result.filePaths[0], () => settings.setAudioDirectory(result.filePaths[0]));
      youtube.reset(); return service.root;
    });
    handle('tai:check-update', () => updater.checkForUpdates());
    handle('tai:download-update', () => updater.downloadUpdate());
    handle('tai:install-update', () => updater.installUpdate());
    setTimeout(() => { void updater.checkForUpdates(); }, 5000);
    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL);
    else await window.loadFile(join(__dirname, '../renderer/index.html'));
  }).catch(error => { dialog.showErrorBox('Không khởi động được TAI Desktop', error.message); app.quit(); });
}
