/**
 * Vite build for the extension *pages* and the background service worker.
 *
 * Manifest V3 requires classic (non-module) static content scripts, so the
 * content script is bundled separately as an IIFE by `vite.content.config.ts`.
 * `npm run build` runs both builds back to back into the same `dist/` folder.
 */
import { defineConfig, type Plugin } from 'vite';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

/** Copies manifest.json into dist/, stamping the version from package.json. */
function manifestPlugin(): Plugin {
  return {
    name: 'chromeow-manifest',
    apply: 'build',
    writeBundle(options) {
      const outDir = options.dir ?? resolve(root, 'dist');
      const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string };
      const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8')) as Record<string, unknown>;
      manifest.version = pkg.version;
      mkdirSync(outDir, { recursive: true });
      writeFileSync(resolve(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    },
  };
}

export default defineConfig({
  base: './',
  publicDir: 'public',
  plugins: [manifestPlugin()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome116',
    modulePreload: false,
    sourcemap: false,
    cssCodeSplit: true,
    rollupOptions: {
      input: {
        popup: resolve(root, 'popup.html'),
        studio: resolve(root, 'studio.html'),
        background: resolve(root, 'src/background/StateSyncServiceWorker.ts'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
