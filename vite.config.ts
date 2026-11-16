import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import fs from 'node:fs';
import { createRequire } from 'node:module';

// The backend serves the built SPA in production; during dev, Vite proxies the
// API, media and room sockets to the local backend on :3000.
const backend = process.env.NOVA_BACKEND ?? 'http://localhost:3000';

/** WebTorrent's tiny service worker, imported by the PWA worker for in-browser torrent streams. */
function webtorrentWorker(): Plugin {
  return {
    name: 'nova-webtorrent-sw',
    generateBundle() {
      const file = createRequire(import.meta.url).resolve('webtorrent/dist/sw.min.js');
      this.emitFile({ type: 'asset', fileName: 'webtorrent-sw.js', source: fs.readFileSync(file, 'utf8') });
    },
  };
}

/**
 * JASSUB asks for a `desynchronized` (low-latency, front-buffer) canvas. Over a <video> on
 * Windows Chromium that canvas fights the video's hardware overlay: the subtitles or the
 * whole picture flicker or go black (ThaUnknown/jassub#70). A normal canvas is plenty fast.
 */
function jassubSynchronized(): Plugin {
  return {
    name: 'nova-jassub-synchronized',
    transform(code, id) {
      if (!/[\\/]jassub[\\/]dist[\\/]worker[\\/]/.test(id) || !code.includes('desynchronized')) return null;
      return { code: code.replace(/desynchronized:\s*true/g, 'desynchronized: false'), map: null };
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    jassubSynchronized(),
    webtorrentWorker(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Nova',
        short_name: 'Nova',
        description: 'Movies, shows, anime, live TV and books in one place.',
        theme_color: '#07070b',
        background_color: '#07070b',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
      },
      workbox: {
        // Never let the service worker answer API, media or socket routes.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api/, /^\/stream/, /^\/live\//, /^\/ws/, /^\/healthz/, /^\/readyz/, /^\/webtorrent\//, /^\/engine\//, /^\/cast\//],
        importScripts: ['/webtorrent-sw.js'],
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        // Big, rarely-needed engines (HLS/TS live video, PDF, EPUB) load on demand instead of on install.
        globIgnores: ['**/hls-*.js', '**/mpegts-*.js', '**/PdfView-*.js', '**/EpubView-*.js', '**/pdf.worker*', '**/jassub*', '**/worker-*.js', '**/webtorrent*'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': backend,
      '/stream': backend,
      '/live/': backend,
      '/ws': { target: backend.replace(/^http/, 'ws'), ws: true },
    },
  },
  // jassub finds its worker and wasm via `new URL(..., import.meta.url)`, which pre-bundling would break.
  optimizeDeps: { exclude: ['jassub'] },
  worker: { format: 'es', plugins: () => [jassubSynchronized()] },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
});
