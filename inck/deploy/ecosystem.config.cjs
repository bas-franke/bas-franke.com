// PM2 process for the inck backend. Copied to /srv/apps/inck/backend/ by the deploy workflow.
module.exports = {
  apps: [
    {
      name: 'inck',
      cwd: '/srv/apps/inck/backend',
      script: 'dist/index.js',
      node_args: '--env-file-if-exists=/srv/apps/inck/.env',
      env: {
        NODE_ENV: 'production',
        PORT: '3003',
      },
      max_memory_restart: '200M',
    },
  ],
};
