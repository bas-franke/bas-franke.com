// Dev-server config used by tools/screenshots/capture.ts: the normal config, but proxying /api to whichever backend
// port the tool started (PLAY_BACKEND_PORT), so a screenshot run never collides with a dev server you have open.
import { type ConfigEnv, type UserConfig, defineConfig, mergeConfig } from 'vite';
import base from './vite.config.ts';

const backendPort = Number(process.env.PLAY_BACKEND_PORT ?? 3004);

export default defineConfig(async (env: ConfigEnv): Promise<UserConfig> => {
  const resolved = typeof base === 'function' ? await base(env) : base;
  return mergeConfig(resolved, {
    server: { proxy: { '/api': { target: `http://127.0.0.1:${backendPort}`, ws: true } } },
  });
});
