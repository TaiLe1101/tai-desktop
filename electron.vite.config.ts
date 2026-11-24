import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string };
const appVersion = pkg.version;

export default defineConfig({
  main: {
    define: {
      __APP_VERSION__: JSON.stringify(appVersion)
    }
  },
  preload: {},
  renderer: {
    define: {
      __APP_VERSION__: JSON.stringify(appVersion)
    },
    plugins: [
      {
        name: 'tai-inject-app-version',
        transformIndexHtml(html) {
          return html.replace(/<title>[^<]*<\/title>/i, `<title>TAI Desktop v${appVersion}</title>`);
        }
      }
    ],
    build: {
      rollupOptions: {
        onwarn(warning, warn) {
          if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('use client')) return;
          warn(warning);
        }
      }
    }
  }
});
