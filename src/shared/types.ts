export interface SubtitleSegment { start: number; end: number; text: string }
// Language of the caption text received from YouTube Auto-translate.
export type SourceLanguage = string;
export function isCaptionLanguage(value: unknown): value is SourceLanguage {
  return typeof value === 'string' && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value);
}
export const sourceLanguages: { value: SourceLanguage; label: string }[] = [
  { value: 'en', label: 'Tiếng Anh' }, { value: 'zh', label: 'Tiếng Trung' },
  { value: 'ja', label: 'Tiếng Nhật' }, { value: 'ko', label: 'Tiếng Hàn' }
];
export interface Settings {
  workerUrl: string;
  targetLang: string;
  launchAtLogin: boolean;
  isWorkerFromEnv?: boolean;
  isApiKeyFromEnv?: boolean;
  hasUpdateUrl?: boolean;
}
export interface SettingsInput extends Settings { apiKey?: string }
export type UpdatePhase = 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
export interface UpdateState {
  phase: UpdatePhase;
  currentVersion?: string;
  version?: string;
  releaseNotes?: string;
  progress?: number;
  bytesPerSecond?: number;
  transferred?: number;
  total?: number;
  error?: string;
}
export interface Status {
  running: boolean;
  error: string;
  address: string;
  cachePath: string;
  activeJobs: number;
  lastError: string;
}
export interface DesktopApi {
  voice(enabled: boolean): Promise<void>;
  navigate(url: string): Promise<void>;
  bounds(bounds: { x: number; y: number; width: number; height: number } | null): Promise<void>;
  playback(action: 'pause' | 'play' | 'seek', time?: number): Promise<void>;
  session(): Promise<VideoSession>;
  startTranslation(videoId: string): Promise<void>;
  loadSubtitles(videoId: string, sourceLanguage?: SourceLanguage, forceRefresh?: boolean): Promise<void>;
  retry(): Promise<void>;
  audio(videoId: string, chunk: number, sourceLanguage?: SourceLanguage): Promise<Uint8Array>;
  settings(): Promise<Settings & { hasApiKey: boolean }>;
  save(input: SettingsInput): Promise<void>;
  status(): Promise<Status>;
  openCache(): Promise<void>;
  chooseAudioDirectory(): Promise<string | null>;
  checkUpdate(): Promise<UpdateState>;
  downloadUpdate(): Promise<void>;
  installUpdate(): Promise<void>;
  onUpdateStatus(listener: (state: UpdateState) => void): () => void;
}
export interface VoiceChunk extends SubtitleSegment { id: number; ready: boolean }
export interface VideoSession {
  captionRetryAt?: number;
  detectedSourceLanguage?: string;
  captionLanguages?: { value: string; label: string }[];
  sourceLanguage?: SourceLanguage;
  navigationError?: string;
  videoId: string; title: string; phase: 'IDLE' | 'EXTRACTING' | 'CAPTIONS_READY' | 'BUFFERING' | 'PLAYING' | 'COMPLETE' | 'ERROR' | 'NO_SUBTITLES';
  error: string; chunks: VoiceChunk[]; ready: number; total: number; initialRequired: number;
  time: number; paused: boolean; rate: number; muted: boolean; volume: number; cached: boolean; subtitlesCached?: boolean;
}
