import { Resolver } from 'node:dns/promises';
import { config, elasticIp, repoDoc, statusEnvFile } from '../config.js';
import { fail, ok, warn, type CheckDef, type Fix, type Project } from '../types.js';
import { errorMessage } from '../util.js';

// Ask public resolvers so we see what the rest of the world sees, not a local cache.
const resolver = new Resolver({ timeout: 3000, tries: 2 });
resolver.setServers(['1.1.1.1', '8.8.8.8']);

/** "www.inck.ai" → "inck.ai". Good enough for the TLDs we use (no .co.uk style suffixes). */
export const rootOf = (domain: string) => domain.split('.').slice(-2).join('.');

const hostLabel = (domain: string) => {
  const root = rootOf(domain);
  return domain === root ? '' : domain.slice(0, -(root.length + 1));
};

function dnsFix(domain: string, registrar: string): Fix {
  const root = rootOf(domain);
  const label = hostLabel(domain);
  const record =
    label === 'www'
      ? `Add a record: Type CNAME, Host "www", Answer "${root}", TTL 300.`
      : `Add a record: Type A, Host "${label || '(leave empty)'}", Answer "${elasticIp()}", TTL 300.` +
        (label ? ' Alternatively, one wildcard A record with Host "*" covers every subdomain.' : '');

  return {
    summary: `Point ${domain} at the server's Elastic IP at ${registrar}.`,
    steps: [
      { text: `Log in to ${registrar} and open the DNS records for ${root}.` },
      {
        text: label
          ? `Delete any existing record with Host "${label}" that does not point at ${elasticIp()}.`
          : `Delete the registrar's default parking records for the root (empty Host), and turn off URL forwarding for ${root}.`,
      },
      { text: record },
      { text: 'Wait a few minutes, then verify from any machine:', code: `nslookup ${domain} 1.1.1.1` },
    ],
    doc: repoDoc('infra/README.md#5-namecom-dns'),
  };
}

const expectedIpFix: Fix = {
  summary: 'Tell the status page which IP the domains should resolve to.',
  steps: [
    { text: 'Find the Elastic IP in AWS → EC2 → Elastic IPs.' },
    { text: `Add it to ${statusEnvFile} on the server:`, code: `echo "EXPECTED_IP=<elastic-ip>" >> ${statusEnvFile}` },
    { text: 'Restart the status backend:', code: 'pm2 restart status --update-env' },
  ],
};

export function dnsCheck(project: Project, domain: string): CheckDef {
  return {
    id: `dns:${domain}`,
    title: `DNS record for ${domain}`,
    provider: 'name.com',
    fix: dnsFix(domain, project.registrar ?? 'name.com'),
    run: async () => {
      let addresses: string[];
      try {
        addresses = await resolver.resolve4(domain);
      } catch (err) {
        return fail(`${domain} does not resolve: ${errorMessage(err)}`);
      }
      const list = addresses.join(', ');
      if (!config.expectedIp) {
        return warn(`Resolves to ${list}, but EXPECTED_IP is not set so it cannot be verified.`, expectedIpFix);
      }
      if (!addresses.includes(config.expectedIp)) {
        return fail(`Resolves to ${list} instead of ${config.expectedIp}.`);
      }
      if (addresses.length > 1) {
        return warn(`Resolves to ${list}: remove the records that are not ${config.expectedIp}.`);
      }
      return ok(`Resolves to ${config.expectedIp}.`);
    },
  };
}

export const expectedIpCheck: CheckDef = {
  id: 'config:expected-ip',
  title: 'Elastic IP configured for monitoring',
  provider: 'Status',
  fix: expectedIpFix,
  run: async () =>
    config.expectedIp ? ok(`EXPECTED_IP=${config.expectedIp}`) : fail('EXPECTED_IP is not set in the status .env file.'),
};
