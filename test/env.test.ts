import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEnvConfig, loadEnv } from '../src/main/env';
import { SettingsStore } from '../src/main/settings';

test('loadEnv parses environment variables properly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tai-env-test-'));
  const envFile = join(dir, '.env');
  await writeFile(envFile, `
# Test comment
UPDATE_URL=https://updates.example.com/tai/
WORKER_URL="https://worker.example.com"
WORKER_API_KEY='secret-key-123'
IGNORED_LINE
`);

  const originalCwd = process.cwd();
  try {
    process.chdir(dir);
    loadEnv();
    const config = getEnvConfig();
    assert.equal(config.updateUrl, 'https://updates.example.com/tai');
    assert.equal(config.workerUrl, 'https://worker.example.com');
    assert.equal(config.workerApiKey, 'secret-key-123');
  } finally {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('SettingsStore integrates with environment variables', () => {
  process.env.WORKER_URL = 'https://env-worker.example.com';
  process.env.WORKER_API_KEY = 'env-api-key';

  const store = new SettingsStore();
  const workerConfig = store.worker();
  assert.equal(workerConfig.workerUrl, 'https://env-worker.example.com');
  assert.equal(workerConfig.apiKey, 'env-api-key');

  const pub = store.publicValue();
  assert.equal(pub.isWorkerFromEnv, true);
  assert.equal(pub.isApiKeyFromEnv, true);
  assert.equal(pub.workerUrl, 'https://env-worker.example.com');
});

