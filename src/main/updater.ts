import { app, BrowserWindow } from 'electron';
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater';
import { getEnvConfig } from './env';
import type { UpdateState } from '../shared/types';

export class AppUpdater {
  private state: UpdateState = { phase: 'idle' };
  private window: BrowserWindow | null = null;
  private checking = false;

  constructor() {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    const env = getEnvConfig();
    if (env.updateUrl) {
      try {
        autoUpdater.setFeedURL({
          provider: 'generic',
          url: env.updateUrl
        });
      } catch (e) {
        console.error('Lỗi cấu hình feed URL updater:', e);
      }
    }

    autoUpdater.on('checking-for-update', () => {
      this.updateState({ phase: 'checking', error: '' });
    });

    autoUpdater.on('update-available', (info: UpdateInfo) => {
      this.checking = false;
      this.updateState({
        phase: 'available',
        version: info.version,
        releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
        error: ''
      });
    });

    autoUpdater.on('update-not-available', (info: UpdateInfo) => {
      this.checking = false;
      this.updateState({
        phase: 'not-available',
        version: info.version,
        error: ''
      });
    });

    autoUpdater.on('error', (err: Error) => {
      this.checking = false;
      const msg = !app.isPackaged
        ? 'Chế độ phát triển (Dev): Tự động cập nhật chỉ chạy trên bản cài đặt đóng gói.'
        : (err?.message || 'Lỗi khi kiểm tra cập nhật');
      this.updateState({ phase: 'error', error: msg });
    });

    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      this.updateState({
        phase: 'downloading',
        progress: Math.round(progress.percent),
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total
      });
    });

    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      this.updateState({
        phase: 'downloaded',
        version: info.version,
        progress: 100
      });
    });
  }

  setWindow(win: BrowserWindow) {
    this.window = win;
  }

  getState(): UpdateState {
    return { ...this.state, currentVersion: app.getVersion() };
  }

  private updateState(partial: Partial<UpdateState>) {
    this.state = { ...this.state, ...partial, currentVersion: app.getVersion() };
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send('tai:update-status', this.state);
    }
  }

  async checkForUpdates(): Promise<UpdateState> {
    if (this.checking) return this.getState();
    const env = getEnvConfig();
    if (env.updateUrl) {
      try {
        autoUpdater.setFeedURL({
          provider: 'generic',
          url: env.updateUrl
        });
      } catch (e) {
        console.error('Lỗi cấu hình feed URL updater:', e);
      }
    }
    if (!env.updateUrl) {
      this.updateState({
        phase: 'error',
        error: 'Chưa cấu hình UPDATE_URL trong file .env.'
      });
      return this.getState();
    }
    if (!app.isPackaged) {
      this.updateState({
        phase: 'error',
        error: `Chế độ phát triển (Dev): Đã nhận UPDATE_URL (${env.updateUrl}). Tự động cập nhật chỉ chạy trên bản cài đặt đóng gói (production).`
      });
      return this.getState();
    }
    try {
      this.checking = true;
      this.updateState({ phase: 'checking', error: '' });
      await autoUpdater.checkForUpdates();
    } catch (e) {
      this.checking = false;
      this.updateState({
        phase: 'error',
        error: e instanceof Error ? e.message : String(e)
      });
    }
    return this.getState();
  }

  async downloadUpdate(): Promise<void> {
    if (!app.isPackaged) {
      throw new Error('Chế độ phát triển (Dev) không hỗ trợ tải bản cập nhật.');
    }
    this.updateState({ phase: 'downloading', progress: 0, error: '' });
    await autoUpdater.downloadUpdate();
  }

  installUpdate() {
    autoUpdater.quitAndInstall();
  }
}

