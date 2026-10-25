import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { config, repoDoc, statusEnvFile } from '../config.js';
import { projects } from '../projects.js';
import { fail, ok, skip, type CheckDef, type Fix, type Project } from '../types.js';
import { errorMessage } from '../util.js';

const rdsDoc = repoDoc('infra/README.md#6-aws-rds-only-when-the-first-project-needs-a-database');

const createRdsFix: Fix = {
  summary: 'Create the shared RDS PostgreSQL instance and tell the status page where it is.',
  steps: [
    { text: 'AWS → EC2 → Security Groups → Create "rds-sg" with one inbound rule: PostgreSQL (5432), source = security group "web-sg".' },
    {
      text: 'AWS → RDS → Create database: PostgreSQL, identifier "bas-franke-db", master user "postgres", db.t4g.micro, same VPC as the EC2 instance, Public access: No, security group "rds-sg".',
    },
    { text: `Copy the endpoint and add it to ${statusEnvFile}:`, code: `echo "RDS_HOST=<endpoint>" >> ${statusEnvFile}\npm2 restart status --update-env` },
  ],
  doc: rdsDoc,
};

export const rdsCheck: CheckDef = {
  id: 'rds:reachable',
  title: 'RDS instance reachable',
  provider: 'AWS',
  fix: {
    summary: 'The EC2 instance cannot open a connection to RDS on port 5432.',
    steps: [
      { text: 'AWS → RDS → bas-franke-db: check Status is "Available" and copy the endpoint into RDS_HOST.' },
      { text: 'Its security group "rds-sg" must allow PostgreSQL (5432) from security group "web-sg".' },
      { text: 'RDS and EC2 must be in the same VPC. Test from the server:', code: `nc -zv ${config.rdsHost ?? '<endpoint>'} ${config.rdsPort}` },
    ],
    doc: rdsDoc,
  },
  run: async () => {
    if (!config.rdsHost) {
      const needing = projects.filter((p) => p.database).map((p) => p.name);
      return needing.length
        ? fail(`RDS_HOST is not set, but ${needing.join(', ')} need a database.`, createRdsFix)
        : skip('No project uses a database yet. Set RDS_HOST once you create the RDS instance.', createRdsFix);
    }
    const host = config.rdsHost;
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect({ host, port: config.rdsPort, timeout: 3000 }, () => {
        socket.end();
        resolve();
      });
      socket.on('timeout', () => {
        socket.destroy();
        reject(new Error(`Timed out connecting to port ${config.rdsPort}; usually a security group problem.`));
      });
      socket.on('error', reject);
    });
    return ok(`Port ${config.rdsPort} is reachable.`);
  },
};

export function databaseFix(project: Project): Fix {
  const db = project.name.replaceAll('-', '_');
  return {
    summary: `Create the "${db}" database and user in RDS and store the connection string on the server.`,
    steps: [
      {
        text: `Easiest: with the RDS master password stored as GitHub secret RDS_MASTER_PASSWORD, run the "Provision databases" workflow (Actions → Provision databases → Run workflow, projects "${project.name}"). Or by hand:`,
      },
      { text: 'On the server, connect as the master user:', code: `psql "host=${config.rdsHost ?? '<endpoint>'} user=postgres dbname=postgres sslmode=require"` },
      { text: 'Create the user and database:', code: `CREATE USER ${db} WITH PASSWORD '<strong-password>';\nCREATE DATABASE ${db} OWNER ${db};\nREVOKE ALL ON DATABASE ${db} FROM PUBLIC;` },
      {
        text: `Add the connection string to ${config.appsDir}/${project.name}/.env and restart the app:`,
        code: `echo "DATABASE_URL=postgres://${db}:<password>@${config.rdsHost ?? '<endpoint>'}:5432/${db}?sslmode=require" >> ${config.appsDir}/${project.name}/.env\npm2 restart ${project.name} --update-env`,
      },
    ],
    doc: repoDoc('.claude/docs/adding-a-project.md#2-database-only-if-needed'),
  };
}

export function databaseCheck(project: Project): CheckDef {
  const envPath = `${config.appsDir}/${project.name}/.env`;
  return {
    id: `db:${project.name}`,
    title: 'Database connection',
    provider: 'AWS',
    fix: databaseFix(project),
    run: async () => {
      let url: string | undefined;
      try {
        url = parseEnv(await readFile(envPath, 'utf8')).DATABASE_URL;
      } catch {
        return fail(`Cannot read ${envPath}.`);
      }
      if (!url) return fail(`DATABASE_URL is not set in ${envPath}.`);

      // Strip sslmode so our ssl option applies: RDS uses TLS with an Amazon CA we don't bundle here.
      const parsed = new URL(url);
      parsed.searchParams.delete('sslmode');
      const client = new pg.Client({ connectionString: parsed.toString(), ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 4000 });
      try {
        await client.connect();
        const { rows } = await client.query<{ db: string; size: string }>(
          'SELECT current_database() AS db, pg_size_pretty(pg_database_size(current_database())) AS size',
        );
        return ok(`Connected to "${rows[0].db}" (${rows[0].size}) as ${parsed.username}.`);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === '28P01') return fail(`Wrong password for user "${parsed.username}".`);
        if (code === '3D000') return fail(`Database "${parsed.pathname.slice(1)}" does not exist.`);
        return fail(`Cannot connect: ${errorMessage(err)}`);
      } finally {
        await client.end().catch(() => {});
      }
    },
  };
}
