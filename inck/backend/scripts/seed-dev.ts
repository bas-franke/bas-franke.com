// Local development only: fills the dev database with a few made-up stories so the feed, hubs and admin can be
// worked on without an OpenAI key. Run with the dev database up: `npm run seed:dev` (needs .env.local).
// Never run against production: it refuses unless the database host is localhost.
import pg from 'pg';

const url = process.env.DATABASE_URL ?? 'postgres://inck:inck@localhost:5433/inck?sslmode=disable';
if (!/localhost|127\.0\.0\.1/.test(url)) {
  console.error('seed-dev only runs against a local database');
  process.exit(1);
}
const u = new URL(url);
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString() });

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const PLANS: Record<string, { intro: string; sections: { name: string; blurb: string; items: { title: string; brief: string }[] }[] }> = {
  'quantum-computing': {
    intro: 'Quantum computers use the odd rules of the very small to tackle problems ordinary computers cannot. This topic takes you from "what is a qubit" to why banks and governments are worried.',
    sections: [
      {
        name: 'The basics',
        blurb: 'What a quantum computer is and is not.',
        items: [
          { title: 'Why a qubit can be 0 and 1 at once', brief: 'Superposition with an everyday analogy.' },
          { title: 'Entanglement, the spooky link between qubits', brief: 'What entanglement is and why it matters for computing.' },
          { title: 'Why quantum computers are kept colder than space', brief: 'Decoherence and dilution refrigerators.' },
        ],
      },
      {
        name: 'What they could do',
        blurb: 'The problems that would actually change.',
        items: [
          { title: 'The algorithm that scares every bank', brief: "Shor's algorithm and RSA encryption." },
          { title: 'Designing medicines atom by atom', brief: 'Simulating molecules.' },
        ],
      },
      { name: 'Latest', blurb: 'What is happening right now, explained.', items: [], live: true } as never,
    ],
  },
  'the-war-in-ukraine': {
    intro: 'The largest war in Europe since 1945 began in February 2022, but its roots go back centuries. These stories explain how it started, who is involved and why it matters far beyond the two countries.',
    sections: [
      {
        name: 'What is happening',
        blurb: 'The war in plain terms.',
        items: [
          { title: 'A war in Europe, explained in two minutes', brief: 'Who fights whom, where, since when.' },
          { title: 'Why the front line barely moves', brief: 'Trenches, drones and artillery.' },
        ],
      },
      {
        name: 'How it started',
        blurb: 'The long road to 2022.',
        items: [
          { title: 'Why Ukraine and Russia share a history and not a country', brief: 'From Kyivan Rus to 1991.' },
          { title: 'What happened in Crimea in 2014', brief: 'The annexation and why it mattered.' },
        ],
      },
      { name: 'Latest', blurb: 'What is happening right now, explained.', items: [], live: true } as never,
    ],
  },
};

