import { app, safeStorage } from 'electron';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { loadEnv, getEnvConfig } from './env';
import { DEFAULT_DUBBING_PREFERENCES } from '../shared/voices';
import type { DubbingPreferences, OriginalAudioMode, Settings, SettingsInput, SubtitleDisplayMode } from '../shared/types';

function validateHttpOriginUrl(rawUrl: string, label: string): string {
  const cleaned = rawUrl.trim().replace(/\/+$/, '');
  if (!cleaned) return '';
  const url = new URL(cleaned);
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !localHttp)) {
    throw new Error(`${label} cần HTTPS, hoặc HTTP trên localhost.`);
  }
  return cleaned;
}

export function sanitizeDubbingPreferences(raw?: Partial<DubbingPreferences>): DubbingPreferences {
  const voiceByLang: Record<string, string> = {};
  if (raw?.voiceByLang && typeof raw.voiceByLang === 'object') {
    for (const [k, v] of Object.entries(raw.voiceByLang)) {
      if (typeof k === 'string' && typeof v === 'string' && k.length <= 20 && v.length <= 80) {
        voiceByLang[k] = v;
      }
    }
  }
  const speechRate = Number.isFinite(raw?.speechRate)
    ? Math.min(5, Math.max(0.5, Number(raw!.speechRate)))
    : DEFAULT_DUBBING_PREFERENCES.speechRate;
  const originalAudioMode: OriginalAudioMode =
    raw?.originalAudioMode && ['duck', 'duckAlways', 'keep', 'silence'].includes(raw.originalAudioMode)
      ? raw.originalAudioMode
      : DEFAULT_DUBBING_PREFERENCES.originalAudioMode;
  const duckLevel = Number.isFinite(raw?.duckLevel)
    ? Math.min(90, Math.max(0, Math.round(Number(raw!.duckLevel) / 5) * 5))
    : DEFAULT_DUBBING_PREFERENCES.duckLevel;
  const dubVolume = Number.isFinite(raw?.dubVolume)
    ? Math.min(100, Math.max(0, Math.round(Number(raw!.dubVolume) / 5) * 5))
    : DEFAULT_DUBBING_PREFERENCES.dubVolume;
  const subtitleMode: SubtitleDisplayMode =
    raw?.subtitleMode && ['bilingual', 'translated', 'hidden'].includes(raw.subtitleMode)
      ? raw.subtitleMode
      : DEFAULT_DUBBING_PREFERENCES.subtitleMode;
  const targetLang = typeof raw?.targetLang === 'string' && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(raw.targetLang)
    ? raw.targetLang
    : DEFAULT_DUBBING_PREFERENCES.targetLang;
  const overlayAnchor = raw?.overlayAnchor
    && (raw.overlayAnchor.edge === 'top' || raw.overlayAnchor.edge === 'bottom')
    && Number.isFinite(raw.overlayAnchor.pct)
    ? { edge: raw.overlayAnchor.edge, pct: Math.min(95, Math.max(0, Math.round(raw.overlayAnchor.pct))) }
    : undefined;

  return {
    targetLang,
    voiceByLang,
    speechRate,
    originalAudioMode,
    duckLevel,
    dubVolume,
    subtitleMode,
    ...(overlayAnchor ? { overlayAnchor } : {})
  };
}

export function validateSettings(input: SettingsInput): SettingsInput {
  if (!input || typeof input.workerUrl !== 'string' || typeof input.targetLang !== 'string' || typeof input.launchAtLogin !== 'boolean') {
    throw new Error('Cấu hình không hợp lệ.');
  }
  const workerUrl = validateHttpOriginUrl(input.workerUrl, 'Worker');
  const serverUrl = typeof input.serverUrl === 'string' ? validateHttpOriginUrl(input.serverUrl, 'Server') : '';
  if (!/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(input.targetLang)) throw new Error('Mã ngôn ngữ không hợp lệ.');
  if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 4096 || /[\r\n]/.test(input.apiKey))) {
    throw new Error('API key không hợp lệ.');
  }
  if (input.serverApiKey !== undefined && (typeof input.serverApiKey !== 'string' || input.serverApiKey.length > 4096 || /[\r\n]/.test(input.serverApiKey))) {
    throw new Error('Server API key không hợp lệ.');
  }
  return {
    serverUrl,
    workerUrl,
    targetLang: input.targetLang,
    launchAtLogin: input.launchAtLogin,
    apiKey: input.apiKey,
    serverApiKey: input.serverApiKey,
    dubbing: input.dubbing ? sanitizeDubbingPreferences({ ...input.dubbing, targetLang: input.targetLang }) : undefined
  };
}

export class SettingsStore {
  private value: Settings = {
    serverUrl: '',
    workerUrl: '',
    targetLang: 'vi',
    launchAtLogin: false,
    dubbing: { ...DEFAULT_DUBBING_PREFERENCES }
  };
  private encryptedKey = '';
  private encryptedServerKey = '';
  private audioDirectory = '';
  private saving = false;
  private file = join(app?.getPath ? app.getPath('userData') : process.cwd(), 'settings.json');

