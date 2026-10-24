/**
 * All the words on the site live here. Edit this file to change the copy;
 * the components only decide how it looks.
 */

export type MotifKind = 'horizon' | 'rise' | 'ledger' | 'ripples' | 'drop' | 'pulse' | 'fold';

export interface Project {
  /** Also the artwork filename: src/art/work-<slug>.webp (see ART.md). */
  slug: string;
  title: string;
  kind: string;
  summary: string;
  tags: string[];
  href?: string;
  /** Procedural line drawing shown until the artwork exists. */
  motif: MotifKind;
}

export const site = {
  name: 'Bas Franke',
  role: 'Software engineer',
  location: 'The Netherlands',
  email: 'bas.franke.89@gmail.com',
  phone: '06 208 388 09',
  phoneHref: 'tel:+31620838809',
  url: 'https://bas-franke.com',
};

export const hero = {
  eyebrow: 'Full-stack software engineer · The Netherlands',
  title: 'Software that works,',
  titleEm: 'and keeps working.',
  lead: 'I’m Bas Franke. For more than twenty years I have designed, built and looked after web platforms, from online trading systems to a magazine written entirely by AI.',
  primary: { label: 'See my work', href: '#work' },
  secondary: { label: 'Get in touch', href: '#contact' },
};

export const about = {
  heading: 'Who I am',
  paragraphs: [
    'I’m a passionate full-stack software engineer with more than twenty years of development experience. I like the whole of the craft: understanding a problem properly, shaping a solution that is no bigger than it needs to be, and then looking after it in production.',
    'I’m most at home across the entire stack: C# and Python on the server, JavaScript in the browser, and the infrastructure that keeps everything running. Good code, to me, is code that is simple to reason about, easy to change and quietly reliable.',
    'Outside of work I build things of my own. The latest is inck.ai, a magazine written and illustrated by AI, which runs on the same small server as this site.',
  ],
  facts: [
    ['Based in', 'The Netherlands'],
    ['Focus', 'Full-stack web'],
    ['Experience', '20+ years'],
    ['Right now', 'Building inck.ai'],
  ] as [string, string][],
};

export const projects: Project[] = [
  {
    slug: 'saxo',
    title: 'Saxo Bank',
    kind: 'Fintech · Trading platform',
    summary:
      'Danish investment bank specialised in online trading and investment. Platform development for a system where correctness and uptime are not optional.',
    tags: ['Fintech', 'Trading', 'High availability'],
    motif: 'rise',
  },
  {
    slug: 'binck',
    title: 'BinckBank',
    kind: 'Fintech · Online broker',
    summary:
      'Dutch online broker, part of Saxo Bank since 2019. Software for people who trade with their own money, which means every detail matters.',
    tags: ['Fintech', 'Brokerage', 'Web platform'],
    motif: 'ledger',
  },
  {
    slug: 'irp',
    title: 'IRP',
    kind: 'Confidential',
    summary: 'A project I can’t show here. I’m happy to tell you about it in person.',
    tags: ['Ask me'],
    motif: 'ripples',
  },
  {
    slug: 'inck',
    title: 'inck.ai',
    kind: 'Side project · AI magazine',
    summary:
      'An automated magazine. Every hour it picks a topic, has an AI write a genuinely interesting article with real data charts, paints a hero illustration and publishes it.',
    tags: ['TypeScript', 'React', 'Node', 'PostgreSQL', 'OpenAI'],
    href: 'https://inck.ai',
    motif: 'drop',
  },
  {
    slug: 'status',
    title: 'status.bas-franke.com',
    kind: 'Side project · Infrastructure',
    summary:
      'A self-checking status page for the server behind these sites: DNS, TLS, deploys, processes and databases, each check paired with the instructions to fix it.',
    tags: ['TypeScript', 'React', 'Node', 'AWS', 'Nginx'],
    href: 'https://status.bas-franke.com',
    motif: 'pulse',
  },
  {
    slug: 'portfolio',
    title: 'This site',
    kind: 'Side project · Portfolio',
    summary:
      'A quiet place to put my work. React and Vite in front, a small Node backend behind, deployed by GitHub Actions to a single EC2 instance.',
    tags: ['React', 'Vite', 'Node', 'GitHub Actions'],
    motif: 'fold',
  },
];

export const skills = {
  tiers: [
    { name: 'Every day', note: 'My core tools', items: ['C#', 'HTML & CSS', 'JavaScript', 'Python'] },
    {
      name: 'Comfortable',
      note: 'Used in production',
      items: ['Java', 'TypeScript', 'Node.js', 'React', 'Angular', 'Vue', 'C++'],
    },
    { name: 'Working knowledge', note: 'Enough to be useful', items: ['DevOps', 'AWS', 'Design'] },
  ],
  principles: [
    {
      title: 'Simple over clever',
      text: 'Code is read far more often than it is written. I optimise for the next person who has to understand it, who is usually me.',
    },
    {
      title: 'The whole stack, the whole problem',
      text: 'Database, API, interface and the server underneath: I’m comfortable owning all of it, so nothing falls between the cracks.',
    },
    {
      title: 'Small steps, shipped often',
      text: 'Working software early, honest feedback, then refine. Big-bang releases are where the surprises live.',
    },
    {
      title: 'Calm under pressure',
      text: 'Incidents are solved with method, not panic. Measure, isolate, fix, and then make sure it can’t happen again.',
    },
  ],
};

export const contact = {
  heading: 'Let’s talk.',
  lead: 'A project, a question, or just a hello: my inbox is open and I read every message.',
};

export const footer = {
  note: 'Made with React, Vite and Node, on one small server.',
};
