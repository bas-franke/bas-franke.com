// PM2 process for the pulse backend. Copied to /srv/apps/pulse/backend/ by the deploy workflow.
module.exports = {
  apps: [
    {
      name: 'pulse',
      cwd: '/srv/apps/pulse/backend',
      script: 'dist/index.js',
      node_args: '--env-file-if-exists=/srv/apps/pulse/.env',
      env: {
        NODE_ENV: 'production',
        PORT: '3007',
      },
      max_memory_restart: '200M',
    },
  ],
};
