/**
 * All the words on the site live here. Edit this file to change the copy;
 * the components only decide how it looks.
 */

export type MotifKind = 'horizon' | 'rise' | 'ledger' | 'ripples' | 'drop' | 'pulse' | 'fold';

export interface Experience {
  /** Also the artwork and logo filenames: src/art/work-<slug>.webp and src/art/logos/<slug>.png (see ART.md). */
  slug: string;
  company: string;
  role: string;
  /** e.g. 'Dec 2023 – present'. Leave out for things that are not a job. */
  period?: string;
  location?: string;
  summary: string;
  tags: string[];
  href?: string;
  /** Procedural line drawing shown until the artwork exists. */
  motif: MotifKind;
}

export const site = {
  name: 'Bas Franke',
  role: 'Software engineer',
  location: 'Amsterdam, the Netherlands',
  email: 'bas.franke.89@gmail.com',
  phone: '06 208 388 09',
  phoneHref: 'tel:+31620838809',
  url: 'https://bas-franke.com',
};

export const hero = {
  eyebrow: 'Full-stack software engineer · Amsterdam',
  title: 'Software that works,',
  titleEm: 'and keeps working.',
  lead: 'I’m Bas Franke, a full-stack engineer with twenty-plus years of shipping web platforms, from a broker’s trading systems to the rental platform I now lead as Head of Development at GoHome.io. I pair that experience with AI-assisted, agentic development: faster, without cutting corners.',
  primary: { label: 'See my work', href: '#work' },
  secondary: { label: 'Get in touch', href: '#contact' },
};

export const about = {
  heading: 'Who I am',
  paragraphs: [
    'I’m a full-stack software engineer with more than twenty years of experience, and I still love the craft. Understanding a problem properly, shaping a solution no bigger than it needs to be, and then looking after it in production: that is the work, and I enjoy every part of it.',
    'I’m at home across the whole stack: C#, Java and Python on the server, JavaScript and TypeScript in the browser, SQL underneath, and the infrastructure in between. Four years as tech lead at online brokers taught me that correctness and uptime are not negotiable; the proptech and loyalty platforms since then taught me how to move fast without losing that.',
    'Lately the way I work has changed as much as the tools. I build with AI at my side: Claude and Claude Code, GitHub Copilot in Visual Studio, Cursor, and agentic workflows that take on whole tasks while I focus on design, review and the decisions that matter.',
  ],
  facts: [
    ['Based in', 'Amsterdam area'],
    ['Right now', 'Head of Development, GoHome.io'],
    ['Experience', '20+ years'],
    ['Working with', 'AI-assisted development'],
  ] as [string, string][],
};

export const work = {
  heading: 'Where I’ve worked, and what I built there.',
};

export const experience: Experience[] = [
  {
    slug: 'gohome',
    company: 'GoHome.io',
    role: 'Head of Development',
    period: 'Dec 2023 – present',
    location: 'Amsterdam',
    summary:
      'Amsterdam proptech that turns renting out a home into one platform: advertising, tenant screening, pricing and management. I lead development: the team, the architecture and the engineering side of the roadmap, for a product that automates most of the leasing process.',
    tags: ['Java', 'React', 'Architecture', 'Team lead'],
    href: 'https://gohome.io',
    motif: 'fold',
  },
  {
    slug: 'transparent',
    company: 'Transparent',
    role: 'Software Engineer',
    period: 'Apr 2022 – Dec 2023',
    location: 'Amstelveen',
    summary:
      'Procure-to-pay specialists whose software finds overpayments, duplicate invoices and unclaimed money in the accounts payable of large companies. I worked on the SQL-heavy analysis engine and the DevOps around it: pipelines, environments and the automation that lets a small team process very large datasets reliably.',
    tags: ['SQL', 'DevOps', 'Data', 'Automation'],
    href: 'https://www.transparent.eu',
    motif: 'ledger',
  },
  {
    slug: 'piggy',
    company: 'Piggy',
    role: 'Software Engineer',
    period: 'Oct 2020 – May 2022',
    location: 'Maarssen',
    summary:
      'Loyalty platform used by thousands of businesses to run their own rewards programmes. I built customer-facing features across the React front end and PHP back end, in a product where every change ships to a lot of shops at once.',
    tags: ['React', 'PHP', 'SaaS', 'Loyalty'],
    href: 'https://www.piggy.eu',
    motif: 'drop',
  },
  {
    slug: 'saxo',
    company: 'Saxo Bank',
    role: 'Tech Lead',
    period: 'Aug 2019 – Oct 2020',
    location: 'Amsterdam',
    summary:
      'Danish investment bank and specialist in online trading and investing, with a large platform for private investors in the Netherlands. As tech lead in Amsterdam I was responsible for the engineering of the Dutch trading platform, from architecture and releases to incidents, keeping a high-volume system correct, fast and available.',
    tags: ['C#', 'SQL', 'Trading', 'Architecture', 'Tech lead'],
    href: 'https://www.home.saxo',
    motif: 'pulse',
  },
  {
    slug: 'binck',
    company: 'BinckBank',
    role: 'Tech Lead',
    period: 'Nov 2016 – Aug 2019',
    location: 'Amsterdam',
    summary:
      'Dutch online broker for private investors. As tech lead I was responsible for the engineering behind its trading platform: the C# and SQL systems underneath, the AngularJS front end on top, and the engineers who built and ran them, in a business where correctness, speed and uptime are the whole job.',
    tags: ['C#', 'SQL', 'AngularJS', 'Trading', 'Tech lead'],
    motif: 'rise',
  },
  {
    slug: 'irp',
    company: 'IRP',
    role: 'Confidential project',
    summary: 'Some work stays behind closed doors. Ask me about this one in person and I’ll happily tell you more.',
    tags: ['Ask me'],
    motif: 'ripples',
  },
];

export const skills = {
  heading: 'Tools of the trade, old and new.',
  /** `level` runs from 1 (working knowledge) to 4 (every day); the résumé draws it as a meter. */
  tiers: [
    {
      name: 'Every day',
      note: 'My core tools',
      level: 4,
      items: ['C#', 'Java', 'TypeScript', 'JavaScript', 'HTML & CSS', 'SQL'],
    },
    {
      name: 'AI-assisted',
      note: 'How I build now',
      level: 4,
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
      level: 3,
      items: ['Python', 'PHP', 'Node.js', 'React', 'Angular', 'Vue', 'C++'],
    },
    {
      name: 'Working knowledge',
      note: 'Enough to be useful',
      level: 2,
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

/** The PDF résumé (see src/resume.ts) is built from this plus the sections above. */
export const resume = {
  fileName: 'Bas-Franke-Resume.pdf',
  title: 'Head of Development · Full-stack software engineer',
  summary:
    'Full-stack software engineer and engineering lead with more than twenty years of experience designing, building and running web platforms: the trading platforms of two online brokers, a loyalty platform used by thousands of businesses, procure-to-pay analytics, and today the rental platform GoHome.io as Head of Development. Comfortable owning the whole stack, from database and API to interface and infrastructure, and working with AI-assisted, agentic development to deliver more with the same care.',
  sections: {
    profile: 'Profile',
    experience: 'Experience',
    skills: 'Skills',
    approach: 'How I work',
  },
};

export const footer = {
  note: 'Made with React, Vite and Node, on one small server.',
};
