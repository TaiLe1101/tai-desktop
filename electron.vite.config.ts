import { defineConfig } from 'electron-vite';

export default defineConfig({ main: {}, preload: {}, renderer: {
  build: { rollupOptions: { onwarn(warning, warn) {
    if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('use client')) return;
    warn(warning);
  } } }
} });
