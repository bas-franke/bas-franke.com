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

type RankRow = [string, string, string, string, string, string, string];

const ALL_COINS: RankRow[] = [
  ['1', 'Session 9: Bitcoin bull, cycle check', '53.5', '47.7', '+49% vs −16%', '28 of 29', '−59%'],
  ['2', 'Session 10: Bear mode, breadth bull', '52.7', '47.0', '+47% vs −16%', '28 of 29', '−60%'],
  ['3', 'Session 8: Bitcoin bull', '52.2', '47.6', '+45% vs −16%', '28 of 29', '−60%'],
  ['4', 'Session 7: Dip and breakout, laddered dips', '48.3', '43.1', '+42% vs −16%', '28 of 29', '−45%'],
  ['5', 'Session 6: Hourly breakout and dips', '46.8', '42.6', '+31% vs −10%', '27 of 29', '−45%'],
  ['', 'Holding the coin', '44.5', '44.1', '−16%', '–', '−91%'],
  ['', 'Always half in', '42.9', '42.8', '+6% vs −16%', '23 of 29', '−62%'],
];

function AllCoinsTable() {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>#</th>
            <th>Strategy</th>
            <th className="r">Score, all 29</th>
            <th className="r">Score, 19 unseen</th>
            <th className="r">Yearly return vs holding</th>
            <th className="r">Beat holding</th>
            <th className="r">Typical worst drop</th>
          </tr>
        </thead>
        <tbody>
          {ALL_COINS.map((r) => (
            <tr key={r[1]}>
              <td className="tnum">{r[0]}</td>
              <td>{r[1]}</td>
              <td className="r tnum">
                <b>{r[2]}</b>
              </td>
              <td className="r tnum">{r[3]}</td>
              <td className="r tnum nowrap">{r[4]}</td>
              <td className="r tnum nowrap">{r[5]}</td>
              <td className="r tnum">{r[6]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const PARTS: [string, string, string, string][] = [
  ['Windows (60%)', '41.8', '46.9', '32.1'],
  ['Big rallies kept (20%)', '59.6', '32.3', '93.7'],
  ['Last 12 months (20%)', '53.5', '42.6', '30.3'],
];

function PartsTable() {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>On the 19 unseen coins</th>
            <th className="r">Cycle bull (S9)</th>
            <th className="r">Ladder (S7)</th>
            <th className="r">Holding</th>
          </tr>
        </thead>
        <tbody>
          {PARTS.map((r) => (
            <tr key={r[0]}>
              <td>{r[0]}</td>
              <td className="r tnum">
                <b>{r[1]}</b>
              </td>
              <td className="r tnum">{r[2]}</td>
              <td className="r tnum">{r[3]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AllCoins() {
  return (
    <>
      <p className="lede">
        Every research session so far tested its strategies on the same ten coins. So we took the number one of Sessions 6 to 10, changed
        nothing, and ran them on all 29 coins we have prices for. Nineteen of those coins were never seen by any research agent. Session 9’s
        cycle bull came out on top. Here is why, and how much the win is worth.
      </p>

      <h2>The ranking</h2>
      <p>
        Scored with the absolute score every card carries: 60% the window score (hundreds of one- to three-month stretches), 20% the share of
        every big rally it kept, 20% the last twelve months. Bitvavo’s real fees, March 2019 to October 2026, each coin from its first candle.
        The yearly return is the typical (median) coin. The full tables per coin are in the new <b>Session 11</b> tab on the Research page.
      </p>
      <AllCoinsTable />

      <h2>The first thing to notice: everyone got worse</h2>
      <p>
        On the ten coins they were built on, the five score 56 to 66. On the nineteen new coins they score 43 to 48. That is the honest
        price of tuning on the same data, and it grows with every session that built on the last one:
      </p>
      <ul>
        <li>
          Session 6 drops 13 points, Session 7 15, Session 8 15, Session 9 17, and Session 10 19.
        </li>
        <li>
          Session 10 was the best on the original ten coins, but only second on all 29. Its extra rules were learned from those ten coins.
        </li>
      </ul>

      <h2>Why the cycle bull wins</h2>
      <ol>
        <li>
          <b>Its edge doesn’t depend on the coin.</b> The big switch reads bitcoin, not the coin it trades: when bitcoin is in a bull market,
          it goes all in. Crypto bull markets lift nearly everything at once, so the rule works just as well on a coin it has never seen. On
          the nineteen new coins it kept 60% of the big rallies, against 32% for the ladder of Session 7.
        </li>
        <li>
          <b>The mania-top check helps a little.</b> It differs from Session 8 by stopping its rides when bitcoin runs far above its long
          average. On the new coins that keeps a bit more of each rally (60 against 56), enough to edge past Session 8.
        </li>
        <li>
          <b>It has fewer layers than Session 10.</b> Session 10 added a bear mode and a “most coins are rising” rule. On new coins these hurt:
          a last-twelve-months score of 46 against 54, and a typical worst drop of 72% against 64%.
        </li>
        <li>
          <b>It works in the recent market, not only in 2021.</b> On the new coins its last twelve months score 53.5, against 30 for holding.
        </li>
      </ol>
      <PartsTable />
      <p>
        The table also shows its weak spot. On the plain window score the ladder of Session 7 is clearly better on new coins (46.9 against
        41.8), and the cycle bull is no better than simply keeping half your money in the coin there (41.9). The cycle bull wins on the big
        rallies and the recent year, not on everyday trading.
      </p>

      <h2>How much is the win worth?</h2>
      <ul>
        <li>
          <b>Not much over Sessions 8 and 10.</b> 53.5, 52.7 and 52.2 is close to a tie. What holds up is the family: the three bitcoin-bull
          books clearly beat the two dip-and-breakout books.
        </li>
        <li>
          <b>Beating holding was easy this time.</b> Most of the nineteen new coins lost money: the typical one fell 27% a year. Even keeping
          half in the coin beat holding on 23 of the 29 coins. The cycle bull made about +28% a year on the typical new coin.
        </li>
        <li>
          <b>It still sold too early in a clean rally.</b> HYPE is the only coin where all five lost to holding: €1,000 became about €2,030
          with the cycle bull and €2,710 by holding.
        </li>
        <li>
          <b>It survived LUNA, but barely.</b> LUNA went from €93 to almost nothing in May 2022. Holding turned €1,000 into €0. The cycle bull
          ended at €824 after a 76% drop, and Session 6 lost everything on a dip buy. The ladder came out ahead, mostly from trading the
          worthless leftovers afterwards, which in practice would be hard to fill.
        </li>
        <li>
          <b>The drops are big.</b> A typical worst drop of 59%, and 64% on the new coins, against 45% for the ladder.
        </li>
      </ul>

      <div className="callout brass">
        <p>
          <b>In one sentence:</b> the cycle bull wins because its main rule, “all in while bitcoin is in a bull market”, doesn’t care which
          coin it trades. That is the part of the research that worked on new coins. The coin-by-coin tuning added on top mostly didn’t.
        </p>
      </div>
      <p>
        That fits the last article’s warning. Session 7’s ladder is still the steadiest on everyday stretches, with the smallest drops, but it
        misses the big bull markets. If the next bull market is real, the cycle bull is the better bet. If it isn’t, the ladder is.
      </p>
      <p className="small soft">
        The 19 new coins: ALGO, ATOM, BCH, CRO, DOT, ETC, HBAR, HYPE, ICP, LTC, LUNA, IOTA, NEO, POL, SHIB, SUI, UNI, XLM and XTZ. A coin only
        counts after 60 days of history, so young coins such as HYPE and SUI only count for their recent years. Several of them trade
        thinly, so real fills would be worse than in the test. Past results say nothing certain about the future; this is research, not
        financial advice.
      </p>
    </>
  );
}

export const ARTICLES: Article[] = [
  {
    slug: 'twenty-nine-coins',
    title: 'Tested on 29 coins: why the cycle bull wins',
    blurb: 'The number one of Sessions 6 to 10, run unchanged on 19 coins no research agent ever saw. Session 9’s cycle bull comes out on top, and its main rule is why.',
    date: '2026-10-29',
    minutes: 5,
    tag: 'Research',
    body: AllCoins,
  },
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
