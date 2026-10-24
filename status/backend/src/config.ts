const env = process.env;

const optional = (value: string | undefined) => value?.trim() || undefined;

export const config = {
  port: Number(env.PORT ?? 3002),
  host: env.HOST ?? '127.0.0.1',

  rootDomain: 'bas-franke.com',
  /** The Elastic IP every domain must resolve to. */
  expectedIp: optional(env.EXPECTED_IP),
  rdsHost: optional(env.RDS_HOST),
  rdsPort: Number(env.RDS_PORT ?? 5432),

  githubRepo: env.GITHUB_REPO ?? 'bas-franke/bas-franke.com',
  githubBranch: env.GITHUB_BRANCH ?? 'master',
  /** Optional fine-grained token (Actions: read, Secrets: read). Without it, secrets cannot be checked. */
  githubToken: optional(env.GITHUB_TOKEN),

  /** Optional HTTP basic auth for the status API. */
  statusUser: env.STATUS_USER ?? 'admin',
  statusPassword: optional(env.STATUS_PASSWORD),

  appsDir: env.APPS_DIR ?? '/srv/apps',
  wwwDir: env.WWW_DIR ?? '/var/www',
  nginxSitesDir: env.NGINX_SITES_DIR ?? '/etc/nginx/sites-enabled',

  refreshIntervalMs: 60_000,
  checkTimeoutMs: 10_000,
};

export const statusEnvFile = `${config.appsDir}/status/.env`;

export const repoDoc = (path: string) => `https://github.com/${config.githubRepo}/blob/${config.githubBranch}/${path}`;

export const elasticIp = () => config.expectedIp ?? '<elastic-ip>';
