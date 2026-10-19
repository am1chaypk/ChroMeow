/**
 * Second Vite pass: the content script as a single self-contained IIFE.
 * Static MV3 content scripts cannot be ES modules, so everything the content
 * script needs (engine, AI, renderer, sound) is inlined into dist/content.js.
 */
import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  publicDir: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'chrome116',
    sourcemap: false,
    lib: {
      entry: resolve(root, 'src/content/index.ts'),
      name: 'ChroMeowContent',
      formats: ['iife'],
      fileName: () => 'content.js',
    },
    rollupOptions: {
      output: { extend: true },
    },
  },
});
