import { config, repoDoc, statusEnvFile } from '../config.js';
import { fail, ok, skip, warn, type CheckDef, type Fix, type Project } from '../types.js';
import { memo } from '../util.js';

const REQUIRED_SECRETS = ['EC2_HOST', 'EC2_USER', 'EC2_SSH_KEY'];
const secretsDoc = repoDoc('infra/README.md#4-github-repository-secrets');

// GitHub allows 60 unauthenticated requests per hour, so cache every response for 5 minutes.
const cache = new Map<string, () => Promise<{ status: number; body: any }>>();

function github(path: string) {
  let get = cache.get(path);
  if (!get) {
    get = memo(async () => {
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'bas-franke-status',
        'X-GitHub-Api-Version': '2022-11-28',
      };
      if (config.githubToken) headers.Authorization = `Bearer ${config.githubToken}`;
      const res = await fetch(`https://api.github.com/repos/${config.githubRepo}${path}`, { headers, signal: AbortSignal.timeout(5000) });
      return { status: res.status, body: await res.json().catch(() => null) };
    }, 5 * 60_000);
    cache.set(path, get);
  }
  return get();
}

const tokenFix: Fix = {
  summary: 'Give the status page a read-only GitHub token so it can verify secrets (and see a private repo).',
  steps: [
    {
      text: 'GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token. Repository access: only bas-franke/bas-franke.com. Permissions: Actions (read), Secrets (read), Metadata (read).',
    },
    { text: `Add it on the server and restart:`, code: `echo "GITHUB_TOKEN=<token>" >> ${statusEnvFile}\npm2 restart status --update-env` },
  ],
};

export const secretsCheck: CheckDef = {
  id: 'github:secrets',
  title: 'Deploy secrets configured',
  provider: 'GitHub',
  fix: {
    summary: 'The deploy workflows need SSH access to the server.',
    steps: [
      { text: 'Create a deploy key on your machine (no passphrase):', code: 'ssh-keygen -t ed25519 -C "github-actions-deploy" -f gh-deploy -N ""' },
      { text: 'Allow it on the server:', code: 'ssh -i bas-franke-ec2.pem ubuntu@<elastic-ip> "cat >> ~/.ssh/authorized_keys" < gh-deploy.pub' },
      {
        text: `GitHub → ${config.githubRepo} → Settings → Secrets and variables → Actions → New repository secret. Add EC2_HOST = the Elastic IP, EC2_USER = ubuntu, EC2_SSH_KEY = the full contents of the file "gh-deploy".`,
      },
    ],
    doc: secretsDoc,
  },
  run: async () => {
    if (!config.githubToken) return skip('GITHUB_TOKEN is not set, so secrets cannot be checked.', tokenFix);
    const { status, body } = await github('/actions/secrets?per_page=100');
    if (status === 401 || status === 403 || status === 404) return fail(`GitHub returned HTTP ${status}: the token lacks "Secrets: read" for this repo.`, tokenFix);
    if (status !== 200) return fail(`GitHub returned HTTP ${status}.`);
    const names = new Set<string>((body.secrets ?? []).map((s: { name: string }) => s.name));
    const missing = REQUIRED_SECRETS.filter((n) => !names.has(n));
    return missing.length ? fail(`Missing secrets: ${missing.join(', ')}`) : ok(`${REQUIRED_SECRETS.join(', ')} are set.`);
  },
};

export function deployRunCheck(project: Project): CheckDef {
  const workflow = `deploy-${project.name}.yml`;
  const actionsUrl = `https://github.com/${config.githubRepo}/actions/workflows/${workflow}`;
  return {
    id: `deploy:${project.name}`,
    title: 'Latest deploy',
    provider: 'GitHub',
    fix: {
      summary: `Run "${workflow}" and make it succeed.`,
      steps: [
        { text: `Open ${actionsUrl} → Run workflow (branch ${config.githubBranch}).` },
        { text: 'If it fails at "Configure SSH" or "Upload files", fix the "Deploy secrets configured" check and the EC2 security group (port 22).' },
        { text: 'If it fails at "Health check", look at the PM2 logs on the server:', code: `pm2 logs ${project.name} --lines 100 --nostream` },
      ],
    },
    run: async () => {
      const { status, body } = await github(`/actions/workflows/${workflow}/runs?branch=${config.githubBranch}&per_page=1`);
      if (status === 404) {
        return fail(`Workflow ${workflow} not found on GitHub. Push .github/workflows/${workflow} to ${config.githubBranch}, or set GITHUB_TOKEN if the repo is private.`);
      }
      if (status === 403) return warn('GitHub API rate limit reached; set GITHUB_TOKEN to raise it.', tokenFix);
      if (status !== 200) return fail(`GitHub returned HTTP ${status}.`);

      const latest = body.workflow_runs?.[0];
      if (!latest) return fail('The workflow has never run.');
      const when = new Date(latest.updated_at).toLocaleString('en-GB', { timeZone: 'Europe/Amsterdam' });
      const sha = String(latest.head_sha).slice(0, 7);
      if (latest.status !== 'completed') return warn(`Deploy of ${sha} is ${latest.status} (started ${when}).`);
      if (latest.conclusion === 'success') return ok(`Succeeded ${when} (${sha}).`);
      return fail(`Last run ${latest.conclusion} at ${when} (${sha}): ${latest.html_url}`);
    },
  };
}
