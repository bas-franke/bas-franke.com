import tls from 'node:tls';
import { repoDoc } from '../config.js';
import { fail, ok, warn, type CheckDef, type Fix, type Outcome, type Project } from '../types.js';
import { errorMessage } from '../util.js';

function certFix(project: Project): Fix {
  const domains = project.domains.map((d) => `-d ${d}`).join(' ');
  return {
    summary: `Issue a Let's Encrypt certificate for ${project.domains.join(', ')} and enable the Nginx site.`,
    steps: [
      { text: 'DNS for every domain must already point at the server (see the DNS checks).' },
      {
        text: 'On the server, request the certificate (it renews automatically afterwards):',
        code: `sudo certbot certonly --webroot -w /var/www/letsencrypt ${domains} --deploy-hook "systemctl reload nginx" -m <your-email> --agree-tos -n`,
      },
      { text: `Make sure the Nginx site "${project.name}" is enabled (see the Nginx check), then:`, code: 'sudo nginx -t && sudo systemctl reload nginx' },
    ],
    doc: repoDoc(`${project.name}/README.md#first-time-server-setup`),
  };
}

export function tlsCheck(project: Project, domain: string): CheckDef {
  return {
    id: `tls:${domain}`,
    title: `HTTPS certificate for ${domain}`,
    provider: "Let's Encrypt",
    fix: certFix(project),
    run: () =>
      new Promise<Outcome>((resolve) => {
        const socket = tls.connect({ host: domain, port: 443, servername: domain, rejectUnauthorized: false, timeout: 5000 }, () => {
          const cert = socket.getPeerCertificate();
          const chainError = socket.authorizationError;
          socket.end();
          if (!cert || !cert.valid_to) return resolve(fail('The server did not present a certificate.'));

          const identityError = tls.checkServerIdentity(domain, cert);
          if (identityError) return resolve(fail(`Certificate does not cover ${domain}: ${identityError.message}`));
          if (chainError) return resolve(fail(`Certificate is not trusted: ${chainError}`));

          const days = Math.floor((Date.parse(cert.valid_to) - Date.now()) / 86_400_000);
          if (days < 0) return resolve(fail(`Certificate expired ${-days} days ago.`));
          if (days < 14) {
            return resolve(
              warn(`Certificate expires in ${days} days; automatic renewal may be failing.`, {
                summary: 'Check why certbot did not renew.',
                steps: [
                  { text: 'Test renewal on the server:', code: 'sudo certbot renew --dry-run' },
                  { text: 'Make sure the renewal timer is active:', code: 'systemctl status certbot.timer' },
                ],
              }),
            );
          }
          resolve(ok(`Valid, issued by ${cert.issuer?.O ?? 'unknown'}, expires in ${days} days.`));
        });
        socket.on('timeout', () => {
          socket.destroy();
          resolve(fail(`No answer on ${domain}:443. Is port 443 open in the EC2 security group and is Nginx running?`));
        });
        socket.on('error', (err) => resolve(fail(`Cannot connect to ${domain}:443: ${errorMessage(err)}`)));
      }),
  };
}

export function siteCheck(project: Project): CheckDef {
  const domain = project.domains[0];
  return {
    id: `site:${project.name}`,
    title: `Website https://${domain} loads`,
    provider: 'Server',
    fix: {
      summary: 'The frontend is not being served.',
      steps: [
        { text: 'Fix the DNS, certificate and Nginx checks for this project first.' },
        { text: `Deploy the project: GitHub → Actions → "Deploy ${project.name}" → Run workflow.` },
        { text: 'Check Nginx errors on the server:', code: 'sudo tail -n 50 /var/log/nginx/error.log' },
      ],
    },
    run: async () => {
      const res = await fetch(`https://${domain}/`, { signal: AbortSignal.timeout(5000) });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok) return fail(`HTTP ${res.status} from https://${domain}/`);
      if (!type.includes('text/html')) return warn(`HTTP ${res.status}, but content-type is "${type}".`);
      return ok(`HTTP ${res.status}`);
    },
  };
}

export function publicApiCheck(project: Project): CheckDef {
  const url = `https://${project.domains[0]}/api/health`;
  return {
    id: `public-api:${project.name}`,
    title: `API reachable through Nginx`,
    provider: 'Server',
    fix: {
      summary: `Nginx is not forwarding /api/ to the backend on port ${project.port}.`,
      steps: [
        { text: 'Fix the "Backend health" check first; if that is ok, the Nginx site is missing or wrong.' },
        { text: `Check that the Nginx site has "proxy_pass http://127.0.0.1:${project.port};" in its /api/ location:`, code: `grep proxy_pass /etc/nginx/sites-enabled/${project.name}` },
      ],
    },
    run: async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      return res.ok ? ok(`${url} → HTTP ${res.status}`) : fail(`${url} → HTTP ${res.status}`);
    },
  };
}
