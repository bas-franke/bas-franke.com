import os from 'node:os';
import { config, repoDoc } from '../config.js';
import { fail, ok, warn, type CheckDef, type Project } from '../types.js';
import { exists, memo, run, runLoose } from '../util.js';

const bootstrapStep = {
  text: 'Run the bootstrap script on the server (safe to re-run):',
  code: 'bash ~/ec2-bootstrap.sh',
};
const bootstrapDoc = repoDoc('infra/README.md#2-server-bootstrap');

interface Pm2Process {
  name: string;
  pm2_env: { status: string; restart_time: number; pm_uptime: number };
  monit?: { memory: number };
}

const pm2List = memo(async () => JSON.parse(await run('pm2', ['jlist'])) as Pm2Process[], 5000);

const systemdActive = async (unit: string) => (await runLoose('systemctl', ['is-active', unit])) === 'active';

export const nginxCheck: CheckDef = {
  id: 'server:nginx',
  title: 'Nginx running with the shared port-80 site',
  provider: 'Server',
  fix: {
    summary: 'Nginx is not installed, not running, or the shared catch-all site is missing.',
    steps: [bootstrapStep, { text: 'Check the configuration and logs:', code: 'sudo nginx -t\nsudo journalctl -u nginx -n 50' }],
    doc: bootstrapDoc,
  },
  run: async () => {
    if (!(await systemdActive('nginx'))) return fail('The nginx service is not active.');
    if (!(await exists(`${config.nginxSitesDir}/00-default`))) return fail('Nginx runs, but the 00-default site (ACME + HTTPS redirect) is not enabled.');
    return ok('nginx active, 00-default enabled');
  },
};

export const certbotTimerCheck: CheckDef = {
  id: 'server:certbot-timer',
  title: 'Certificate auto-renewal',
  provider: "Let's Encrypt",
  fix: {
    summary: 'The certbot renewal timer is not active, so certificates will expire after 90 days.',
    steps: [{ text: 'Enable it:', code: 'sudo systemctl enable --now certbot.timer' }, bootstrapStep],
    doc: bootstrapDoc,
  },
  run: async () => ((await systemdActive('certbot.timer')) ? ok('certbot.timer active') : fail('certbot.timer is not active.')),
};

export const nodeCheck: CheckDef = {
  id: 'server:node',
  title: 'Node.js version',
  provider: 'Server',
  fix: {
    summary: 'The server should run Node.js 24 LTS, the same version CI builds with.',
    steps: [bootstrapStep],
    doc: bootstrapDoc,
  },
  run: async () => {
    const major = Number(process.versions.node.split('.')[0]);
    return major >= 24 ? ok(`Node.js ${process.version}`) : warn(`Node.js ${process.version}, expected 24 or newer.`);
  },
};

export const pm2Check: CheckDef = {
  id: 'server:pm2',
  title: 'PM2 starts apps on boot',
  provider: 'Server',
  fix: {
    summary: 'PM2 is missing or not registered as a system service, so apps will not come back after a reboot.',
    steps: [
      bootstrapStep,
      { text: 'Or register it manually and save the current process list:', code: `sudo env PATH="$PATH" pm2 startup systemd -u ${os.userInfo().username} --hp ${os.homedir()}\npm2 save` },
    ],
    doc: bootstrapDoc,
  },
  run: async () => {
    const list = await pm2List();
    const unit = `pm2-${os.userInfo().username}`;
    const enabled = (await runLoose('systemctl', ['is-enabled', unit])) === 'enabled';
    const summary = `${list.length} process(es) managed`;
    return enabled ? ok(`${summary}, ${unit} enabled`) : fail(`${summary}, but ${unit} is not enabled on boot.`);
  },
};

export function nginxSiteCheck(project: Project): CheckDef {
  return {
    id: `nginx-site:${project.name}`,
    title: `Nginx site "${project.name}" enabled`,
    provider: 'Server',
    fix: {
      summary: `Install ${project.name}/deploy/nginx.conf as an Nginx site. The certificate must exist first.`,
      steps: [
        { text: 'From your machine, in the repo folder:', code: `scp -i bas-franke-ec2.pem ${project.name}/deploy/nginx.conf ubuntu@<elastic-ip>:~/${project.name}.nginx.conf` },
        {
          text: 'On the server:',
          code: `sudo mv ~/${project.name}.nginx.conf /etc/nginx/sites-available/${project.name}\nsudo ln -sf /etc/nginx/sites-available/${project.name} /etc/nginx/sites-enabled/${project.name}\nsudo nginx -t && sudo systemctl reload nginx`,
        },
      ],
      doc: repoDoc(`${project.name}/README.md#first-time-server-setup`),
    },
    run: async () =>
      (await exists(`${config.nginxSitesDir}/${project.name}`))
        ? ok(`${config.nginxSitesDir}/${project.name}`)
        : fail(`${config.nginxSitesDir}/${project.name} does not exist.`),
  };
}

