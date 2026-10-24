/**
 * All the words on the site live here. Edit this file to change the copy;
 * the components only decide how it looks.
 */

export type MotifKind = 'horizon' | 'rise' | 'ledger' | 'ripples';

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
  lead: 'I’m Bas Franke, a full-stack engineer with more than twenty years of shipping web platforms, from high-stakes trading systems to the tools that keep them running. Today I pair that experience with AI-assisted, agentic development: moving faster without cutting corners.',
  primary: { label: 'See my work', href: '#work' },
  secondary: { label: 'Get in touch', href: '#contact' },
};

export const about = {
  heading: 'Who I am',
  paragraphs: [
    'I’m a full-stack software engineer with more than twenty years of experience, and I still love the craft. Understanding a problem properly, shaping a solution no bigger than it needs to be, and then looking after it in production: that is the work, and I enjoy every part of it.',
    'I’m at home across the whole stack: C# and Python on the server, JavaScript and TypeScript in the browser, and the infrastructure in between. Part of that work was in fintech, where correctness and uptime are not negotiable, and it shaped how I write software everywhere else.',
    'Lately the way I work has changed as much as the tools. I build with AI at my side: Claude and Claude Code, GitHub Copilot in Visual Studio, Cursor, and agentic workflows that take on whole tasks while I focus on design, review and the decisions that matter.',
  ],
  facts: [
    ['Based in', 'The Netherlands'],
    ['Focus', 'Full-stack web'],
    ['Experience', '20+ years'],
    ['Working with', 'AI-assisted development'],
  ] as [string, string][],
};

export const work = {
  heading: 'Work where the software had to be right.',
};

export const projects: Project[] = [
  {
    slug: 'saxo',
    title: 'Saxo Bank',
    kind: 'Fintech · Trading platform',
    summary:
      'A Danish investment bank built around online trading. Platform work where every release touches real money and live markets, so correctness, speed and uptime are the whole job.',
    tags: ['Fintech', 'Trading', 'High availability'],
    motif: 'rise',
  },
  {
    slug: 'binck',
    title: 'BinckBank',
    kind: 'Fintech · Online broker',
    summary:
      'The Dutch online broker, part of Saxo Bank since 2019. Software for people trading with their own savings: clear interfaces, careful data handling and no surprises.',
    tags: ['Fintech', 'Brokerage', 'Web platform'],
    motif: 'ledger',
  },
  {
    slug: 'irp',
    title: 'IRP',
    kind: 'Confidential',
    summary: 'Some work stays behind closed doors. Ask me about this one in person and I’ll happily tell you more.',
    tags: ['Ask me'],
    motif: 'ripples',
  },
];

export const skills = {
  heading: 'Tools of the trade, old and new.',
  tiers: [
    {
      name: 'Every day',
      note: 'My core tools',
      items: ['C#', 'TypeScript', 'JavaScript', 'HTML & CSS', 'Python'],
    },
    {
      name: 'AI-assisted',
      note: 'How I build now',
      items: [
        'Claude & Claude Code',
        'GitHub Copilot in Visual Studio',
        'Cursor',
        'ChatGPT & Codex',
        'Gemini',
        'Windsurf',
        'Agentic programming',
        'MCP',
      ],
    },
    {
      name: 'Comfortable',
      note: 'Used in production',
      items: ['Java', 'Node.js', 'React', 'Angular', 'Vue', 'C++', 'SQL'],
    },
    {
      name: 'Working knowledge',
      note: 'Enough to be useful',
      items: ['DevOps', 'AWS', 'Design'],
    },
  ],
  principles: [
    {
      title: 'Simple over clever',
      text: 'Code is read far more often than it is written, so I write for the person who comes next. Usually that’s me, six months later.',
    },
    {
      title: 'Own the whole problem',
      text: 'Database, API, interface and the server underneath. When one person can see the whole picture, nothing falls between the cracks.',
    },
    {
      title: 'Ship small, learn fast',
      text: 'Working software early, honest feedback, then refine. Big-bang releases are where the surprises hide.',
    },
    {
      title: 'AI as a colleague, not a crutch',
      text: 'Assistants and agents take the repetitive work and widen what one engineer can deliver. Judgement, taste and responsibility stay with me.',
    },
    {
      title: 'Calm under pressure',
      text: 'Incidents are solved with method, not panic: measure, isolate, fix, and make sure it can’t happen again.',
    },
  ],
};

export const contact = {
  heading: 'Let’s talk.',
  lead: 'A product to build, a platform to steady, or a team that could use a senior pair of hands? My inbox is open, and I read every message myself.',
};

export const footer = {
  note: 'Made with React, Vite and Node, on one small server.',
};
