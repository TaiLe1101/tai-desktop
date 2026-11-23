import type { DubbingPreferences, VoiceOption } from './types';

export const DEFAULT_SPEECH_RATE = 1.5;

export const SPEECH_RATE_OPTIONS: number[] = [
  0.5, 0.6, 0.7, 0.8, 0.9,
  1.0, 1.1, 1.2, 1.3, 1.4,
  1.5, 1.6, 1.7, 1.8, 1.9,
  2.0, 2.5, 3, 4, 5
];

export const DEFAULT_DUBBING_PREFERENCES: DubbingPreferences = {
  targetLang: 'vi',
  voiceByLang: {},
  speechRate: DEFAULT_SPEECH_RATE,
  originalAudioMode: 'duck',
  duckLevel: 25,
  dubVolume: 100,
  subtitleMode: 'bilingual'
};

export interface TargetLanguageEntry {
  code: string;
  label: string;
  nativeLabel: string;
  voices: VoiceOption[];
}

/**
 * 42-language Neural Voice catalog (Azure/Edge Neural voices), aligned with
 * autodub-example and tai-worker voice resolution.
 */
export const TARGET_LANGUAGES: TargetLanguageEntry[] = [
  {
    code: 'vi', label: 'Vietnamese', nativeLabel: 'Tiếng Việt',
    voices: [
      { id: 'vi-VN-HoaiMyNeural', name: 'HoaiMy (Female)', gender: 'female', lang: 'vi' },
      { id: 'vi-VN-NamMinhNeural', name: 'NamMinh (Male)', gender: 'male', lang: 'vi' }
    ]
  },
  {
    code: 'en', label: 'English', nativeLabel: 'English',
    voices: [
      { id: 'en-US-EmmaMultilingualNeural', name: 'Emma (Female)', gender: 'female', lang: 'en' },
      { id: 'en-US-AndrewMultilingualNeural', name: 'Andrew (Male)', gender: 'male', lang: 'en' },
      { id: 'en-US-JennyNeural', name: 'Jenny (Female)', gender: 'female', lang: 'en' },
      { id: 'en-GB-SoniaNeural', name: 'Sonia UK (Female)', gender: 'female', lang: 'en' }
    ]
  },
  {
    code: 'zh-CN', label: 'Chinese (Simplified)', nativeLabel: '简体中文',
    voices: [
      { id: 'zh-CN-XiaoxiaoNeural', name: 'Xiaoxiao (Female)', gender: 'female', lang: 'zh-CN' },
      { id: 'zh-CN-YunxiNeural', name: 'Yunxi (Male)', gender: 'male', lang: 'zh-CN' }
    ]
  },
  {
    code: 'zh-TW', label: 'Chinese (Traditional)', nativeLabel: '繁體中文',
    voices: [
      { id: 'zh-TW-HsiaoChenNeural', name: 'HsiaoChen (Female)', gender: 'female', lang: 'zh-TW' },
      { id: 'zh-TW-YunJheNeural', name: 'YunJhe (Male)', gender: 'male', lang: 'zh-TW' }
    ]
  },
  {
    code: 'zh-HK', label: 'Cantonese', nativeLabel: '粵語',
    voices: [
      { id: 'zh-HK-HiuMaanNeural', name: 'HiuMaan (Female)', gender: 'female', lang: 'zh-HK' },
      { id: 'zh-HK-WanLungNeural', name: 'WanLung (Male)', gender: 'male', lang: 'zh-HK' }
    ]
  },
  {
    code: 'ja', label: 'Japanese', nativeLabel: '日本語',
    voices: [
      { id: 'ja-JP-NanamiNeural', name: 'Nanami (Female)', gender: 'female', lang: 'ja' },
      { id: 'ja-JP-KeitaNeural', name: 'Keita (Male)', gender: 'male', lang: 'ja' }
    ]
  },
  {
    code: 'ko', label: 'Korean', nativeLabel: '한국어',
    voices: [
      { id: 'ko-KR-SunHiNeural', name: 'SunHi (Female)', gender: 'female', lang: 'ko' },
      { id: 'ko-KR-InJoonNeural', name: 'InJoon (Male)', gender: 'male', lang: 'ko' }
    ]
  },
  {
    code: 'es', label: 'Spanish', nativeLabel: 'Español',
    voices: [
      { id: 'es-ES-ElviraNeural', name: 'Elvira (Female)', gender: 'female', lang: 'es' },
      { id: 'es-ES-AlvaroNeural', name: 'Alvaro (Male)', gender: 'male', lang: 'es' },
      { id: 'es-MX-DaliaNeural', name: 'Dalia MX (Female)', gender: 'female', lang: 'es' }
    ]
  },
  {
    code: 'fr', label: 'French', nativeLabel: 'Français',
    voices: [
      { id: 'fr-FR-DeniseNeural', name: 'Denise (Female)', gender: 'female', lang: 'fr' },
      { id: 'fr-FR-HenriNeural', name: 'Henri (Male)', gender: 'male', lang: 'fr' }
    ]
  },
  {
    code: 'de', label: 'German', nativeLabel: 'Deutsch',
    voices: [
      { id: 'de-DE-KatjaNeural', name: 'Katja (Female)', gender: 'female', lang: 'de' },
      { id: 'de-DE-ConradNeural', name: 'Conrad (Male)', gender: 'male', lang: 'de' }
    ]
  },
  {
    code: 'pt', label: 'Portuguese', nativeLabel: 'Português',
    voices: [
      { id: 'pt-BR-FranciscaNeural', name: 'Francisca (Female)', gender: 'female', lang: 'pt' },
      { id: 'pt-BR-AntonioNeural', name: 'Antonio (Male)', gender: 'male', lang: 'pt' },
      { id: 'pt-PT-RaquelNeural', name: 'Raquel PT (Female)', gender: 'female', lang: 'pt' }
    ]
  },
  {
    code: 'ru', label: 'Russian', nativeLabel: 'Русский',
    voices: [
      { id: 'ru-RU-SvetlanaNeural', name: 'Svetlana (Female)', gender: 'female', lang: 'ru' },
      { id: 'ru-RU-DmitryNeural', name: 'Dmitry (Male)', gender: 'male', lang: 'ru' }
    ]
  },
  {
    code: 'ar', label: 'Arabic', nativeLabel: 'العربية',
    voices: [
      { id: 'ar-SA-ZariyahNeural', name: 'Zariyah (Female)', gender: 'female', lang: 'ar' },
      { id: 'ar-SA-HamedNeural', name: 'Hamed (Male)', gender: 'male', lang: 'ar' }
    ]
  },
  {
    code: 'hi', label: 'Hindi', nativeLabel: 'हिन्दी',
    voices: [
      { id: 'hi-IN-SwaraNeural', name: 'Swara (Female)', gender: 'female', lang: 'hi' },
      { id: 'hi-IN-MadhurNeural', name: 'Madhur (Male)', gender: 'male', lang: 'hi' }
    ]
  },
  {
    code: 'it', label: 'Italian', nativeLabel: 'Italiano',
    voices: [
      { id: 'it-IT-ElsaNeural', name: 'Elsa (Female)', gender: 'female', lang: 'it' },
      { id: 'it-IT-DiegoNeural', name: 'Diego (Male)', gender: 'male', lang: 'it' }
    ]
  },
  {
    code: 'nl', label: 'Dutch', nativeLabel: 'Nederlands',
    voices: [
      { id: 'nl-NL-ColetteNeural', name: 'Colette (Female)', gender: 'female', lang: 'nl' },
      { id: 'nl-NL-MaartenNeural', name: 'Maarten (Male)', gender: 'male', lang: 'nl' }
    ]
  },
  {
    code: 'pl', label: 'Polish', nativeLabel: 'Polski',
    voices: [
      { id: 'pl-PL-ZofiaNeural', name: 'Zofia (Female)', gender: 'female', lang: 'pl' },
      { id: 'pl-PL-MarekNeural', name: 'Marek (Male)', gender: 'male', lang: 'pl' }
    ]
  },
  {
    code: 'tr', label: 'Turkish', nativeLabel: 'Türkçe',
    voices: [
      { id: 'tr-TR-EmelNeural', name: 'Emel (Female)', gender: 'female', lang: 'tr' },
      { id: 'tr-TR-AhmetNeural', name: 'Ahmet (Male)', gender: 'male', lang: 'tr' }
    ]
  },
  {
    code: 'th', label: 'Thai', nativeLabel: 'ไทย',
    voices: [
      { id: 'th-TH-PremwadeeNeural', name: 'Premwadee (Female)', gender: 'female', lang: 'th' },
      { id: 'th-TH-NiwatNeural', name: 'Niwat (Male)', gender: 'male', lang: 'th' }
    ]
  },
  {
    code: 'id', label: 'Indonesian', nativeLabel: 'Bahasa Indonesia',
    voices: [
      { id: 'id-ID-GadisNeural', name: 'Gadis (Female)', gender: 'female', lang: 'id' },
      { id: 'id-ID-ArdiNeural', name: 'Ardi (Male)', gender: 'male', lang: 'id' }
    ]
  },
  {
    code: 'ms', label: 'Malay', nativeLabel: 'Bahasa Melayu',
    voices: [
      { id: 'ms-MY-YasminNeural', name: 'Yasmin (Female)', gender: 'female', lang: 'ms' },
      { id: 'ms-MY-OsmanNeural', name: 'Osman (Male)', gender: 'male', lang: 'ms' }
    ]
  },
  {
    code: 'fil', label: 'Filipino', nativeLabel: 'Filipino',
    voices: [
      { id: 'fil-PH-BlessicaNeural', name: 'Blessica (Female)', gender: 'female', lang: 'fil' },
      { id: 'fil-PH-AngeloNeural', name: 'Angelo (Male)', gender: 'male', lang: 'fil' }
    ]
  },
  {
    code: 'uk', label: 'Ukrainian', nativeLabel: 'Українська',
    voices: [
      { id: 'uk-UA-PolinaNeural', name: 'Polina (Female)', gender: 'female', lang: 'uk' },
      { id: 'uk-UA-OstapNeural', name: 'Ostap (Male)', gender: 'male', lang: 'uk' }
    ]
  },
  {
    code: 'cs', label: 'Czech', nativeLabel: 'Čeština',
    voices: [
      { id: 'cs-CZ-VlastaNeural', name: 'Vlasta (Female)', gender: 'female', lang: 'cs' },
      { id: 'cs-CZ-AntoninNeural', name: 'Antonin (Male)', gender: 'male', lang: 'cs' }
    ]
  },
  {
    code: 'ro', label: 'Romanian', nativeLabel: 'Română',
    voices: [
      { id: 'ro-RO-AlinaNeural', name: 'Alina (Female)', gender: 'female', lang: 'ro' },
      { id: 'ro-RO-EmilNeural', name: 'Emil (Male)', gender: 'male', lang: 'ro' }
    ]
  },
  {
    code: 'el', label: 'Greek', nativeLabel: 'Ελληνικά',
    voices: [
      { id: 'el-GR-AthinaNeural', name: 'Athina (Female)', gender: 'female', lang: 'el' },
      { id: 'el-GR-NestorasNeural', name: 'Nestoras (Male)', gender: 'male', lang: 'el' }
    ]
  },
  {
    code: 'hu', label: 'Hungarian', nativeLabel: 'Magyar',
    voices: [
      { id: 'hu-HU-NoemiNeural', name: 'Noemi (Female)', gender: 'female', lang: 'hu' },
      { id: 'hu-HU-TamasNeural', name: 'Tamas (Male)', gender: 'male', lang: 'hu' }
    ]
  },
  {
    code: 'sv', label: 'Swedish', nativeLabel: 'Svenska',
    voices: [
      { id: 'sv-SE-SofieNeural', name: 'Sofie (Female)', gender: 'female', lang: 'sv' },
      { id: 'sv-SE-MattiasNeural', name: 'Mattias (Male)', gender: 'male', lang: 'sv' }
    ]
  },
  {
    code: 'da', label: 'Danish', nativeLabel: 'Dansk',
    voices: [
      { id: 'da-DK-ChristelNeural', name: 'Christel (Female)', gender: 'female', lang: 'da' },
      { id: 'da-DK-JeppeNeural', name: 'Jeppe (Male)', gender: 'male', lang: 'da' }
    ]
  },
  {
    code: 'fi', label: 'Finnish', nativeLabel: 'Suomi',
    voices: [
      { id: 'fi-FI-NooraNeural', name: 'Noora (Female)', gender: 'female', lang: 'fi' },
      { id: 'fi-FI-HarriNeural', name: 'Harri (Male)', gender: 'male', lang: 'fi' }
    ]
  },
  {
    code: 'no', label: 'Norwegian', nativeLabel: 'Norsk',
    voices: [
      { id: 'nb-NO-PernilleNeural', name: 'Pernille (Female)', gender: 'female', lang: 'no' },
      { id: 'nb-NO-FinnNeural', name: 'Finn (Male)', gender: 'male', lang: 'no' }
    ]
  },
  {
    code: 'he', label: 'Hebrew', nativeLabel: 'עברית',
    voices: [
      { id: 'he-IL-HilaNeural', name: 'Hila (Female)', gender: 'female', lang: 'he' },
      { id: 'he-IL-AvriNeural', name: 'Avri (Male)', gender: 'male', lang: 'he' }
    ]
  },
  {
    code: 'te', label: 'Telugu', nativeLabel: 'తెలుగు',
    voices: [
      { id: 'te-IN-ShrutiNeural', name: 'Shruti (Female)', gender: 'female', lang: 'te' },
      { id: 'te-IN-MohanNeural', name: 'Mohan (Male)', gender: 'male', lang: 'te' }
    ]
  },
  {
    code: 'mr', label: 'Marathi', nativeLabel: 'मराठी',
    voices: [
      { id: 'mr-IN-AarohiNeural', name: 'Aarohi (Female)', gender: 'female', lang: 'mr' },
      { id: 'mr-IN-ManoharNeural', name: 'Manohar (Male)', gender: 'male', lang: 'mr' }
    ]
  },
  {
    code: 'sk', label: 'Slovak', nativeLabel: 'Slovenčina',
    voices: [
      { id: 'sk-SK-ViktoriaNeural', name: 'Viktoria (Female)', gender: 'female', lang: 'sk' },
      { id: 'sk-SK-LukasNeural', name: 'Lukas (Male)', gender: 'male', lang: 'sk' }
    ]
  },
  {
    code: 'gu', label: 'Gujarati', nativeLabel: 'ગુજરાતી',
    voices: [
      { id: 'gu-IN-DhwaniNeural', name: 'Dhwani (Female)', gender: 'female', lang: 'gu' },
      { id: 'gu-IN-NiranjanNeural', name: 'Niranjan (Male)', gender: 'male', lang: 'gu' }
    ]
  },
  {
    code: 'kn', label: 'Kannada', nativeLabel: 'ಕನ್ನಡ',
    voices: [
      { id: 'kn-IN-SapnaNeural', name: 'Sapna (Female)', gender: 'female', lang: 'kn' },
      { id: 'kn-IN-GaganNeural', name: 'Gagan (Male)', gender: 'male', lang: 'kn' }
    ]
  },
  {
    code: 'ml', label: 'Malayalam', nativeLabel: 'മലയാളം',
    voices: [
      { id: 'ml-IN-SobhanaNeural', name: 'Sobhana (Female)', gender: 'female', lang: 'ml' },
      { id: 'ml-IN-MidhunNeural', name: 'Midhun (Male)', gender: 'male', lang: 'ml' }
    ]
  },
  {
    code: 'bn', label: 'Bengali', nativeLabel: 'বাংলা',
    voices: [
      { id: 'bn-IN-TanishaaNeural', name: 'Tanishaa (Female)', gender: 'female', lang: 'bn' },
      { id: 'bn-IN-BashkarNeural', name: 'Bashkar (Male)', gender: 'male', lang: 'bn' }
    ]
  },
  {
    code: 'ta', label: 'Tamil', nativeLabel: 'தமிழ்',
    voices: [
      { id: 'ta-IN-PallaviNeural', name: 'Pallavi (Female)', gender: 'female', lang: 'ta' },
      { id: 'ta-IN-ValluvarNeural', name: 'Valluvar (Male)', gender: 'male', lang: 'ta' }
    ]
  },
  {
    code: 'ur', label: 'Urdu', nativeLabel: 'اردو',
    voices: [
      { id: 'ur-PK-UzmaNeural', name: 'Uzma (Female)', gender: 'female', lang: 'ur' },
      { id: 'ur-PK-AsadNeural', name: 'Asad (Male)', gender: 'male', lang: 'ur' }
    ]
  },
  {
    code: 'fa', label: 'Persian', nativeLabel: 'فارسی',
    voices: [
      { id: 'fa-IR-DilaraNeural', name: 'Dilara (Female)', gender: 'female', lang: 'fa' },
      { id: 'fa-IR-FaridNeural', name: 'Farid (Male)', gender: 'male', lang: 'fa' }
    ]
  }
];

