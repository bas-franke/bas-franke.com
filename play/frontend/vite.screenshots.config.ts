// Dev-server config used by tools/screenshots/capture.ts: the normal config, but proxying /api to whichever backend
// port the tool started (PLAY_BACKEND_PORT), so a screenshot run never collides with a dev server you have open.
// No HMR and no file watching: an edit made while the run is going (another session at work in the same checkout)
// would hot-update or remount the page mid-capture, and a room game rebuilt that way misses messages it already had
// (a Dustrunners race stuck on its grid after `go`).
import { type ConfigEnv, type UserConfig, defineConfig, mergeConfig } from 'vite';
import base from './vite.config.ts';

const backendPort = Number(process.env.PLAY_BACKEND_PORT ?? 3004);

export default defineConfig(async (env: ConfigEnv): Promise<UserConfig> => {
  const resolved = typeof base === 'function' ? await base(env) : base;
  return mergeConfig(resolved, {
    server: { hmr: false, watch: null, proxy: { '/api': { target: `http://127.0.0.1:${backendPort}`, ws: true } } },
  });
});
