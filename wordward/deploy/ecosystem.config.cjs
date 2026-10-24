// PM2 process for the wordward backend. Copied to /srv/apps/wordward/backend/ by the deploy workflow.
module.exports = {
  apps: [
    {
      name: 'wordward',
      cwd: '/srv/apps/wordward/backend',
      script: 'dist/index.js',
      node_args: '--env-file-if-exists=/srv/apps/wordward/.env',
      env: {
        NODE_ENV: 'production',
        PORT: '3005',
      },
      max_memory_restart: '200M',
    },
  ],
};