const STORIES: { topic: string; section: number; item: number; kind?: 'trending'; title: string; hook: string; body: string; takeaway: string; tags: string[]; why_now?: string }[] = [
  {
    topic: 'quantum-computing',
    section: 0,
    item: 0,
    title: 'Why a qubit can be 0 and 1 at once',
    hook: 'The one idea behind quantum computing, with a spinning coin.',
    body: 'Flip a coin and slap it on the table: heads or tails, one or the other. That is a **bit**, the smallest piece of information in every ordinary computer.\n\nNow spin the coin instead. While it whirls, it is not heads and not tails; it is a blur of both, with some lean towards one side. Physicists call that blur a **superposition**, and a **qubit** is a coin that stays spinning until you look.\n\nThe trick is that a quantum computer can do its arithmetic while the coins are still spinning. Ten spinning coins hold every one of the 1,024 possible head-tail patterns at the same time, each with its own lean. A clever program nudges the leans so that wrong answers cancel out and the right one is left standing when the coins finally land.\n\nThat is why these machines are not simply faster laptops. For most jobs the trick buys nothing. For a few, such as cracking certain codes or simulating molecules, it turns centuries of computing into hours.',
    takeaway: 'A qubit is a bit that stays "spinning" between 0 and 1 until it is measured, and a quantum computer calculates with the spin.',
    tags: ['qubit', 'superposition', 'physics'],
  },
  {
    topic: 'quantum-computing',
    section: 0,
    item: 1,
    title: 'Entanglement, the spooky link between qubits',
    hook: 'Two particles, one fate, and why Einstein hated it.',
    body: 'Take two dice, shake them in a cup, and roll them on opposite sides of the planet. Whatever one shows, the other always shows the same number. Not because they talked; because they were never separate things.\n\nThat is **entanglement**. Two qubits prepared together share a single description, and measuring one instantly settles the other, however far apart they are. Einstein called it "spooky action at a distance" and suspected a hidden explanation. Experiments since the 1970s say there is none.\n\nFor a quantum computer, entanglement is the glue. Without it, ten qubits are just ten spinning coins. With it, the ten share one combined state, which is what lets a program steer all 1,024 possibilities together.\n\nIt is also fragile. A stray vibration or a bit of heat is enough to break the link, which is why these machines live inside vacuum chambers chilled close to absolute zero.',
    takeaway: 'Entangled qubits share one state, so a change to one is a change to all, which is what makes a quantum computer more than a pile of qubits.',
    tags: ['entanglement', 'qubit', 'physics'],
  },
  {
    topic: 'quantum-computing',
    section: 1,
    item: 0,
    title: 'The algorithm that scares every bank',
    hook: 'Why a 1994 maths result makes governments copy their secrets now.',
    body: 'Every time you pay online, your card number travels inside a lock built from two huge prime numbers multiplied together. Multiplying them takes a millisecond. Pulling them apart again, which is what a thief would need, takes the fastest ordinary computer longer than the age of the universe. That gap is **RSA encryption**, and most of the internet rests on it.\n\nIn 1994 the mathematician Peter Shor showed that a quantum computer could pull the primes apart in hours. **Shor\'s algorithm** uses the spinning-coin trick to test enormous numbers of candidate factors at once and make the wrong ones cancel out.\n\nNo machine today is big or stable enough to run it on real keys. But encrypted data stolen now can be stored and unlocked later, so banks and governments are already switching to **post-quantum** locks built on maths the algorithm cannot touch.',
    takeaway: 'Shor\'s algorithm would let a big enough quantum computer break the encryption behind online payments, so the locks are being changed in advance.',
    tags: ['encryption', 'shor', 'security', 'banks'],
  },
  {
    topic: 'the-war-in-ukraine',
    section: 0,
    item: 0,
    title: 'A war in Europe, explained in two minutes',
    hook: 'Who is fighting whom, where, and since when.',
    body: 'On 24 February 2022, Russian troops crossed into Ukraine from the north, east and south. It was the start of the largest war in Europe since 1945, and it is still going.\n\nUkraine is a country of roughly 40 million people between Russia and the European Union. It became independent in 1991 when the Soviet Union, the communist superpower that both countries had been part of, fell apart.\n\nRussia\'s government says it acted to protect Russian speakers and to stop Ukraine joining **NATO**, the Western military alliance. Ukraine and most Western governments call it an unprovoked **invasion** aimed at ending Ukraine\'s independence.\n\nThe front line now runs for about 1,000 kilometres through the east and south of Ukraine. Russia holds roughly a fifth of the country. Hundreds of thousands of soldiers have been killed or wounded, and millions of Ukrainians have fled abroad.',
    takeaway: 'Russia invaded Ukraine in February 2022; Russia frames it as self-defence, Ukraine and the West as a war of conquest, and the front has barely moved for years.',
    tags: ['ukraine', 'russia', 'war', 'nato'],
  },
  {
    topic: 'the-war-in-ukraine',
    section: 1,
    item: 1,
    title: 'What happened in Crimea in 2014',
    hook: 'The eight years before the invasion started with a peninsula.',
    body: 'In February 2014, soldiers in unmarked green uniforms appeared at airports and government buildings on **Crimea**, a peninsula in southern Ukraine where most people speak Russian and where Russia keeps its Black Sea navy.\n\nWeeks earlier, protests in Kyiv had toppled Ukraine\'s pro-Russian president. Russia\'s government said the new leaders were illegitimate and that Crimea\'s people wanted to join Russia. A hastily organised vote, held under the guns and rejected by Ukraine and most of the world, returned a 97 percent yes.\n\nRussia **annexed** the peninsula, meaning it declared it Russian territory. No shots were fired on Crimea, but fighting soon began in the Donbas, Ukraine\'s eastern coal region, between Ukrainian forces and Russian-backed separatists.\n\nThat low-level war killed about 14,000 people over eight years. It is the war that the 2022 invasion turned into a full one.',
    takeaway: 'Russia took Crimea in 2014 after Ukraine\'s revolution, and the fighting that started then in eastern Ukraine never stopped.',
    tags: ['crimea', 'ukraine', 'russia', 'history'],
  },
  {
    topic: 'the-war-in-ukraine',
    section: 2,
    item: 1000,
    kind: 'trending',
    why_now: 'A new round of talks about a ceasefire is in the news this week.',
    title: 'What a ceasefire is, and what it is not',
    hook: 'Three words diplomats use that sound alike and mean very different things.',
    body: 'When leaders talk about ending a war, three words keep coming up, and they are not the same.\n\nA **ceasefire** is a promise to stop shooting, usually from a set hour. Nothing else changes: the armies stay where they are, and the quarrel that caused the war is untouched. Ceasefires can last a day or decades. Korea has lived under one since 1953.\n\nAn **armistice** is a formal ceasefire signed by the governments, meant to hold while a real settlement is negotiated.\n\nA **peace treaty** ends the war itself: it draws borders, settles who pays for what and, in theory, closes the dispute for good.\n\nThat is why a headline about a ceasefire is both big and small news. The dying can stop quickly. The hard questions, such as who controls which land, are only postponed.',
    takeaway: 'A ceasefire stops the shooting but settles nothing; only a peace treaty ends the war.',
    tags: ['ceasefire', 'diplomacy', 'ukraine', 'war'],
  },
];

