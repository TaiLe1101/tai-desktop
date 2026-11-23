import { app } from 'electron';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface EnvConfig {
  serverUrl: string;
  serverApiKey: string;
  workerUrl: string;
  workerApiKey: string;
  updateUrl: string;
  isExplicitServerUrl: boolean;
}

type RawEnv = Record<string, string>;

function parseEnv(content: string): RawEnv {
  const parsed: RawEnv = {};
  const lines = content.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    parsed[key] = val;
  }
  return parsed;
}

function deriveOrigin(urlStr: string): string {
  if (!urlStr) return '';
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) {
      return parsed.origin;
    }
  } catch {}
  return '';
}

export function loadEnv(): EnvConfig {
  const isPackaged = Boolean(app?.isPackaged);
  let candidates: string[];

  if (isPackaged) {
    // The bundled production file is the default. Files beside the executable
    // and in userData are optional deployment-specific overrides.
    candidates = [
      join(process.resourcesPath, '.env'),
      join(dirname(process.execPath), '.env'),
      join(app.getPath('userData'), '.env')
    ];
  } else {
    // Development overrides production-like defaults without editing them.
    const roots = [process.cwd(), join(__dirname, '../..'), join(__dirname, '..')];
    candidates = roots.flatMap(root => [
      join(root, '.env'),
      join(root, '.env.development'),
      join(root, '.env.local'),
      join(root, '.env.development.local')
    ]);
  }

  let fileEnv: RawEnv = {};
  for (const file of [...new Set(candidates)]) {
    if (existsSync(file)) {
      try {
        fileEnv = { ...fileEnv, ...parseEnv(readFileSync(file, 'utf8')) };
      } catch {}
    }
  }

  // Explicit OS/CI variables always have the highest priority.
  const env = { ...fileEnv, ...process.env };
  const updateUrl = (env.UPDATE_URL || '').trim().replace(/\/+$/, '');
  const explicitServer = (env.SERVER_URL || '').trim().replace(/\/+$/, '');
  const serverUrl = explicitServer || deriveOrigin(updateUrl);

  return {
    serverUrl,
    serverApiKey: (env.SERVER_API_KEY || '').trim(),
    workerUrl: (env.WORKER_URL || '').trim().replace(/\/+$/, ''),
    workerApiKey: (env.WORKER_API_KEY || '').trim(),
    updateUrl,
    isExplicitServerUrl: Boolean(explicitServer)
  };
}

export function getEnvConfig(): EnvConfig {
  return loadEnv();
}
