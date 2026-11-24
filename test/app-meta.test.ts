import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');

describe('app branding assets and dynamic version metadata', () => {
  it('bundles PNG and multi-resolution ICO logo assets', () => {
    const pngPath = resolve(root, 'build/icon.png');
    const icoPath = resolve(root, 'build/icon.ico');
    const rendererLogoPath = resolve(root, 'src/renderer/assets/logo.png');

    assert.equal(existsSync(pngPath), true, 'build/icon.png missing');
    assert.equal(existsSync(icoPath), true, 'build/icon.ico missing');
    assert.equal(existsSync(rendererLogoPath), true, 'src/renderer/assets/logo.png missing');

    // PNG signature check
    const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(readFileSync(pngPath).subarray(0, 8).equals(pngSig), true);
    assert.equal(readFileSync(rendererLogoPath).subarray(0, 8).equals(pngSig), true);

    // Valid ICO header: reserved=0, type=1, count>=5
    const ico = readFileSync(icoPath);
    assert.equal(ico.readUInt16LE(0), 0);
    assert.equal(ico.readUInt16LE(2), 1);
    assert.ok(ico.readUInt16LE(4) >= 5, 'ICO must include multiple resolutions');
  });

  it('keeps package.json and package-lock.json versions synced with zero hardcoded versions in index.html', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string };
    const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8')) as {
      version: string;
      packages: Record<string, { version?: string }>;
    };
    assert.match(pkg.version, /^\d+\.\d+\.\d+/);
    assert.equal(lock.version, pkg.version);
    assert.equal(lock.packages['']?.version, pkg.version);

    const html = readFileSync(resolve(root, 'src/renderer/index.html'), 'utf8');
    assert.equal(/\b\d+\.\d+\.\d+\b/.test(html), false, 'index.html should not hardcode a version');
  });
});