  async load() {
    loadEnv();
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      const validated = validateSettings({
        serverUrl: typeof data.serverUrl === 'string' ? data.serverUrl : '',
        workerUrl: typeof data.workerUrl === 'string' ? data.workerUrl : '',
        targetLang: typeof data.targetLang === 'string' ? data.targetLang : 'vi',
        launchAtLogin: Boolean(data.launchAtLogin),
        dubbing: data.dubbing
      });
      delete validated.apiKey;
      delete validated.serverApiKey;
      this.value = {
        ...validated,
        dubbing: sanitizeDubbingPreferences({ ...validated.dubbing, targetLang: validated.targetLang })
      };
      this.encryptedKey = typeof data.encryptedKey === 'string' ? data.encryptedKey : '';
      this.encryptedServerKey = typeof data.encryptedServerKey === 'string' ? data.encryptedServerKey : '';
      if (data.audioDirectory !== undefined && (typeof data.audioDirectory !== 'string' || !isAbsolute(data.audioDirectory))) {
        throw new Error('Thư mục audio không hợp lệ.');
      }
      this.audioDirectory = data.audioDirectory || '';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('Không đọc được settings.json. Hãy kiểm tra file trong thư mục dữ liệu TAI Desktop.');
      }
    }
  }

  publicValue() {
    const env = getEnvConfig();
    return {
      ...this.value,
      serverUrl: env.serverUrl || this.value.serverUrl || '',
      workerUrl: env.workerUrl || this.value.workerUrl,
      hasApiKey: Boolean(env.workerApiKey || this.encryptedKey),
      hasServerApiKey: Boolean(env.serverApiKey || this.encryptedServerKey),
      isServerFromEnv: Boolean(env.serverUrl),
      isServerApiKeyFromEnv: Boolean(env.serverApiKey),
      isWorkerFromEnv: Boolean(env.workerUrl),
      isApiKeyFromEnv: Boolean(env.workerApiKey),
      hasUpdateUrl: Boolean(env.updateUrl),
      dubbing: this.getDubbingPrefs()
    };
  }

  getDubbingPrefs(): DubbingPreferences {
    return sanitizeDubbingPreferences({ ...this.value.dubbing, targetLang: this.value.targetLang });
  }

  getAudioDirectory() {
    return this.audioDirectory || (app?.getPath ? join(app.getPath('userData'), 'audio') : join(process.cwd(), 'audio'));
  }

  async setAudioDirectory(directory: string) {
    if (!isAbsolute(directory)) throw new Error('Cần chọn đường dẫn thư mục tuyệt đối.');
    await this.persist(this.value, this.encryptedKey, this.encryptedServerKey, directory);
  }

  worker() {
    const env = getEnvConfig();
    const workerUrl = env.workerUrl || this.value.workerUrl;
    const apiKey = env.workerApiKey || (this.encryptedKey ? safeStorage.decryptString(Buffer.from(this.encryptedKey, 'base64')) : '');
    return { ...this.value, workerUrl, apiKey };
  }

  server() {
    const env = getEnvConfig();
    const serverUrl = env.serverUrl || this.value.serverUrl || '';
    const apiKey = env.serverApiKey || (this.encryptedServerKey ? safeStorage.decryptString(Buffer.from(this.encryptedServerKey, 'base64')) : '');
    return { serverUrl, apiKey, targetLang: this.value.targetLang };
  }

  async saveDubbingPrefs(partial: Partial<DubbingPreferences>) {
    const merged = sanitizeDubbingPreferences({
      ...this.getDubbingPrefs(),
      ...partial,
      voiceByLang: {
        ...this.getDubbingPrefs().voiceByLang,
        ...(partial.voiceByLang || {})
      }
    });
    const nextValue: Settings = {
      ...this.value,
      targetLang: merged.targetLang,
      dubbing: merged
    };
    await this.persist(nextValue, this.encryptedKey, this.encryptedServerKey, this.audioDirectory);
  }

  async save(input: SettingsInput) {
    const { apiKey, serverApiKey, ...value } = validateSettings(input);
    let encryptedKey = this.encryptedKey;
    let encryptedServerKey = this.encryptedServerKey;
    if (apiKey !== undefined) {
      if (apiKey && !safeStorage.isEncryptionAvailable()) throw new Error('Hệ điều hành chưa hỗ trợ lưu API key an toàn.');
      encryptedKey = apiKey ? safeStorage.encryptString(apiKey).toString('base64') : '';
    }
    if (serverApiKey !== undefined) {
      if (serverApiKey && !safeStorage.isEncryptionAvailable()) throw new Error('Hệ điều hành chưa hỗ trợ lưu Server API key an toàn.');
      encryptedServerKey = serverApiKey ? safeStorage.encryptString(serverApiKey).toString('base64') : '';
    }
    const mergedDubbing = sanitizeDubbingPreferences({
      ...this.getDubbingPrefs(),
      ...(value.dubbing || {}),
      targetLang: value.targetLang
    });
    await this.persist({ ...value, dubbing: mergedDubbing }, encryptedKey, encryptedServerKey, this.audioDirectory);
    if (app?.setLoginItemSettings) {
      app.setLoginItemSettings({ openAtLogin: value.launchAtLogin, args: [] });
    }
  }

  private async persist(value: Settings, encryptedKey: string, encryptedServerKey: string, audioDirectory: string) {
    if (this.saving) throw new Error('Đang lưu cấu hình. Vui lòng thử lại.');
    this.saving = true;
    try {
      await writeFile(
        `${this.file}.tmp`,
        JSON.stringify({
          ...value,
          encryptedKey,
          encryptedServerKey,
          ...(audioDirectory ? { audioDirectory } : {})
        }, null, 2),
        { mode: 0o600 }
      );
      await rename(`${this.file}.tmp`, this.file);
      this.value = value;
      this.encryptedKey = encryptedKey;
      this.encryptedServerKey = encryptedServerKey;
      this.audioDirectory = audioDirectory;
    } finally {
      this.saving = false;
    }
  }
}