export function deployedFilesCheck(project: Project): CheckDef {
  const frontend = `${config.wwwDir}/${project.name}/frontend/index.html`;
  const backend = `${config.appsDir}/${project.name}/backend/dist/index.js`;
  return {
    id: `files:${project.name}`,
    title: 'Frontend and backend deployed',
    provider: 'GitHub',
    fix: {
      summary: 'The deploy workflow has not (successfully) copied the build to the server.',
      steps: [
        { text: 'Create the folders on the server (owned by ubuntu so CI can write):', code: `mkdir -p ${config.wwwDir}/${project.name}/frontend ${config.appsDir}/${project.name}/backend` },
        { text: `GitHub → Actions → "Deploy ${project.name}" → Run workflow, and check that it succeeds.` },
      ],
    },
    run: async () => {
      const missing = [];
      if (!(await exists(frontend))) missing.push(frontend);
      if (!(await exists(backend))) missing.push(backend);
      return missing.length ? fail(`Missing: ${missing.join(', ')}`) : ok('Frontend and backend files are on the server.');
    },
  };
}

export function envFileCheck(project: Project): CheckDef {
  const path = `${config.appsDir}/${project.name}/.env`;
  return {
    id: `env:${project.name}`,
    title: 'Runtime .env file',
    provider: 'Server',
    fix: {
      summary: `Create ${path}. It holds secrets such as DATABASE_URL and is never committed to git.`,
      steps: [{ text: 'On the server:', code: `touch ${path} && chmod 600 ${path}` }],
    },
    run: async () => {
      if (await exists(path)) return ok(path);
      return project.database ? fail(`${path} is missing and this project needs DATABASE_URL.`) : warn(`${path} is missing (optional for this project).`);
    },
  };
}

export function pm2ProcessCheck(project: Project): CheckDef {
  return {
    id: `pm2:${project.name}`,
    title: `PM2 process "${project.name}"`,
    provider: 'Server',
    fix: {
      summary: 'The backend process is not running.',
      steps: [
        { text: 'See why it stopped:', code: `pm2 logs ${project.name} --lines 100 --nostream` },
        { text: 'Start it again (or re-run the deploy workflow):', code: `cd ${config.appsDir}/${project.name}/backend && pm2 startOrReload ecosystem.config.cjs && pm2 save` },
      ],
    },
    run: async () => {
      const proc = (await pm2List()).find((p) => p.name === project.name);
      if (!proc) return fail('Not registered in PM2. It has probably never been deployed.');
      const { status, restart_time, pm_uptime } = proc.pm2_env;
      if (status !== 'online') return fail(`Status is "${status}".`);
      const uptimeMin = Math.round((Date.now() - pm_uptime) / 60_000);
      const memMb = proc.monit ? Math.round(proc.monit.memory / 1024 ** 2) : 0;
      const detail = `online for ${uptimeMin} min, ${memMb} MB, ${restart_time} restarts`;
      return restart_time > 10 && uptimeMin < 10 ? warn(`${detail}: it may be crash-looping.`) : ok(detail);
    },
  };
}

export function backendHealthCheck(project: Project): CheckDef {
  const url = `http://127.0.0.1:${project.port}/api/health`;
  return {
    id: `health:${project.name}`,
    title: `Backend health (port ${project.port})`,
    provider: 'Server',
    fix: {
      summary: `Nothing healthy is answering on port ${project.port}.`,
      steps: [
        { text: 'Fix the PM2 process check first.' },
        { text: `Make sure the backend's PORT is ${project.port} in deploy/ecosystem.config.cjs and that it serves GET /api/health.` },
        { text: 'Test on the server:', code: `curl -i ${url}` },
      ],
    },
    run: async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      return res.ok ? ok(`HTTP ${res.status}`) : fail(`HTTP ${res.status} from ${url}`);
    },
  };
}
