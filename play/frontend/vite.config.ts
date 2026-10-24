import path from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Backend port for this project (see .claude/CLAUDE.md port table).
// 127.0.0.1 rather than localhost: the backend binds IPv4 only, and newer Node resolves localhost to ::1 first.
const BACKEND_PORT = 3004;

// Protocol and physics code is shared with the backend: backend/src/shared is the single source of truth,
// compiled into the backend by tsc and imported here through the @shared alias.
const here = import.meta.dirname;
const shared = path.resolve(here, '../backend/src/shared');

/**
 * Google Analytics (GA4): adds the standard gtag snippet to index.html, but only when VITE_GA_MEASUREMENT_ID
 * is set. The deploy workflow sets it from the GA_MEASUREMENT_ID repository variable, so local dev servers and
 * preview builds never send page views. Route changes are counted by GA4's enhanced measurement (on by default).
 */
function googleAnalytics(measurementId: string | undefined): Plugin {
  if (measurementId && !/^G-[A-Z0-9]+$/.test(measurementId)) {
    throw new Error(`VITE_GA_MEASUREMENT_ID must be a GA4 measurement ID like G-XXXXXXXXXX, not "${measurementId}"`);
  }
  return {
    name: 'google-analytics',
    transformIndexHtml: () =>
      measurementId
        ? [
            {
              tag: 'script',
              attrs: { async: true, src: `https://www.googletagmanager.com/gtag/js?id=${measurementId}` },
              injectTo: 'head',
            },
            {
              tag: 'script',
              children: [
                'window.dataLayer = window.dataLayer || [];',
                'function gtag(){dataLayer.push(arguments);}',
                "gtag('js', new Date());",
                `gtag('config', '${measurementId}');`,
              ].join('\n'),
              injectTo: 'head',
            },
          ]
        : [],
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    plugins: [react(), googleAnalytics(env.VITE_GA_MEASUREMENT_ID)],
    resolve: {
      alias: { '@shared': shared },
    },
    server: {
      fs: { allow: [here, shared] },
      proxy: {
        '/api': { target: `http://127.0.0.1:${BACKEND_PORT}`, ws: true },
      },
    },
    build: {
      chunkSizeWarningLimit: 1200,
    },
  };
});
