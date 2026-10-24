// PM2 process for the status backend. Copied to /srv/apps/status/backend/ by the deploy workflow.
module.exports = {
  apps: [
    {
      name: 'status',
      cwd: '/srv/apps/status/backend',
      script: 'dist/index.js',
      node_args: '--env-file-if-exists=/srv/apps/status/.env',
      env: {
        NODE_ENV: 'production',
        PORT: '3002',
      },
      max_memory_restart: '200M',
    },
  ],
};
