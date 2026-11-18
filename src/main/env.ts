import { app } from 'electron';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface EnvConfig {
  workerUrl: string;
  workerApiKey: string;
  updateUrl: string;
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
  return {
    workerUrl: (env.WORKER_URL || '').trim().replace(/\/+$/, ''),
    workerApiKey: (env.WORKER_API_KEY || '').trim(),
    updateUrl: (env.UPDATE_URL || '').trim().replace(/\/+$/, '')
  };
}

export function getEnvConfig(): EnvConfig {
  return loadEnv();
}

