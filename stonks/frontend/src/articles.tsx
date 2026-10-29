import type { ReactNode } from 'react';

// Long reads shown as cards on the Overview page and opened at /article?slug=<slug>. The content lives in code:
// add an entry here (newest first) and it shows up on the homepage.

export type Article = {
  slug: string;
  title: string;
  blurb: string;
  date: string;
  minutes: number;
  tag: string;
  body: () => ReactNode;
};

type Row = [string, string, string, string, string, string];

const WINNERS: Row[] = [
  ['Session 6', 'Hourly breakout and dips', '+57% vs +21%', '−42%', '58.8 → 59.0', '54.8 (58.8)'],
  ['Session 7', 'Dip and breakout, laddered dips', '+65% vs +23%', '−43%', '62.0 → 59.6', '57.1 (60.8)'],
  ['Session 8', 'Bitcoin bull', '+84% vs +23%', '−53%', '61.3 → 58.0', '58.4 (61.7)'],
  ['Session 9', 'Bitcoin bull, cycle check', '+94% vs +23%', '−54%', '64.4 → 58.1', '60.1 (63.7)'],
  ['Session 10', 'Bear mode, breadth bull', '+98% vs +23%', '−55%', '67.1 → 59.6', '61.2 (65.9)'],
];

function WinnersTable() {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Session</th>
            <th>Winner</th>
            <th className="r">Yearly return vs holding</th>
            <th className="r">Typical worst drop</th>
            <th className="r">Score, early → late years</th>
            <th className="r">Settings nudged (normal)</th>
          </tr>
        </thead>
        <tbody>
          {WINNERS.map((r) => (
            <tr key={r[0]}>
              <td className="nowrap">{r[0]}</td>
              <td>{r[1]}</td>
              <td className="r tnum nowrap">
                <b>{r[2]}</b>
              </td>
              <td className="r tnum">{r[3]}</td>
              <td className="r tnum nowrap">{r[4]}</td>
              <td className="r tnum nowrap">{r[5]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WillItLast() {
  return (
    <>
      <p className="lede">
        Every research session crowns a winner, and every winner beats simply holding the coins by a mile on paper. This
        is an honest look at the last five: why they could keep working, why they could fail, and which one is the best
        bet for the years ahead.
      </p>

      <h2>The five winners</h2>
      <p>
        All are tested on ten coins (bitcoin, ether and eight others) from March 2019 until now, with Bitvavo’s real
        fees. Sessions 8 to 10 use a slightly different scorer than 6 and 7, so compare the scores within a row, not
        between rows.
      </p>
      <WinnersTable />

      <h2>Why it might keep working</h2>
      <ul>
        <li>
          <b>The ideas underneath are old and simple.</b> In crypto, trends tend to keep going for a while, and panic
          crashes tend to bounce. Every winner rides new highs, buys sharp panic drops and stays small when the market
          falls. Those are habits of nervous people, not a quirk of one lucky period.
        </li>
        <li>
          <b>It trades rarely,</b> roughly once a week per coin, so fees and slippage don’t eat the edge.
        </li>
        <li>
          <b>It passed the honesty checks.</b> It doesn’t peek at future prices, it still works when it acts one candle
          late, it still works with every setting nudged by 15%, and it beat holding on all ten coins, including in the
          last twelve months.
        </li>
      </ul>

      <h2>Why it might fail</h2>
      <ol>
        <li>
          <b>The extra return comes mostly from one huge bull market.</b> Sessions 8 to 10 earn their extra money by going
          all in during bitcoin bull markets, which in this data mostly means 2020–21, when ether rose about 35x and
          Cardano about 29x. Each crypto cycle so far has been tamer than the one before. If the next one is a 3x
          instead of a 30x, most of the jump from +65% to +98% a year disappears.
        </li>
        <li>
          <b>A lot of tuning on the same data.</b> About 150 research agents over five sessions tried many tweaks on the
          same seven and a half years and the same ten coins, each session building on the last winner. Rules such as
          “bitcoin above its 140-day average” or “3.7 times its 450-day average means a mania top” were fitted to only
          about two bitcoin cycles. That is very few examples to learn from.
        </li>
        <li>
          <b>The clearest warning sign is in the table.</b> Session 6 scores the same in the early and the late years.
          By Session 10 the late years are 7.5 points worse. Each new layer mostly improved the past, not the recent
          market.
        </li>
        <li>
          <b>The coins were picked knowing they survived.</b> All ten are still around today. Coins that collapsed, like
          LUNA or FTT, aren’t in the test. In real life the bot might hold the next one of those.
        </li>
        <li>
          <b>The drops hurt.</b> A typical worst drop of 55% is hard to sit through. A crash while the bot is all in on a
          bull ride is exactly the moment people pull the plug at the worst time.
        </li>
      </ol>

      <h2>The one most likely to succeed</h2>
      <div className="callout brass">
        <p>
          <b>Session 7, Dip and breakout with laddered dips.</b> Not the highest score, but the steadiest one.
        </p>
      </div>
      <ul>
        <li>
          <b>It holds up best over time.</b> It loses only 2.4 points from the early to the late years, and it barely
          suffers when its settings are nudged or when it acts late.
        </li>
        <li>
          <b>It doesn’t need another 2021.</b> It has no bull-market switch, so it doesn’t depend on one giant rally.
        </li>
        <li>
          <b>Its drops are smaller:</b> 43% instead of 55%.
        </li>
        <li>
          <b>The fancier versions gain little lately.</b> In the last twelve months Session 10 scores 67.5 against 64 for
          Session 7. Most of their extra 33% a year came from older history.
        </li>
      </ul>
      <p>
        Expect less than any backtest shows: something like 30 to 40% a year in a good market would already be a good
        result. If you want more upside, Session 8’s bitcoin bull is a sensible middle ground, with a single simple bull
        switch and no extra layers.
      </p>

      <h2>How the bitcoin books trade bitcoin itself</h2>
      <p>
        Sessions 8, 9 and 10 share one plan. Every 15 minutes the bot decides how much of the bitcoin pot to hold: 0, 25,
        50, 75 or 100%.
      </p>
      <h3>1. Check the weather, once a day</h3>
      <ul>
        <li>
          <b>Bull:</b> bitcoin’s daily close is above its 140-day average. It ends when bitcoin closes below that, or
          below its 75-day average. In Session 10 a bull also stays on while at least 8 of the 10 coins are above their
          own 150-day average, until fewer than 5 are.
        </li>
        <li>
          <b>Bear</b> (Session 10 only): no bull, and bitcoin is below its 365-day average.
        </li>
        <li>
          <b>Neutral:</b> anything else.
        </li>
      </ul>
      <h3>2. Four reasons to own bitcoin</h3>
      <p>Each suggests a size, and the bot holds the largest suggestion.</p>
      <ol>
        <li>
          <b>Breakout ride:</b> bitcoin closes at a new 27-day high, so it buys. It sells once the price falls about four
          normal daily moves below its peak, and banks half at +16% and half of the rest at +35%. Calmer markets get a
          bigger position.
        </li>
        <li>
          <b>Slow trend ride:</b> the 26-day trend turns upward, so it buys, and sells when it turns down.
        </li>
        <li>
          <b>Panic snap:</b> a crash within four hours, far bigger than normal, so it buys, and sells on the bounce.
        </li>
        <li>
          <b>Slow dip:</b> the price sinks well below its 40-hour average, so it buys.
        </li>
      </ol>
      <p>Dips are bought in two steps: half at the signal, the rest if it falls 25% deeper. A faster fall buys more.</p>
      <h3>3. The weather changes the sizes</h3>
      <ul>
        <li>
          <b>Bull:</b> both rides are four times bigger, which for bitcoin simply means 100% in. Banking waits for much
          bigger gains, about +57% and +146%. One exception, from Session 9: above roughly 3.7 times its 450-day average
          (a mania top), the rides stop and only dips are bought.
        </li>
        <li>
          <b>Bear:</b> the slow trend ride gets an extra quarter of the pot, and dips must be 15% deeper before it buys.
        </li>
        <li>
          <b>Neutral:</b> the plain Session 7 plan, with small rides and careful dip buying.
        </li>
      </ul>
      <div className="callout">
        <p>
          <b>In one sentence:</b> in a bitcoin bull it is simply all in on bitcoin, until a mania top. Otherwise it holds
          small trend positions and buys the panic drops.
        </p>
      </div>
      <p className="small soft">
        Session 8 has only the bull switch (a 120-day average and three-times rides). Session 9 adds the mania-top check
        and four-times rides. Session 10 adds the bear mode and the “most coins are rising” rule. Past results say
        nothing certain about the future; this is research, not financial advice.
      </p>
    </>
  );
}

export const ARTICLES: Article[] = [
  {
    slug: 'will-the-winners-last',
    title: 'Will the winners last?',
    blurb: 'An honest look at the top strategy of the last five research sessions: why each could keep working, why it could fail, and which one is the safest bet.',
    date: '2026-10-29',
    minutes: 6,
    tag: 'Research',
    body: WillItLast,
  },
];

export const articleBySlug = (slug: string) => ARTICLES.find((a) => a.slug === slug);
