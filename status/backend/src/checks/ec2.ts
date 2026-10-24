import os from 'node:os';
import { statfs } from 'node:fs/promises';
import { config, repoDoc, statusEnvFile } from '../config.js';
import { fail, ok, warn, type CheckDef } from '../types.js';
import { errorMessage, memo } from '../util.js';

const IMDS = 'http://169.254.169.254/latest';

/** Reads instance info from the EC2 instance metadata service (IMDSv2). */
const metadata = memo(async () => {
  const token = await fetch(`${IMDS}/api/token`, {
    method: 'PUT',
    headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '60' },
    signal: AbortSignal.timeout(1500),
  }).then((r) => {
    if (!r.ok) throw new Error(`metadata token request returned HTTP ${r.status}`);
    return r.text();
  });

  const get = async (path: string) => {
    const res = await fetch(`${IMDS}/meta-data/${path}`, {
      headers: { 'X-aws-ec2-metadata-token': token },
      signal: AbortSignal.timeout(1500),
    });
    return res.ok ? (await res.text()).trim() : undefined;
  };

  const [instanceId, instanceType, region, publicIp] = await Promise.all([
    get('instance-id'),
    get('instance-type'),
    get('placement/region'),
    get('public-ipv4'),
  ]);
  return { instanceId, instanceType, region, publicIp };
}, 60_000);

export const ec2InstanceCheck: CheckDef = {
  id: 'ec2:instance',
  title: 'Running on an EC2 instance',
  provider: 'AWS',
  fix: {
    summary: 'The status backend must run on the EC2 instance with instance metadata (IMDSv2) enabled.',
    steps: [
      { text: 'If you have no instance yet, create one: follow "1. AWS: EC2" in the infra guide.' },
      {
        text: 'If it does exist: AWS → EC2 → Instances → select the instance → Actions → Instance settings → Modify instance metadata options → Instance metadata service: Enabled, IMDSv2: Required.',
      },
    ],
    doc: repoDoc('infra/README.md#1-aws-ec2'),
  },
  run: async () => {
    try {
      const m = await metadata();
      return ok(`${m.instanceId} (${m.instanceType}) in ${m.region}`);
    } catch (err) {
      return fail(`Instance metadata is not reachable (${errorMessage(err)}): not running on EC2, or IMDS is disabled.`);
    }
  },
};

export const elasticIpCheck: CheckDef = {
  id: 'ec2:elastic-ip',
  title: 'Instance uses the Elastic IP',
  provider: 'AWS',
  fix: {
    summary: 'Associate an Elastic IP so the public IP survives restarts, and record it for the status page.',
    steps: [
      { text: 'AWS → EC2 → Elastic IPs → Allocate Elastic IP address → Allocate.' },
      { text: 'Select it → Actions → Associate Elastic IP address → choose the instance → Associate.' },
      { text: `Set it in ${statusEnvFile} and restart:`, code: `echo "EXPECTED_IP=<elastic-ip>" >> ${statusEnvFile}\npm2 restart status --update-env` },
    ],
    doc: repoDoc('infra/README.md#1-aws-ec2'),
  },
  run: async () => {
    const { publicIp } = await metadata();
    if (!publicIp) return fail('The instance has no public IPv4 address.');
    if (!config.expectedIp) return warn(`Public IP is ${publicIp}, but EXPECTED_IP is not set.`);
    if (publicIp !== config.expectedIp) return fail(`Public IP is ${publicIp}, expected ${config.expectedIp}.`);
    return ok(`Public IP ${publicIp}`);
  },
};

const resourcesFix = {
  summary: 'The server is running low on resources.',
  steps: [
    { text: 'See what uses disk space:', code: 'sudo du -xh / --max-depth=2 2>/dev/null | sort -h | tail -20' },
    { text: 'Free common space hogs:', code: 'pm2 flush\nsudo journalctl --vacuum-size=200M\nsudo apt-get autoremove -y && sudo apt-get clean' },
    { text: 'Or grow the disk: AWS → EC2 → Volumes → Modify volume, then on the server:', code: 'sudo growpart /dev/nvme0n1 1 && sudo resize2fs /dev/nvme0n1p1' },
    { text: 'For memory, check `pm2 status` for a process using too much, or move to a larger instance type.' },
  ],
};

export const resourcesCheck: CheckDef = {
  id: 'ec2:resources',
  title: 'Disk and memory',
  provider: 'Server',
  fix: resourcesFix,
  run: async () => {
    const fs = await statfs('/');
    const diskUsed = 1 - fs.bavail / fs.blocks;
    const memUsed = 1 - os.freemem() / os.totalmem();
    const diskFreeGb = (fs.bavail * fs.bsize) / 1024 ** 3;
    const detail = `Disk ${Math.round(diskUsed * 100)}% used (${diskFreeGb.toFixed(1)} GB free), memory ${Math.round(memUsed * 100)}% used, load ${os.loadavg()[0].toFixed(2)}`;
    if (diskUsed > 0.9) return fail(detail);
    if (diskUsed > 0.8 || memUsed > 0.9) return warn(detail);
    return ok(detail);
  },
};
