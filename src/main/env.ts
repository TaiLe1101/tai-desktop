import { app } from 'electron';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface EnvConfig {
  workerUrl: string;
  workerApiKey: string;
  updateUrl: string;
}

let loaded = false;

function parseEnv(content: string) {
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
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

export function loadEnv(): EnvConfig {
  if (loaded) return getEnvConfig();
  loaded = true;

  const candidates: string[] = [
    join(process.cwd(), '.env'),
  ];

  try {
    if (app) {
      if (app.isPackaged) {
        candidates.unshift(join(dirname(process.execPath), '.env'));
      }
      candidates.push(join(app.getPath('userData'), '.env'));
    }
  } catch {}

  for (const file of candidates) {
    if (existsSync(file)) {
      try {
        parseEnv(readFileSync(file, 'utf8'));
      } catch {}
    }
  }

  return getEnvConfig();
}

export function getEnvConfig(): EnvConfig {
  return {
    workerUrl: (process.env.WORKER_URL || '').trim().replace(/\/+$/, ''),
    workerApiKey: (process.env.WORKER_API_KEY || '').trim(),
    updateUrl: (process.env.UPDATE_URL || '').trim().replace(/\/+$/, '')
  };
}

