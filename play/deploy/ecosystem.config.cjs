// PM2 process for the play backend. Copied to /srv/apps/play/backend/ by the deploy workflow.
module.exports = {
  apps: [
    {
      name: 'play',
      cwd: '/srv/apps/play/backend',
      script: 'dist/index.js',
      node_args: '--env-file-if-exists=/srv/apps/play/.env',
      env: {
        NODE_ENV: 'production',
        PORT: '3004',
      },
      // Game rooms live in memory; a restart closes every room, so reload only on deploy.
      max_memory_restart: '400M',
      kill_timeout: 5000,
    },
  ],
};
