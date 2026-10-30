// PM2 process for the stonks backend. Copied to /srv/apps/stonks/backend/ by the deploy workflow.
module.exports = {
  apps: [
    {
      name: 'stonks',
      cwd: '/srv/apps/stonks/backend',
      script: 'dist/index.js',
      node_args: '--env-file-if-exists=/srv/apps/stonks/.env',
      env: {
        NODE_ENV: 'production',
        PORT: '3006',
      },
      max_memory_restart: '300M',
      // engine.drain() waits up to 25 s for a running tick before the process goes
      kill_timeout: 30000,
    },
  ],
};
