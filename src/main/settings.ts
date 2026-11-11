import { app, safeStorage } from 'electron';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Settings, SettingsInput } from '../shared/types';

export function validateSettings(input: SettingsInput): SettingsInput {
  if (!input || typeof input.workerUrl !== 'string' || typeof input.targetLang !== 'string' || typeof input.launchAtLogin !== 'boolean') throw new Error('Cấu hình không hợp lệ.');
  const workerUrl = input.workerUrl.trim().replace(/\/+$/, '');
  if (workerUrl) {
    const url = new URL(workerUrl);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Worker cần HTTPS, hoặc HTTP trên localhost.');
  }
  if (!/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(input.targetLang)) throw new Error('Mã ngôn ngữ không hợp lệ.');
  if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 4096 || /[\r\n]/.test(input.apiKey))) throw new Error('API key không hợp lệ.');
  return { workerUrl, targetLang: input.targetLang, launchAtLogin: input.launchAtLogin, apiKey: input.apiKey };
}

export class SettingsStore {
  private value: Settings = { workerUrl: '', targetLang: 'vi', launchAtLogin: false };
  private encryptedKey = '';
  private audioDirectory = '';
  private saving = false;
  private file = join(app.getPath('userData'), 'settings.json');
  async load() {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      this.value = validateSettings(data);
      delete (this.value as SettingsInput).apiKey;
      this.encryptedKey = typeof data.encryptedKey === 'string' ? data.encryptedKey : '';
      if (data.audioDirectory !== undefined && (typeof data.audioDirectory !== 'string' || !isAbsolute(data.audioDirectory))) throw new Error('Thư mục audio không hợp lệ.');
      this.audioDirectory = data.audioDirectory || '';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Không đọc được settings.json. Hãy kiểm tra file trong thư mục dữ liệu TAI Desktop.');
    }
  }
  publicValue() { return { ...this.value, hasApiKey: Boolean(this.encryptedKey) }; }
  getAudioDirectory() { return this.audioDirectory || join(app.getPath('userData'), 'audio'); }
  async setAudioDirectory(directory: string) {
    if (!isAbsolute(directory)) throw new Error('Cần chọn đường dẫn thư mục tuyệt đối.');
    await this.persist(this.value, this.encryptedKey, directory);
  }
  worker() {
    return { ...this.value, apiKey: this.encryptedKey ? safeStorage.decryptString(Buffer.from(this.encryptedKey, 'base64')) : '' };
  }
  async save(input: SettingsInput) {
    const { apiKey, ...value } = validateSettings(input);
    let encryptedKey = this.encryptedKey;
    if (apiKey !== undefined) {
      if (apiKey && !safeStorage.isEncryptionAvailable()) throw new Error('Hệ điều hành chưa hỗ trợ lưu API key an toàn.');
      encryptedKey = apiKey ? safeStorage.encryptString(apiKey).toString('base64') : '';
    }
    await this.persist(value, encryptedKey, this.audioDirectory);
    app.setLoginItemSettings({ openAtLogin: value.launchAtLogin, args: [] });
  }
  private async persist(value: Settings, encryptedKey: string, audioDirectory: string) {
    if (this.saving) throw new Error('Đang lưu cấu hình. Vui lòng thử lại.');
    this.saving = true;
    try {
      await writeFile(`${this.file}.tmp`, JSON.stringify({ ...value, encryptedKey, ...(audioDirectory ? { audioDirectory } : {}) }, null, 2), { mode: 0o600 });
      await rename(`${this.file}.tmp`, this.file);
      this.value = value;
      this.encryptedKey = encryptedKey;
      this.audioDirectory = audioDirectory;
    } finally { this.saving = false; }
  }
}
