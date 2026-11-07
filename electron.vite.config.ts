import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import { resolve } from 'node:path';

// Only the app's own bundle, the mr: photo protocol, blob: previews and data: URLs may load.
// Applied at build time only: the dev server needs inline scripts for React refresh.
const contentSecurityPolicy: Plugin = {
  name: 'content-security-policy',
  apply: 'build',
  transformIndexHtml: () => [
    {
      tag: 'meta',
      attrs: {
        'http-equiv': 'Content-Security-Policy',
        content:
          "default-src 'self'; img-src 'self' mr: blob: data:; style-src 'self' 'unsafe-inline'; connect-src 'self'",
      },
      injectTo: 'head-prepend',
    },
  ],
};

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // The worker sits next to `index` so main can start it by file name.
        input: {
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          worker: resolve(import.meta.dirname, 'src/main/worker.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, 'src/preload/index.ts') },
        // Sandboxed preload scripts must be CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    plugins: [react(), contentSecurityPolicy],
    build: {
      rollupOptions: { input: { index: resolve(import.meta.dirname, 'src/renderer/index.html') } },
    },
  },
});