async function main() {
  const client = await pool.connect();
  try {
    for (const [topicSlug, plan] of Object.entries(PLANS)) {
      await client.query('UPDATE topics SET plan = $2, planned_at = now() WHERE slug = $1', [topicSlug, JSON.stringify(plan)]);
    }
    let minutesAgo = STORIES.length * 15;
    for (const s of STORIES) {
      const topic = await client.query<{ id: number }>('SELECT id FROM topics WHERE slug = $1', [s.topic]);
      if (!topic.rows[0]) throw new Error(`topic ${s.topic} missing; start the backend once so migrations run`);
      const section = PLANS[s.topic].sections[s.section];
      const body = s.body;
      await client.query(
        `INSERT INTO stories (slug, topic_id, title, hook, body_md, takeaway, kind, why_now, section_index, plan_index, section_name, plan_item, difficulty, tags, read_seconds, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now() - ($16 || ' minutes')::interval)
         ON CONFLICT (slug) DO NOTHING`,
        [
          slug(s.title),
          topic.rows[0].id,
          s.title,
          s.hook,
          body,
          s.takeaway,
          s.kind ?? 'planned',
          s.why_now ?? null,
          s.section,
          s.item,
          section.name,
          s.kind ? null : s.title,
          1,
          s.tags,
          Math.max(20, Math.round((body.split(/\s+/).length / 200) * 60)),
          String(minutesAgo),
        ],
      );
      minutesAgo -= 15;
    }
    const n = await client.query('SELECT count(*) FROM stories');
    console.log(`seeded; ${n.rows[0].count} stories in the dev database`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
