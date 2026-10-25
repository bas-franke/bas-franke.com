import { config, statusEnvFile } from '../config.js';
import { projects } from '../projects.js';
import { ok, warn, type CheckDef, type Project } from '../types.js';
import { analyticsCheck } from './analytics.js';
import { screenshotsCheck } from './screenshots.js';
import { databaseCheck, rdsCheck } from './database.js';
import { dnsCheck, expectedIpCheck } from './dns.js';
import { ec2InstanceCheck, elasticIpCheck, resourcesCheck } from './ec2.js';
import { deployRunCheck, secretsCheck } from './github.js';
import {
  backendHealthCheck,
  certbotTimerCheck,
  deployedFilesCheck,
  envFileCheck,
  nginxCheck,
  nginxSiteCheck,
  nodeCheck,
  pm2Check,
  pm2ProcessCheck,
} from './server.js';
import { publicApiCheck, siteCheck, tlsCheck, websocketCheck } from './web.js';

const accessCheck: CheckDef = {
  id: 'status:auth',
  title: 'Status page is password protected',
  provider: 'Status',
  fix: {
    summary: 'The status page shows details about your infrastructure. Protect it with a password.',
    steps: [{ text: 'On the server:', code: `echo "STATUS_PASSWORD=<choose-a-password>" >> ${statusEnvFile}\npm2 restart status --update-env` }],
  },
  run: async () =>
    config.statusPassword ? ok(`Login required for user "${config.statusUser}".`) : warn('Anyone can view this page.'),
};

export interface GroupDef {
  id: string;
  title: string;
  subtitle?: string;
  checks: CheckDef[];
}

/** Ordered roughly in setup order, so the first failing check is usually the next thing to do. */
export const sharedChecks: CheckDef[] = [
  ec2InstanceCheck,
  expectedIpCheck,
  elasticIpCheck,
  nginxCheck,
  certbotTimerCheck,
  pm2Check,
  nodeCheck,
  resourcesCheck,
  secretsCheck,
  rdsCheck,
  accessCheck,
  analyticsCheck,
  screenshotsCheck,
];

export function projectChecks(project: Project): CheckDef[] {
  return [
    ...project.domains.map((d) => dnsCheck(project, d)),
    deployRunCheck(project),
    deployedFilesCheck(project),
    envFileCheck(project),
    pm2ProcessCheck(project),
    backendHealthCheck(project),
    ...project.domains.map((d) => tlsCheck(project, d)),
    nginxSiteCheck(project),
    siteCheck(project),
    publicApiCheck(project),
    ...(project.websocket ? [websocketCheck(project)] : []),
    ...(project.database ? [databaseCheck(project)] : []),
  ];
}

export function allGroups(): GroupDef[] {
  return [
    { id: 'shared', title: 'Shared infrastructure', subtitle: 'EC2, server, GitHub, RDS', checks: sharedChecks },
    ...projects.map((p) => ({
      id: p.name,
      title: p.name,
      subtitle: `${p.domains.join(', ')} · port ${p.port}${p.database ? ' · database' : ''}`,
      checks: projectChecks(p),
    })),
  ];
}
