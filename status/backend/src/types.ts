export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export type Provider = 'name.com' | 'AWS' | 'GitHub' | 'Server' | "Let's Encrypt" | 'Status';

export interface FixStep {
  text: string;
  code?: string;
}

/** Instructions shown on the status page when a check is not ok. */
export interface Fix {
  summary: string;
  steps: FixStep[];
  doc?: string;
}

export interface Outcome {
  status: CheckStatus;
  detail: string;
  /** Overrides the check's default fix for this particular outcome. */
  fix?: Fix;
}

export interface CheckDef {
  id: string;
  title: string;
  provider: Provider;
  fix?: Fix;
  run: () => Promise<Outcome>;
}

export interface CheckResult {
  id: string;
  title: string;
  provider: Provider;
  status: CheckStatus;
  detail: string;
  fix?: Fix;
  durationMs: number;
}

export interface CheckGroup {
  id: string;
  title: string;
  subtitle?: string;
  checks: CheckResult[];
}

export interface Report {
  generatedAt: string;
  durationMs: number;
  summary: Record<CheckStatus, number>;
  groups: CheckGroup[];
}

export interface Project {
  /** Folder name = PM2 process = Nginx site = database name. */
  name: string;
  /** First domain is the primary one; the TLS certificate is named after it. */
  domains: string[];
  port: number;
  database: boolean;
}

export const ok = (detail: string): Outcome => ({ status: 'ok', detail });
export const warn = (detail: string, fix?: Fix): Outcome => ({ status: 'warn', detail, fix });
export const fail = (detail: string, fix?: Fix): Outcome => ({ status: 'fail', detail, fix });
export const skip = (detail: string, fix?: Fix): Outcome => ({ status: 'skip', detail, fix });
