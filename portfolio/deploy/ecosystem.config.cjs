// PM2 process for the portfolio backend. Copied to /srv/apps/portfolio/backend/ by the deploy workflow.
module.exports = {
  apps: [
    {
      name: 'portfolio',
      cwd: '/srv/apps/portfolio/backend',
      script: 'dist/index.js',
      node_args: '--env-file-if-exists=/srv/apps/portfolio/.env',
      env: {
        NODE_ENV: 'production',
        PORT: '3001',
      },
      max_memory_restart: '200M',
    },
  ],
};
