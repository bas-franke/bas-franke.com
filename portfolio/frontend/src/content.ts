/**
 * All the words on the site live here. Edit this file to change the copy;
 * the components only decide how it looks.
 */

export interface Experience {
  /** Also the logo filename: src/art/logos/<slug>.png. */
  slug: string;
  company: string;
  role: string;
  /** e.g. 'Dec 2023 – present'. Leave out for things that are not a job: those become a quiet line after the list. */
  period?: string;
  location?: string;
  summary: string;
  tags: string[];
  href?: string;
  /** The job Bas holds now; it gets the most weight in the list. */
  current?: boolean;
}

export const site = {
  name: 'Bas Franke',
  location: 'Amsterdam, the Netherlands',
  email: 'bas.franke.89@gmail.com',
  phone: '06 208 388 09',
  phoneHref: 'tel:+31620838809',
  url: 'https://bas-franke.com',
};

export const nav = {
  skip: 'Skip to content',
  top: 'back to top',
  sections: 'Sections',
  menu: 'Menu',
  links: [
    { id: 'about', label: 'About' },
    { id: 'work', label: 'Work' },
    { id: 'skills', label: 'Skills' },
    { id: 'contact', label: 'Contact' },
  ],
  theme: { light: 'Switch to light mode', dark: 'Switch to dark mode' },
};

export const hero = {
  label: 'Introduction',
  eyebrow: 'Head of Development · 20+ years · Amsterdam',
  title: 'Software that works,',
  titleEm: 'and keeps working.',
  lead: 'I’m Bas Franke, and I’ve spent twenty-plus years shipping web platforms, from a broker’s trading systems to the rental platform I now lead at GoHome.io. These days I build with AI at my side: faster, without cutting corners.',
  work: { label: 'See my work', href: '#work' },
};

export const about = {
  statement:
    'I still love the craft: understanding a problem properly, shaping a solution no bigger than it needs to be, then looking after it in production.',
  paragraphs: [
    'I’m at home across the stack: C#, Java and Python on the server, JavaScript and TypeScript in the browser, SQL underneath, and the infrastructure in between. Four years as tech lead at online brokers taught me that correctness and uptime are not negotiable; the proptech and loyalty platforms since taught me to move fast without losing that.',
    'Lately the way I work has changed as much as the tools. I build with Claude and Claude Code, GitHub Copilot in Visual Studio, Cursor, and agentic workflows that take on whole tasks while I focus on design, review and the final call.',
  ],
  facts: [
    ['Based in', 'Amsterdam area'],
    ['Right now', 'Head of Development, GoHome.io'],
    ['Experience', '20+ years'],
    ['Working with', 'AI-assisted development'],
  ] as [string, string][],
  portraitAlt: `Portrait of ${site.name}`,
};

export const work = {
  heading: 'Where I’ve worked,',
  headingEm: 'and what I built there.',
  newTab: '(opens in a new tab)',
  tagsLabel: 'Skills used',
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
    current: true,
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
  },
  {
    slug: 'irp',
    company: 'IRP',
    role: 'Confidential project',
    summary: 'Some work stays behind closed doors; ask me about this one in person.',
    tags: ['Ask me'],
  },
];

export const skills = {
  approach: 'How I work.',
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
      text: 'Incidents are solved by method: measure, isolate, fix, and make sure it can’t happen again.',
    },
  ],
};

/**
 * Pictures between the sections, each with one quiet line, each in its own layout so the page
 * doesn't repeat itself (InterludeBand, InterludeSplit, InterludeArch). The image is
 * src/art/interlude-<name>.webp (see ART.md).
 */
export const interludes = {
  morning: {
    line: 'Most good work starts quietly: a clear morning, a hot coffee, and a problem worth understanding.',
    alt: 'A desk by a window in soft morning light, with a laptop, a notebook and a cup of coffee.',
  },
  evening: {
    line: 'And the best software is the kind nobody has to think about at the end of the day.',
    alt: 'A canal in the evening with warm light in the windows of old houses.',
  },
  fireside: {
    line: 'Pull up a chair.',
    alt: 'A reading chair by a lamp on a quiet evening, with a blanket and a cup of tea.',
  },
};

export const contact = {
  heading: 'Let’s talk.',
  lead: 'A product to build, a platform to steady, or a team that could use a senior pair of hands? My inbox is open, and I read every message myself.',
  phone: 'Phone',
  form: {
    title: 'Or leave a note here.',
    name: 'Name',
    email: 'E-mail',
    message: 'Message',
    trap: 'Leave this empty',
    send: 'Send message',
    sendInApp: 'Open in your mail app',
    sending: 'Sending…',
    subject: 'A message from',
    sentTitle: 'Thank you.',
    sent: 'Your message is on its way. I’ll get back to you soon.',
    opened: 'Your mail app should now open with this message. Nothing happened? Write to',
    invalid: 'Please add your name, a valid e-mail address and a short message.',
    failed: 'That didn’t go through.',
    orEmail: 'You can also reach me at',
  },
};

/** The PDF résumé (see src/resume.ts) is built from this plus the sections above. */
export const resume = {
  fileName: 'Bas-Franke-Resume.pdf',
  button: {
    download: 'Download résumé',
    short: 'Résumé',
    busy: 'Preparing…',
    failed: 'Try again',
    hint: 'Download my résumé as a PDF',
  },
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
  top: 'Back to morning',
};