const byCode = new Map<string, TargetLanguageEntry>(
  TARGET_LANGUAGES.map(entry => [entry.code.toLowerCase(), entry])
);

export function resolveLanguageEntry(lang: string): TargetLanguageEntry | undefined {
  const normalized = (lang || '').trim().replace(/_/g, '-');
  if (!normalized) return undefined;
  const lower = normalized.toLowerCase();
  if (byCode.has(lower)) return byCode.get(lower);
  if (lower === 'iw') return byCode.get('he');
  if (lower === 'nb') return byCode.get('no');
  if (lower === 'tl') return byCode.get('fil');
  if (lower === 'zh-hans' || lower === 'zh-sg') return byCode.get('zh-cn');
  if (lower === 'zh-hant') return byCode.get('zh-tw');
  if (lower === 'yue' || lower === 'yue-hk') return byCode.get('zh-hk');
  const base = lower.split('-')[0];
  if (base === 'zh') return undefined; // Forbid ambiguous fuzzy zh fallback
  return byCode.get(base);
}

export function getVoicesForLang(lang: string): VoiceOption[] {
  return resolveLanguageEntry(lang)?.voices ?? TARGET_LANGUAGES[0].voices;
}

export function getDefaultVoice(lang: string): string {
  return getVoicesForLang(lang)[0].id;
}

export function getSelectedVoice(lang: string, voiceByLang: Record<string, string>): string {
  const voices = getVoicesForLang(lang);
  const saved = voiceByLang[lang] || voiceByLang[lang.toLowerCase()];
  if (saved && voices.some(v => v.id === saved)) return saved;
  return voices[0].id;
}

/**
 * Effective TTS speech rate sent to backend/worker:
 * clamp(round_to_0.1(speechRate * userVideoRate), 0.5, 2.0)
 */
export function computeEffectiveSpeechRate(speechRate: number, userVideoRate = 1): number {
  const raw = (Number.isFinite(speechRate) ? speechRate : DEFAULT_SPEECH_RATE)
    * (Number.isFinite(userVideoRate) && userVideoRate > 0 ? userVideoRate : 1);
  const rounded = Math.round(raw * 10) / 10;
  return Math.min(2.0, Math.max(0.5, rounded));
}

/**
 * Formats an effective speech rate in [0.5, 2.0] into SSML percentage string
 * such as "+50%", "+0%", "-20%".
 */
export function formatSsmlRate(effectiveRate: number): string {
  const clamped = Math.min(2.0, Math.max(0.5, Number.isFinite(effectiveRate) ? effectiveRate : 1));
  const pct = Math.round((clamped - 1) * 100);
  return pct >= 0 ? `+${pct}%` : `${pct}%`;
}
