import type { ReactNode } from 'react';
import { HowItTrades } from './howItTrades/article';

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

type SafetyRow = [string, string, string, string];

const SAFETY: SafetyRow[] = [
  ['Yearly return on ether', '+110%', '+110%', 'vs +45% holding'],
  ['Worst drop on ether', '−52%', '−34%', 'the whole point of Session 13'],
  ['Typical worst drop, 10 coins', '−54%', '−50%', 'small gain'],
  ['Yearly return, 10 coins', '+88%', '+89%', 'vs +21% holding'],
  ['Worst drop, 19 unseen coins', '−65%', '−65%', 'no help at all'],
  ['Yearly return, 19 unseen coins', '+27%', '+25%', 'vs −22% holding'],
  ['Ether drop with settings nudged', '−52%', '−34% (worst −40%)', 'settings don’t matter much'],
  ['Candles it changes', '0%', '0.5%', 'otherwise the same bot'],
];

function SafetyTable() {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Measure</th>
            <th className="r">Running now</th>
            <th className="r">Session 13 #1</th>
            <th>Reading</th>
          </tr>
        </thead>
        <tbody>
          {SAFETY.map((r) => (
            <tr key={r[0]}>
              <td>{r[0]}</td>
              <td className="r tnum nowrap">{r[1]}</td>
              <td className="r tnum nowrap">
                <b>{r[2]}</b>
              </td>
              <td className="small soft">{r[3]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SeatBelt() {
  return (
    <>
      <p className="lede">
        The bot runs <b>Bitcoin bull, cycle check</b>, the Session 9 winner that also topped the 29-coin test. Session 13 set twenty agents on
        one job: make that same strategy fall less, without changing how it trades. The winner, <b>Crash buy time stop</b>, cuts ether’s
        worst drop from 52% to 34%. This is what it does, explained simply, how likely each is to keep working, and which one to run.
      </p>

      <h2>Explain it like I’m five</h2>
      <p>
        <b>The strategy you run now</b> is a cat watching the sea. When the tide is coming in (bitcoin is in a bull market) it jumps on
        every wave and rides it as far as it goes. When the sea is calm it stays small and only pounces when a wave crashes, buying the panic.
        That pouncing on crashes is where the trouble lives: sometimes a crash has a second leg, and the cat jumps in right before the floor
        gives way again. March 2020 and May 2021 were exactly that, and they are the two deepest holes in its history.
      </p>
      <p>
        <b>Session 13 #1 is the same cat wearing a seat belt.</b> Everything about when it buys and sells is unchanged. One rule is added on
        top: when the cat buys during a real crash (the coin is 30% or more under its best price of the last ten days), the buy has to pay off
        within six hours. If the price has not bounced 5% above that buy in six hours, the bot sells that buy again and refuses to re-buy until
        the main strategy has left the position for good. In plain words: <i>if you caught a falling knife and it keeps falling, let go fast.</i>
      </p>
      <p>
        The belt only ever makes the bot hold less, never more, and it touches half a percent of all the candles in seven years. The other
        99.5% of the time the two bots are exactly the same.
      </p>

      <h2>What it changes</h2>
      <p>Measured by the research lead, not by the agent that built it, on the same seven and a half years and Bitvavo’s real fees.</p>
      <SafetyTable />
      <p>
        On ether the seat belt rewrites the two worst days of its life: the March 2020 crash goes from a 52% hole to 32%, the May 2021
        reversal from 40% to 24%. The next worst stretches, September 2020 and the slow bleeds of 2024 and 2025–26, do not change at all.
        That is why 34% is as low as this idea can go: those falls come from rides and slow losses, not from crash buys.
      </p>

      <h2>How likely is each to hold up?</h2>
      <h3>The strategy running now</h3>
      <ul>
        <li>
          <b>Its ideas are old and ordinary:</b> trends keep going, panics bounce. That is the best kind of edge to have.
        </li>
        <li>
          <b>It survived the one test that matters most.</b> Run unchanged on 19 coins no research agent ever saw, it still beat holding on
          18 of them. Nothing else from the research did better there.
        </li>
        <li>
          <b>Its weak spot is the size of its falls,</b> and that most of its big return came from a single giant bull market in 2020–21.
          A future cycle that is tamer gives a smaller return; it does not break the strategy.
        </li>
      </ul>
      <h3>Session 13 #1, the seat belt</h3>
      <ul>
        <li>
          <b>It cannot make things worse by much.</b> It only ever sells a crash buy that did not bounce. The cost shows in the table: the
          10-coin return is unchanged and the unseen coins lose two points of yearly return. The agents found that most of these early sells
          lose a little; the belt pays small bills to skip the rare second leg.
        </li>
        <li>
          <b>But its big win rests on two events.</b> Ether’s drop falls from 52% to 34% because of March 2020 and May 2021, and nothing
          else. Two examples is a very thin history to learn from, and the rule’s settings were tuned until exactly those two were caught.
          Nudge the “30% under the ten-day best” to 34% and May 2021 slips through again, putting ether back at a 40% drop.
        </li>
        <li>
          <b>On the 19 unseen coins it did nothing.</b> Their worst drops are the same with or without it. So the honest reading is: the belt
          helps on ether in the kind of crash ether has had twice, and we have no evidence it helps anywhere else.
        </li>
        <li>
          <b>The one thing it has going for it over time:</b> the rule is not strange. Selling a crash buy that keeps falling is what any
          careful trader would do, and the fact that the settings barely matter (every nudged version still ends between 34% and 40%) is a
          good sign. It is not a lucky number, it is a sensible habit that happened to pay off twice.
        </li>
      </ul>

      <h2>Which one to run</h2>
      <div className="callout brass">
        <p>
          <b>Run Session 13 #1, Crash buy time stop.</b> Same strategy, same return, one careful habit added. Expect the smaller drops only
          in crashes like the two it was built on; everywhere else expect the bot you already have.
        </p>
      </div>
      <ul>
        <li>
          <b>Why switch:</b> the downside is small and known (about two points of yearly return on coins where it never fires), the upside is
          an 18-point smaller hole in exactly the moment people pull the plug. A drop you can sit through is worth more than a drop you
          cannot.
        </li>
        <li>
          <b>Why it is not a big decision:</b> 99.5% of the time the two bots place the same orders. If you are nervous about anything, it
          should be the main strategy’s 2020–21 dependence, and that is the same in both.
        </li>
        <li>
          <b>What would change the verdict:</b> if the belt fires in a real crash and the price then bounces hard without you, that is the
          cost showing up. One such miss is normal; if it keeps missing bounces, go back to the plain strategy.
        </li>
      </ul>
      <p className="small soft">
        Numbers: ether and the 10 research coins since March 2019, the 19 unseen coins since each one’s first candle, all at Bitvavo’s fees,
        yearly returns on calendar time. The seat belt’s full write-up, with every coin and the compare graph, is in the Session 13 tab. Past
        results say nothing certain about the future; this is research, not financial advice.
      </p>
    </>
  );
}

type KnownRow = [string, string, string, string, string];

const KNOWN: KnownRow[] = [
  ['Session 13 #1 on ether, 2019–2026', '+110% a year', '−34%', 'Backtest, tuned on these years', 'this site'],
  ['Holding ether, 2019–2026', '+45% a year', '−80%', 'What actually happened', 'this site'],
  ['Bitcoin 200-day average rule, 2014–2026', 'about +50% a year (holding: +46%)', '−65% (holding: −83%)', 'Backtest, 0.1% costs', 'Coinpaprika'],
  ['Bitcoin 200-day average, daily, 2010–2017', '+203 to +216% a year (holding: +224%)', '−66 to −70% (holding: −90%)', 'Backtest, no costs', 'Detzel et al.'],
  ['Bitcoin 200-day average, minute candles', '+57% a year', '−39%', 'Backtest, no costs', 'CryptoQuant'],
  ['Crypto momentum, weekly winners', 'Worked 2019–21, lost 2022–23', 'Severe crashes', 'Backtest, no costs', 'Liu & Tsyvinski; later studies'],
  ['Trend-following funds (SG Trend Index), since 2000', '+4.9% a year', '−21%', 'Live money, after fees', 'Société Générale'],
  ['Trend-following funds (BTOP50)', '+3.9% a year', '−16%', 'Live money, after fees', 'Barclay'],
  ['Retail crypto bots', 'No audited numbers exist', '–', 'Vendor claims only', '–'],
];

function KnownTable() {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Strategy</th>
            <th className="r">Return</th>
            <th className="r">Worst drop</th>
            <th>Real or paper</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {KNOWN.map((r) => (
            <tr key={r[0]}>
              <td>{r[0]}</td>
              <td className="r tnum">{r[1]}</td>
              <td className="r tnum nowrap">{r[2]}</td>
              <td className="small">{r[3]}</td>
              <td className="small soft">{r[4]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SOURCES: [string, string][] = [
  ['Detzel, Liu, Strauss, Zhou, Zhu: Learning and predictability via technical analysis, evidence from bitcoin (Financial Management, 2021)', 'https://ideas.repec.org/a/bla/finmgt/v50y2021i1p107-137.html'],
  ['CXO Advisory: Timing bitcoin with SMAs (summary of the Detzel working paper)', 'https://www.cxoadvisory.com/currency-trading/timing-bitcoin-with-smas/'],
  ['Gerritsen, Bouri, Ramezanifar, Roubaud: The profitability of technical trading rules in the bitcoin market (Finance Research Letters, 2020)', 'https://research-portal.uu.nl/en/publications/the-profitability-of-technical-trading-rules-in-the-bitcoin-marke/'],
  ['Corbet, Eraslan, Lucey, Sensoy: The effectiveness of technical trading rules in cryptocurrency markets (Finance Research Letters, 2019)', 'https://ideas.repec.org/a/eee/finlet/v31y2019icp32-37.html'],
  ['Liu, Tsyvinski: Risks and returns of cryptocurrency (NBER working paper 24877)', 'https://www.nber.org/system/files/working_papers/w24877/w24877.pdf'],
  ['Hudson, Urquhart: Technical trading and cryptocurrencies (Annals of Operations Research, 2021)', 'https://hull-repository.worktribe.com/output/2328042'],
  ['Grobys, Sapkota: Cryptocurrencies and momentum (Economics Letters, 2019)', 'https://ideas.repec.org/a/eee/ecolet/v180y2019icp6-10.html'],
  ['Zaremba et al.: Short-term reversal in 3,600 cryptocurrencies (International Review of Financial Analysis, 2021)', 'https://ideas.repec.org/a/eee/finana/v78y2021ics1057521921002349.html'],
  ['Bailey, Borwein, López de Prado, Zhu: The probability of backtest overfitting', 'https://papers.ssrn.com/abstract=2326253'],
  ['Hurst, Ooi, Pedersen: A century of evidence on trend-following investing (AQR)', 'https://www.aqr.com/Insights/Research/Journal-Article/A-Century-of-Evidence-on-Trend-Following-Investing'],
  ['Cambridge Associates: Does trend following’s recent struggle signal that the strategy is structurally broken?', 'https://www.cambridgeassociates.com/insight/does-trend-followings-recent-struggle-signal-that-the-strategy-is-structurally-broken/'],
  ['McLean, Pontiff: Does academic research destroy stock return predictability? (Journal of Finance, 2016)', 'https://ivey.uwo.ca/media/3775549/pontiff.pdf'],
  ['Coinpaprika: Bitcoin 200-day moving average backtest', 'https://coinpaprika.com/education/bitcoin-200-day-moving-average-backtest'],
  ['CryptoQuant: Improving buy and hold with a 200-day average', 'https://cryptoquant.dev/resources/blog/improve-buy-and-hold-btc'],
];

function DoesTheWorldKnow() {
  return (
    <>
      <p className="lede">
        Session 13’s winner is a trend-following bot with a bitcoin switch, a panic-dip buyer and a six-hour time stop. None of
        those ideas is new. People have tested them on bitcoin and ether for a decade, in universities and on trading desks. So
        before trusting a +110% a year backtest, it is worth asking what happened to everyone else who tried the same thing.
      </p>

      <h2>The same ideas, under their proper names</h2>
      <ul>
        <li>
          <b>The bitcoin switch is a “regime filter”,</b> the famous 200-day moving average rule in different clothes. Our bot
          uses 140 and 75 days on bitcoin’s daily close. Studies on bitcoin agree on one thing: such a rule rarely beats holding
          on return, but it cuts the worst drop a lot. Detzel and colleagues found the rule earned slightly less than holding
          over 2010–2017 while turning a 90% fall into about 68%. A 2014–2026 test by Coinpaprika found the same shape: a bit
          more than holding, with a 65% drop instead of 83%, and in most single years it lagged holding.
        </li>
        <li>
          <b>Riding new 27-day highs is a “Donchian breakout”,</b> the oldest trend rule there is. Gerritsen and colleagues
          found it is the one rule that beat holding bitcoin, but only in strongly trending years.
        </li>
        <li>
          <b>Going big in a bull is “time-series momentum”.</b> Liu and Tsyvinski showed it worked for bitcoin and, more
          weakly, ether. Grobys and Sapkota found no momentum profit at all in a wider set of coins. And several studies since
          show that crypto momentum worked in 2019–2021 and then lost money in 2022–2023.
        </li>
        <li>
          <b>Buying panic dips is “short-term reversal”.</b> Here the evidence points the other way for big coins. Zaremba’s
          study of 3,600 coins found that yesterday’s losers do bounce, but mainly the small, illiquid ones; large coins like
          ether tend to keep falling for a day, not bounce. The dip-buying part of our bot rests on the thinnest ground.
        </li>
        <li>
          <b>The six-hour time stop has no published study at all.</b> It is a practitioner habit, and we found no paper that
          isolates its effect in crypto.
        </li>
      </ul>

      <h2>Has it been debunked?</h2>
      <p>
        Not debunked, not confirmed either. The honest word is <b>“contested”</b>. Hudson and Urquhart tested about 15,000
        technical rules on cryptocurrencies with proper corrections for luck and still found profit. Others found none. What
        nobody disputes is this: every published return is before costs, trend rules lose money in sideways markets (Coinpaprika
        counted 25 of 36 upward crossings of bitcoin’s 200-day average that failed within a month), and the strongest results
        come from the two giant bull runs that our own backtest also contains.
      </p>
      <p>
        The sharpest warning comes from Bailey and López de Prado on <b>backtest overfitting</b>: the more settings you tune on
        the same history, the more likely the backtest describes the past instead of the future, and a heavily tuned backtest
        can even predict losses. Our bot has about ten tuned numbers (140 and 75 days, 27-day highs, 3.7 times the 450-day
        average, a 3-sigma four-hour fall, 30% under the ten-day best, 5% in six hours) fitted on one coin and seven years that
        contain two huge trends. That is exactly the situation they warn about.
      </p>

      <h2>How it compares with what exists</h2>
      <p>
        Paper results against paper results, and paper against real money. The two are not the same thing, and the table says
        which is which. Our 2019–2026 figures use calendar years; the bitcoin rule returns are our arithmetic from the source’s totals.
      </p>
      <KnownTable />
      <ul>
        <li>
          <b>On return it is above every published rule.</b> The published bitcoin average rules mostly match or lag holding;
          ours claims two and a half times holding. That gap is the thing to be suspicious of, not proud of.
        </li>
        <li>
          <b>On worst drop it is also better than every published rule,</b> about half the 65–70% those rules show. Part of
          that is the seat belt from Session 13, which we know rests on two events.
        </li>
        <li>
          <b>Real money looks nothing like this.</b> The professional trend funds that have run these ideas for 25 years make
          4–5% a year after fees with 16–21% drops. They trade calmer markets and use far less leverage, so the numbers do not
          translate directly, but the direction of the gap is the lesson: live results from trend rules are a small fraction of
          their backtests.
        </li>
        <li>
          <b>After publication, edges shrink.</b> McLean and Pontiff found stock-market anomalies keep only about a third to a
          half of their return once the paper is out. Crypto momentum went from strongly positive to negative within two years
          of being documented.
        </li>
      </ul>

      <h2>So how likely is it to beat the market?</h2>
      <div className="callout brass">
        <p>
          <b>On return: low to moderate. On drawdown: plausible.</b> The best-supported part of the bot (the bitcoin regime
          filter plus trend riding) is known mainly for making the fall shallower, not the climb steeper. The parts that make
          the backtest spectacular (4x positions in a bull, panic-dip buying in a large coin, the exact thresholds) have the
          weakest evidence behind them.
        </p>
      </div>
      <p>
        A fair expectation, going by what happened to comparable rules once real money and new years arrived: somewhere between
        the 200-day-rule outcome (roughly holding’s return with a smaller worst drop) and plain holding. If it ends a year with
        the same return as holding ether and a third less pain, that is the published rules doing what they are known to do.
        If it also beats holding by a wide margin, that is a gift of the market, not something the literature promised.
      </p>

      <h2>Sources</h2>
      <ul className="small">
        {SOURCES.map(([t, u]) => (
          <li key={u}>
            <a href={u} target="_blank" rel="noreferrer">
              {t}
            </a>
          </li>
        ))}
      </ul>
      <p className="small soft">
        Academic returns above are before trading costs; the fund indices are after fees. Past results say nothing certain
        about the future; this is research, not financial advice.
      </p>
    </>
  );
}

type SplitRow = [string, string, string, string, string];

const SPLIT_RUNS: SplitRow[] = [
  ['As it really was', '+110%', '−34%', '47%', '417'],
  ['Bitcoin never in a bull', '+72%', '−29%', '35%', '603'],
  ['Bitcoin always in a bull', '+122%', '−45%', '55%', '212'],
  ['Holding ether', '+45%', '−80%', '100%', '–'],
];

const OFF_BULL: [string, string, string, string, string][] = [
  ['May – Jul 2021', '76', '−38%', '−7%', '4%'],
  ['Dec 2021 – Mar 2022', '88', '−29%', '+10%', '13%'],
  ['Apr 2022 – Jan 2023', '281', '−51%', '+19%', '26%'],
  ['Feb – Apr 2025', '58', '−43%', '−13%', '18%'],
  ['Oct 2025 – May 2026', '188', '−41%', '+29%', '41%'],
  ['May – Aug 2026', '95', '+3%', '+22%', '44%'],
];

const REAL_SPLITS: [string, string, string, string, string][] = [
  ['Sep – Nov 2019', '−10%', '+11%', '+4%', '55%'],
  ['Jan – Mar 2020', '−5%', '+36%', '+52%', '78%'],
  ['May – Jul 2020', '−6%', '+18%', '+11%', '64%'],
  ['Mar – May 2021', '−12%', '+123%', '+28%', '31%'],
  ['Oct – Dec 2021', '−11%', '+23%', '+12%', '71%'],
  ['Jul – Sep 2022', '−6%', '+42%', '+2%', '27%'],
  ['Jul – Sep 2025', '−5%', '+13%', '+12%', '57%'],
];

function SplitTable({ rows, head, wrap = false }: { rows: string[][]; head: string[]; wrap?: boolean }) {
  return (
    <div className="table-wrap">
      <table className={wrap ? 'data fit' : 'data'}>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={h} className={i ? 'r' : undefined}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r[0]}>
              {r.map((c, i) => (
                <td key={i} className={i ? 'r tnum nowrap' : wrap ? undefined : 'nowrap'}>
                  {i === 1 && rows === SPLIT_RUNS ? <b>{c}</b> : c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BitcoinDownEtherUp() {
  return (
    <>
      <p className="lede">
        Session 13’s winner trades ether but takes its orders from bitcoin: when bitcoin is in a bull market it goes big, otherwise
        it stays small. So what happens if the two part ways, bitcoin sliding while ether climbs? We asked the backtest three
        ways: by forcing the bitcoin switch off for the whole history, by forcing it on, and by looking at the real stretches
        where bitcoin was out of its bull and ether went its own way.
      </p>

      <h2>What the switch does, in one breath</h2>
      <p>
        Once a day the bot checks whether bitcoin’s close is above its 140-day average (the bull ends when it closes under that,
        or under its 75-day average). <b>Bull:</b> the breakout and trend rides on ether are four times their normal size, usually
        all in, and profits are banked only after huge gains. <b>No bull:</b> the same rides at normal size, about a third to a
        half of the account, banking half at +16% and half of the rest at +35%, plus careful panic-dip buying. The Session 13 seat
        belt only touches crash buys, so it plays no part in a rising ether.
      </p>
      <p>
        Bitcoin was in a bull 52% of the time since March 2019. Ether rising while bitcoin falls is uncommon but real: over any 60 days
        it has happened in seven separate stretches since then.
      </p>

      <h2>Three versions of history</h2>
      <p>Session 13 #1 on ether, 2019–2026, with the bitcoin switch as it was, never on, and always on. Yearly returns on calendar years.</p>
      <SplitTable rows={SPLIT_RUNS} head={['Bitcoin switch', 'Yearly return', 'Worst drop', 'Time in the market', 'Trades']} />
      <ul>
        <li>
          <b>If bitcoin never has a bull again, the bot still beats holding:</b> +72% a year against +45%, with a smaller worst
          drop of 29%. That is the dip buying and the small rides working on their own. Most of the gap to +110% is the four-times
          positions in 2020–21 and 2024.
        </li>
        <li>
          <b>Always in a bull is not better in the way that matters:</b> +122% a year, but a 45% worst drop, because it would have
          been all in through every ether crash.
        </li>
        <li>
          <b>The switch is a brake more than an engine.</b> Without it the bot earns two thirds of its return at two thirds of the
          exposure. With it always on, it earns a bit more and falls a lot harder.
        </li>
      </ul>

      <div className="callout">
        <p>
          <b>Correction, 31 October.</b> This article first said ether’s one lone rally was spring 2019, when ether rose 63% and the bot made
          15%. That was wrong: bitcoin rose 164% in those months. Its switch only looked off because the data starts in March 2019 and the
          140-day average needs 140 days to warm up. The real stretches are in the next table, and the answer changes a little.
        </p>
      </div>

      <h2>The real stretches: bitcoin down, ether up</h2>
      <p>
        Every 60-day stretch since the switch warmed up in July 2019 where bitcoin fell at least 5% and ether rose at least 10%. Each row is the
        stretch with the widest gap in its period.
      </p>
      <SplitTable rows={REAL_SPLITS} head={['Stretch', 'Bitcoin', 'Ether', 'The bot', 'Time in the market']} />
      <ul>
        <li>
          <b>The two big ones are where it lags most.</b> From March to May 2021 ether rose 123% and the bot made 28%. From July to September
          2022 ether rose 42% and the bot made 2%. It was in the market only about 30% of the time in both.
        </li>
        <li>
          <b>In the smaller ones it does fine,</b> making about half or more of ether’s rise, and it beat ether from January to March 2020. That
          stretch ends just before the crash, so it flatters the bot.
        </li>
        <li>
          <b>It made money in all seven,</b> though it trailed ether in six.
        </li>
      </ul>

      <h2>The real stretches without a bitcoin bull</h2>
      <p>
        Every stretch of two weeks or more where the switch was off, with what ether did and what the bot did. The short ones
        (under four weeks) are left out; they all look like the bot sitting on its hands.
      </p>
      <SplitTable rows={OFF_BULL} head={['Stretch', 'Days', 'Ether', 'The bot', 'Time in the market']} />
      <ul>
        <li>
          <b>In nearly every long no-bull stretch ether fell,</b> and the bot either lost much less or made money while ether lost 29%,
          51% and 41%. That is what the no-bull mode is for.
        </li>
        <li>
          <b>The last two rows are the newest history:</b> while ether lost 41% from October 2025 to May 2026 the bot made 29%,
          and in the quiet summer of 2026 it made 22% against ether’s 3%. These are the stretches the research never tuned on
          the hardest, so they are the most encouraging numbers in the piece.
        </li>
      </ul>

      <h2>The mirror image: bitcoin up, ether down</h2>
      <p>
        This is the dangerous case, not the first one. A bitcoin bull with a weak ether means the bot holds four-times positions
        in a coin that is going nowhere or down, and banks nothing until +57%. The data holds no long stretch of it yet, so this is
        the untested risk. A longer split, months of bitcoin grinding up while ether bleeds, would hurt, and the “always in a bull” row
        above gives a feel for how much: a 45% worst drop.
      </p>

      <h2>What it means</h2>
      <div className="callout brass">
        <p>
          <b>Bitcoin falling while ether rises costs the bot upside, not safety.</b> It would make money, keep its drops small
          and lag holding ether badly. The split to fear is the other one, and the switch cannot see it coming.
        </p>
      </div>
      <ul>
        <li>
          <b>If you believe in an ether-only rally,</b> the bot is the wrong tool for it: in the two big ones it caught a quarter of the
          move or less. Holding some ether on the side is the simple fix.
        </li>
        <li>
          <b>If you believe bitcoin leads and ether follows,</b> which is what the last seven years looked like, the switch is
          doing its job: it kept the bot small in every ether fall that came with a bitcoin bear.
        </li>
        <li>
          <b>A research idea for a later session:</b> let ether’s own trend open the bull sizes too, not only bitcoin’s. The risk
          is that it also opens them in ether’s false starts, which the bitcoin switch currently filters out.
        </li>
      </ul>
      <p className="small soft">
        Method: the family’s bitcoin check was replaced by a constant for the two forced runs; everything else, candles, fees and
        the Session 13 layer, stayed as published. The stretches use the bot’s own daily bull flag on the real data. Past results
        say nothing certain about the future; this is research, not financial advice.
      </p>
    </>
  );
}

type PlainRow = [string, string, string, string];

const NEW_VS_LIVE: PlainRow[] = [
  ['Ether a year, as tuned', '+110%', '+116%', '+45%'],
  ['Ether a year, settings nudged', '+82%', '+84%', '+45%'],
  ['Ether worst fall, as tuned', '−34%', '−32%', '−80%'],
  ['Ether worst fall, settings nudged', '−41%', '−37%', '−80%'],
  ['Bitcoin a year', '+72%', '+68%', '+49%'],
  ['10 coins a year, average', '+89%', '+88%', '+21%'],
  ['19 unseen coins a year, average', '+25%', '+29%', '−22%'],
];

const BLEED_STRETCHES: PlainRow[] = [
  ['Mar – Nov 2024', '−25%', '+2%', '+13%'],
  ['Aug 2025 – Aug 2026', '−51%', '+12%', '+31%'],
  ['Mar – May 2021', '+150%', '+25%', '+15%'],
  ['Jul – Sep 2022', '+74%', '+6%', '+6%'],
];

function TwoWeakSpots() {
  return (
    <>
      <p className="lede">
        Two recent articles found two weak spots in the bot. So we set 30 research agents on them, each trying a different fix. One weak spot
        got better. The other mostly did not. And the test itself taught us something we did not want to hear about the bot running today.
      </p>

      <h2>The two weak spots</h2>
      <p>
        <b>Weak spot one: the bot may be tuned too well to the past.</b> It has about 25 hand-set numbers, like a radio with 25 dials, all turned
        until old songs sounded perfect. That does not prove new songs will. Research on trading is full of strategies that looked brilliant
        on old data and then disappointed.
      </p>
      <p>
        <b>Weak spot two: the bot trades ether but takes its orders from bitcoin.</b> Mostly that has worked. But in two big ether rallies it
        caught only a small part of the rise, and the opposite case worries us more: bitcoin doing fine while ether slowly sinks, with the bot
        holding a big position.
      </p>
      <p>Both matter for the same reason: a backtest is only useful if the future looks a bit like it. These are the two places where it may not.</p>

      <h2>How we went about it</h2>
      <p>
        Each agent took one idea: fewer dials, ether making its own decisions, drop the dip buying, wait for proof before going big, and so on.
        Then came the step that mattered most. We took all 30 results and the running bot and turned every dial a little at random, up to 15%,
        the same way for all of them, 12 times. A good strategy should survive a small bump. One that only works at its exact settings should not.
      </p>
      <p>
        That test shook up the order. One book that had looked like a clear second place ended up level with the running bot. Only two stayed clearly
        ahead when we repeated the test with 24 new random bumps.
      </p>

      <h2>Weak spot one: the honest answer is uncomfortable</h2>
      <ul>
        <li>
          <b>The running bot’s headline numbers are its best case.</b> At its exact settings ether makes +110% a year with a worst fall of 34%.
          With the dials bumped, the typical result is about +82% a year and a 41% fall. That is still far better than holding ether, at +45% a year
          and an 80% fall. But +82% and 41% are the fairer numbers to keep in mind.
        </li>
        <li>
          <b>Hiding the last years confirms it.</b> One agent tuned only on the years up to 2022, then tested on the years after. The worst fall went
          from 32% to 45%. Five such tuned versions tried it, and none beat the running bot on the years they had not seen.
        </li>
        <li>
          <b>Fewer dials works, at a small price.</b> One book went from 25 to 17 numbers and kept most of the result, with ether at +105% a year as
          tuned. In the bump test it was not clearly better than the running bot, though.
        </li>
        <li>
          <b>Dip buying stays.</b> Published research doubts this part, so we tried removing it. Ether fell to +82% a year as tuned and every group of
          coins did worse. One warning: on ether and bitcoin, just three nights carry most of the gain.
        </li>
      </ul>

      <h2>Weak spot two: half solved</h2>
      <ul>
        <li>
          <b>We partly blamed the wrong thing.</b> We said bitcoin’s switch cost the bot the spring 2021 rally. In fact the switch was on more than 90%
          of that time. A different rule held it back: one that keeps the bot out when a coin looks overheated. Removing that rule made results worse overall.
        </li>
        <li>
          <b>Letting ether decide for itself failed.</b> Going big on ether’s own trend meant going big on its false starts: the worst fall rose
          to 39%. Letting all coins vote instead of bitcoin failed too, with every one of the 10 coins earning less.
        </li>
        <li>
          <b>The sinking ether case did improve.</b> The closest real example is 2024: from March to November ether lost 25% while bitcoin rose 7%.
          The running bot made +2% there. The new #1 made +13%.
        </li>
        <li>
          <b>The missed rallies are still missed.</b> No book caught them without giving up more somewhere else. The best small step came from the
          second-placed book, which roughly doubled a very small gain in 2022, from +6% to +11%, while ether rose 74%.
        </li>
      </ul>

      <h2>The new #1: stretched rides wait</h2>
      <p>
        The agent looked at what the worst trades had in common. Most began when a coin had already run far above its usual price, so the bot was
        jumping onto a train that had left the station. The new rule is simple: <b>if a coin is already far above its 100-day average, a new ride buys
        nothing until the price has climbed a bit further.</b> If it really is taking off, the bot joins a little late. If the move was running out of
        steam, the bot stays out. The rule adds one more change: breakout rides end a bit sooner on the way down.
      </p>
      <p>Here it is next to the bot running today, and next to simply holding the coin. “Nudged” is the typical result of the 24 random bumps, so read those lines first.</p>
      <SplitTable wrap rows={NEW_VS_LIVE} head={['', 'Today', 'New #1', 'Hold']} />
      <p>
        So the real improvement is not more profit. Bumped, ether’s yearly return is about the same. The gain is <b>shallower falls</b>, and that is what
        kept it ahead in 20 of the 24 bumps. Here is where it helps and where it hurts, with what ether did and what each book made.
      </p>
      <SplitTable wrap rows={BLEED_STRETCHES} head={['Stretch', 'Ether', 'Today', 'New #1']} />

      <h2>What could go wrong with the new #1</h2>
      <ul>
        <li>
          <b>It knew the answers.</b> The agent built this rule by studying the falls of 2024 and 2025–26, so doing well in exactly those years proves
          little. The fairer test is the 19 coins no agent saw.
        </li>
        <li>
          <b>That fairer test is a mild yes, not a loud one.</b> On average those coins earned more, +29% a year against +25% (holding: −22%). But only 10 of
          the 19 earned more, and a few big winners pull up the average. Worst falls got better on 9 and worse on 8.
        </li>
        <li>
          <b>It joins late by design.</b> In a fast rally that costs real money: from March to May 2021 it made +15% where the running bot made +25%. A market
          that mostly goes straight up would suit it less.
        </li>
        <li>
          <b>Some coins lose out.</b> Bitcoin earns +68% a year against +72%, and Solana and TRON give up more. Link and XRP gain the most.
        </li>
        <li>
          <b>It adds dials.</b> After an article warning about too many settings, it has two more than the running bot, and the shaky inherited ones are
          all still there.
        </li>
        <li>
          <b>The worst case did not move.</b> Across all 36 random bumps the deepest fall on ether was about 52% for the running bot and 51% for the new #1. A
          typical year may be calmer, but a bad setting and a bad market can still hurt about as much.
        </li>
        <li>
          <b>It has never traded real money.</b> Everything here is a backtest.
        </li>
      </ul>

      <h2>Where that leaves us</h2>
      <div className="callout brass">
        <p>
          <b>The new #1 looks like a small, believable improvement: shallower falls at about the same return.</b> It is not a breakthrough, and it does not
          fix the missed rallies. The bigger lesson is about expectations: for either book, about +80% a year and a 40% fall are fairer than the headline
          numbers, and real trading usually comes in lower still.
        </p>
      </div>
      <p>Nothing has changed on the bot: it keeps running the same strategy until the owner chooses to switch.</p>
      <p className="small soft">
        Method: 30 books plus the running bot, every setting nudged by up to 15%, with the same nudge for a setting two books share, except numbers a book hard-coded.
        First 12 draws, then 24 fresh draws for the four leaders. Bumped figures are medians, and the table’s bumped figures come from the 24 draws. All returns after fees, on calendar
        years, on data from 2019 to 2026. Past results say nothing certain about the future; this is research, not financial advice.
      </p>
    </>
  );
}

const LESS_BTC: string[][] = [
  ['Start (Session 14’s #1)', '69.5', '71.4', '43.7', '62.7'],
  ['Start, only its wait lowered', '70.4', '72.7', '45.6', '64.9'],
  ['Coin recovery ride (new #1)', '71.7', '73.0', '44.2', '62.6'],
  ['Own supertrend up', '72.7', '72.7', '46.0', '65.7'],
  ['Force index plus lead', '72.5', '72.9', '45.5', '66.5'],
  ['MACD pushing up', '72.0', '73.3', '45.6', '65.6'],
  ['Fisher turn (agent’s best)', '70.5', '–', '45.6', '65.6'],
  ['Overheated rides trail', '69.4', '–', '43.7', '62.7'],
];

function LessBitcoin() {
  return (
    <>
      <p className="lede">
        The bot trades a coin but takes its big orders from bitcoin. When a coin takes off on its own while bitcoin is weak, it holds back. So we set
        50 research agents on one question: can the new #1 catch more of those coin-specific spikes without giving up what makes it good? The honest
        answer is a little, at a price, and half of the little was one number.
      </p>

      <h2>What we measured</h2>
      <p>
        We looked at every stretch of one to three months in which a coin rose at least 15% <b>and</b> beat bitcoin by at least 15 points over the same
        stretch. There are about 630 of them across the nine coins that are not bitcoin. For each we ask how much of the coin’s rise the book’s account
        kept. We call that <b>overtake kept</b>, from 0 to 100. The start, Session 14’s new #1, keeps <b>70.6</b>: 68.1 on ether and 73.1 on the other eight coins.
      </p>
      <p>
        The ranking put this first and the old strength second: a book lost points for every point it gave up against the start (score, late years, worst
        drops) but earned nothing for gaining strength. Every agent could use any of the TAAPI indicators.
      </p>

      <h2>What the agents tried</h2>
      <p>
        Fifty ideas, all with the same shape: a second key that turns a coin’s own bull on when bitcoin’s is off. Supertrend, Aroon, ichimoku, parabolic
        SAR, Donchian breakouts, KAMA, Hull average, ADX, vortex, Bollinger squeezes, on-balance volume, force index, MACD, Fisher, Williams %R, StochRSI,
        money flow, ranking against the other coins, the coin-to-bitcoin ratio, correlation and beta to bitcoin, a faster hourly lane, a comeback ride
        after a deep fall, and more. Almost all of them gained between one and three points of overtake kept at the agent’s own settings. The best looked
        like 73 to 74.
      </p>

      <h2>The test that mattered</h2>
      <p>
        As in the last session, we did not trust the agents’ own numbers. We took the best 15, plus the start, and nudged every setting by up to 15% in
        12 shared random draws, then repeated with a fresh seed. We also ran them on the 19 coins no agent saw. “Wait lowered” is the start with one
        number changed: how long a ride starting far above its average waits before it holds anything, from 0.25 to 0.1. Many agents had quietly done the
        same, so it is the fair yardstick.
      </p>
      <SplitTable
        wrap
        rows={LESS_BTC}
        head={['Book', 'Kept, nudged', 'Kept, fresh draws', 'Worst drop, nudged', 'Unseen coins, drop']}
      />
      <p className="small soft">
        Kept is overtake kept (median of 12 draws; the second column is a new seed and a different 12). Drops are average worst drops in percent: the ether
        and 10-coin drop for the nudged column, the 19 unseen coins for the last.
      </p>

      <h2>What we found</h2>
      <ul>
        <li>
          <b>The gain is small.</b> On the shared draws the start keeps 69.5. The best books keep 72 to 73, and the single number “wait lowered” already keeps
          70.4. With a fresh seed the start keeps 71.4 and the best 73. So the true gain from a real coin-specific signal is about one to two points out of 100.
        </li>
        <li>
          <b>The agents’ winners did not hold up.</b> The best on its own settings, the Fisher turn, claimed 73.9. On the shared draws it keeps 70.5, level
          with the start.
        </li>
        <li>
          <b>Size is the lever, and size costs drops.</b> Nearly every book gets its gain by trading a coin’s own bull at 1.25 to 1.75 times the normal size.
          Past that, the worst drop jumps: the books were either near 40 or near 51, with little in between. That is leverage, not independence.
        </li>
        <li>
          <b>The books that gain also fall further.</b> On the shared draws the typical worst drop goes from 43.7 for the start to 45 or 46 for most of them.
          On the 19 unseen coins, almost every one with a signal did worse than the start (65 to 66 against 62.7). Only three kept the unseen drops level.
        </li>
        <li>
          <b>Bitcoin’s delay is not the problem.</b> A faster bitcoin switch added a point or two of independence and three to seven of drop, because it is simply
          more time inside bitcoin’s bull. Correlation to bitcoin is high most of the time, so rules that wait for a decoupling almost never fire.
        </li>
        <li>
          <b>The signals come late.</b> A breakout, a trend flip or a momentum cross is seen after the spike has started, so the first and often biggest leg is
          missed. Only about one overtake stretch in ten has bitcoin weak the whole time, and the start already keeps 36% of those.
        </li>
      </ul>

      <h2>The three that placed</h2>
      <p>
        Only three of the tested books also kept the 19 unseen coins’ drops level with the start’s, which was our bar for placing.
      </p>
      <ol>
        <li>
          <b>Coin recovery ride.</b> A coin that was at least 20% under its one-year high within the last half year and closes above its previous 30-day high
          opens its own daily ride, sized by volatility, ending under the 20-day low. It needs no bitcoin bull. Kept 71.7 on the shared draws against 69.5, and
          73.0 against 71.4 on the fresh seed. It keeps 62.2 on the unseen coins against 59.9. The mean yearly return of the 10 coins dips to +82.7% against +87.8%.
        </li>
        <li>
          <b>Own momentum bull.</b> A coin that gained at least 0.5 (in log terms) over the 120 days ending a week ago, and beat bitcoin by 0.3, gets its own bull
          at twice the size. A smaller gain than the first.
        </li>
        <li>
          <b>Overheated rides trail.</b> It changes two numbers the start already had, so it adds no settings. It placed third only by keeping the unseen drops level;
          on the shared draws it does not beat the start.
        </li>
      </ol>

      <h2>Did it solve it?</h2>
      <div className="callout brass">
        <p>
          <b>Not really.</b> The bot can depend a little less on bitcoin, by one to three points of overtake kept out of 100, and the cheap half of that is lowering
          one number. A real coin-specific signal adds about a point on top, and anything bigger buys it with extra size and deeper drops. Where bitcoin is weak but
          a coin runs, the spike is mostly over by the time any signal fires.
        </p>
      </div>
      <p>
        Nothing changed on the bot: it still runs the same strategy until the owner chooses to switch. The tab is Session 15 on the Research page. If a next
        session tries again, the open question is earlier entries, not bigger sizes.
      </p>
      <p className="small soft">
        Method: 50 books, the start and a wait-lowered control. All returns after Bitvavo’s fees, March 2019 to October 2026, each coin from its first candle.
        Everything here is tuned on years the agents had seen. Past results say nothing certain about the future; this is research, not financial advice.
      </p>
    </>
  );
}

type Dial = [string, string, string];

/** A plain table for text: the dial's name, what it does in everyday words, and where it is set. Cells wrap. */
function DialTable({ rows }: { rows: Dial[] }) {
  return (
    <div className="table-wrap">
      <table className="data dial-table">
        <thead>
          <tr>
            <th>Dial</th>
            <th>What it is, like you are five</th>
            <th>Set to</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r[0]}>
              <td>
                <b>{r[0]}</b>
              </td>
              <td>{r[1]}</td>
              <td className="nowrap">{r[2]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const DIALS_BITCOIN: Dial[] = [
  ['btc_days', 'The big question: is bitcoin having a good time? Bitcoin is the bot’s weather report. If its price today is above its average of the last 140 days, it is a “bull”: sunny.', '140 days'],
  ['btc_exit_days', 'A quicker way out. The sun is also gone if bitcoin falls under its shorter 75-day average, even if it is still above the 140-day one.', '75 days'],
  ['btc_band', 'A cushion so the bot does not flip-flop when bitcoin sits right on the line. Zero means no cushion.', 'off (0)'],
  ['bull_size', 'On a sunny day the bot dares more: both rides (below) are four times bigger. They can never be more than “everything we have”.', '4 times'],
  ['bear_size', 'On a cloudy day the rides are the normal size, not smaller.', '1 times'],
  ['bull_take', 'In the sun, each time the bot takes some winnings off the table it takes this share of what is left.', 'half'],
  ['bull_gain', 'In the sun the bot waits longer before taking winnings: three times the normal gain.', '3 times'],
  ['bull_give', 'In the sun the breakout ride may fall back this many times its normal distance before it quits. 1 means the same as always.', '1 times'],
  ['bull_z', 'In the sun the dips (below) count at their normal depth. Below 1 would mean smaller dips already buy.', '1 times'],
  ['core, coin_days', 'A “always keep something” savings position in the sun, only while the coin itself is above its average. Switched off.', 'off (0)'],
];

const DIALS_RIDE: Dial[] = [
  ['high_days', 'The breakout ride: the price must close above the highest close of the last 27 days. Like a kid jumping higher than anyone this month.', '27 days'],
  ['giveback', 'How far the price may fall back from its best since the buy before the bot leaves. It is measured in “daily swings”, the size of a normal day.', '3.9 daily swings'],
  ['hvol_days', 'How many days of history decide how big a “normal day” is.', '11 days'],
  ['target_vol', 'How much of a bumpy ride the bot accepts for one position. It buys this number divided by how wild the coin is: a calm coin gets a big bet, a wild one a small bet.', '0.5 a year'],
  ['gate_days', 'An extra rule: only ride when the price is above this many days’ average. Off.', 'off (0)'],
  ['take_gain', 'When the ride is up about 16%, the bot takes some money out. It does it again at about 35%.', '0.15 (16%)'],
  ['take_frac', 'Each time it takes money out, it sells this share of what is still riding.', 'half'],
  ['s_macd', 'The second ride, built on a gauge called MACD. This is how much of the account it may use. 1 means switched on; 0 would switch it off.', 'on (1)'],
  ['macd_days', 'How slow the MACD gauge is: the number of days that set how it is drawn.', '26 days'],
  ['stretch', 'The MACD ride only quits on a downward cross after the gauge has reached this height. A small wobble is not enough to leave.', '1.0'],
  ['macd_vol', 'The same idea as target_vol, for the MACD ride: calm coins get a bigger bet, wild ones a smaller one.', '0.45 a year'],
  ['ride_1h', 'Look at finished one-hour candles to decide the two rides, not the bot’s own fifteen-minute ones. Slower, calmer decisions.', 'on (1)'],
];

const DIALS_DIPS: Dial[] = [
  ['snap_hours', 'The quick sell-off (the “snap”): how many hours it is measured over. A snap is a sudden drop, like a ball dropped on the floor.', '4 hours'],
  ['snap_vol_days', 'How many days of history decide what a “normal move” is, so the bot knows when a drop is not normal.', '55 days'],
  ['snap_trend_days', 'The daily trend the drop is measured against.', '60 days'],
  ['z_up, z_down', 'How deep a snap must be before the bot buys it, counted in normal moves: 3.0 below a rising trend, 4.4 below a falling one. It is pickier when the trend is falling.', '3.0 and 4.4'],
  ['exit_rsi', 'When the bounce is done, the bot sells the snap. “RSI” is a heat gauge from 0 to 100, and 50 means the bounce has reached the middle.', '50'],
  ['vdip_hours', 'The slow dip: price drifting under its average. This is the average’s length in hours.', '40 hours'],
  ['vdip_z', 'How far under that average the price must be, in wobble units, before the bot buys the slow dip. It sells when price is back at the average.', '2.2'],
  ['ladder_first', 'The dip ladder: the bot does not buy everything at once. At the first trigger it buys this share of the full amount.', 'half'],
  ['ladder_mult', 'It buys the rest when the dip is this many times as deep as the trigger.', '1.25 times'],
  ['fast_z, fast_gain', 'Speed matters. If the last hour fell faster than 4 normal moves, a dip gets one extra helping for every unit faster. A slow drift gets less, or nothing.', '4.0 and 1.0'],
  ['speed_vdip', 'How much the speed rule also applies to the slow dip. 1 means fully.', '1.0'],
];

const DIALS_CYCLE: Dial[] = [
  ['cycle_days', 'The coin’s “very long walk”: the average of its last 450 days. The gauge says how far above that average the price has run.', '450 days'],
  ['cyc_hot', 'When the price is more than about 3.7 times its 450-day average, the coin is overheated, like a pot about to boil over. 1.3 is a log value and equals 3.7 times.', '1.3'],
  ['hot_size', 'In the overheated zone, the breakout ride and the MACD ride are switched off. Zero means no rides at all.', 'off (0)'],
  ['hot_give', 'If rides were allowed there, how much tighter the breakout ride’s exit would be. 1 means the same.', '1 times'],
  ['cyc_on', 'An optional entry check: only ride big once the gauge is above this. Off.', 'off (-9)'],
  ['cyc_btc', '1 means use bitcoin’s own gauge, 0 means the coin’s own. The bot uses the coin’s own.', 'coin’s own (0)'],
];

const DIALS_STOP: Dial[] = [
  ['deep', 'A “crash buy” is any buy made when the coin is at least 30% under its best close of the last 10 days. The idea: buy a falling thing and hope for a quick bounce.', '30% under'],
  ['deep_days', 'How many days back counts when looking for “the best close”.', '10 days'],
  ['hours', 'How long a crash buy gets to bounce. Like giving a ball six hours to come back up.', '6 hours'],
  ['gain', 'What counts as a bounce: the price being 5% above what the bot paid.', '5% above the buy'],
];

const DIALS_BOT: Dial[] = [
  ['coin and candles', 'Which coin the strategy trades and how often it looks: ether (ETH-EUR), a new picture of the price every 15 minutes.', 'ETH-EUR, 15 minutes'],
  ['fees', 'What Bitvavo takes: 0.15% when the bot waits patiently with a limit order, 0.25% when it grabs at once. The bot tries to be patient.', '0.15% / 0.25%'],
  ['chase', 'A resting order is moved to the best price in the book every 30 seconds; if it is still not filled after 10 minutes, the rest is bought or sold at once.', '30 seconds, 10 minutes'],
  ['daily loss guard', 'A seat belt on the whole account. If it loses 15% within 24 hours, the bot stops buying (it can still sell).', '15%, no new buys'],
  ['max exposure', 'An optional euro cap on how much money the bot may use at all. Empty means no cap.', 'owner’s choice'],
];

function EveryDial() {
  return (
    <>
      <p className="lede">
        The bot looks like one thing, but it is really a handful of small helpers, each with a few dials. About forty-four dials in all. This is every
        one of them, in plain words, and how they hand things to each other. Think of it as a toy factory with a weather report at the front door.
      </p>

      <div className="callout brass">
        <p>
          <b>The one-minute version.</b> The bot checks the weather (bitcoin), then runs two “ride the winners” plans and three “buy the dip” plans. In sunny
          weather it bets four times bigger. If the coin is overheated, it stops riding. And a stopwatch takes back any crash buy that did not bounce within six hours.
        </p>
      </div>

      <h2>The map: who talks to whom</h2>
      <ol>
        <li>
          <b>The weather report</b> (bitcoin’s dials) says sun or clouds. It changes how big the rides and the winnings-taking are.
        </li>
        <li>
          <b>The overheating check</b> (the long-walk dials) can switch the rides off when the coin has run too far.
        </li>
        <li>
          <b>The two rides</b> (breakout and MACD) follow winners. How big they are comes from the weather, the coin’s wildness and the overheating check.
        </li>
        <li>
          <b>The three dip buyers</b> (snap, slow dip, ladder) buy falls. Speed decides how much.
        </li>
        <li>
          <b>The stopwatch</b> (time stop) looks at the buys from step 3 and 4 that were “crash buys” and undoes the ones that did not bounce.
        </li>
        <li>
          <b>The seat belts</b> (loss guard, fees, chase) sit around everything.
        </li>
      </ol>

      <h2>1. The weather report: bitcoin</h2>
      <p>
        The bot trades ether but asks bitcoin whether the mood is good. Like checking if the whole class is happy before deciding how loud to be.
      </p>
      <DialTable rows={DIALS_BITCOIN} />
      <p className="small soft">
        <b>Connected:</b> btc_days and btc_exit_days together decide “sun or clouds”. Sun is on only while bitcoin is over its 140-day average <i>and</i> over its
        75-day one. Every other “bull_” dial only matters in the sun, so none of them does anything on a cloudy day.
      </p>

      <h2>2. The rides: following winners</h2>
      <p>
        A ride is simple: when the price jumps higher than it has in a month, jump on, and stay until it falls back too far. There are two of them.
      </p>
      <DialTable rows={DIALS_RIDE} />
      <p className="small soft">
        <b>Connected:</b> the size of a ride is target_vol divided by the coin’s wildness, then multiplied by bull_size in the sun. The giveback tells it when to
        leave, take_gain and take_frac tell it when to take some winnings, and in the sun bull_gain and bull_take change those. hvol_days sets what a
        “daily swing” is, which is the ruler for giveback.
      </p>

      <h2>3. The dips: buying falls</h2>
      <p>
        Dips are the opposite of rides: the price drops, and the bot bets it will come back. There are three kinds that work together.
      </p>
      <DialTable rows={DIALS_DIPS} />
      <p className="small soft">
        <b>Connected:</b> the snap and the slow dip decide <i>whether</i> to buy. The ladder decides <i>how much at first</i>. Speed (fast_z, fast_gain,
        speed_vdip) decides <i>how much more</i>. Sizes only go up while a dip is being held. They never go down by themselves.
      </p>

      <h2>4. The overheating check: the long walk</h2>
      <p>
        Rides are for coins that have room to run. A coin that has already run to almost four times its long-run average is more likely to turn than to keep
        going. This check says “not now” when that happens. It is the reason the bot sat out a couple of ether’s biggest spikes.
      </p>
      <DialTable rows={DIALS_CYCLE} />
      <p className="small soft">
        <b>Connected:</b> cyc_hot and hot_size are the pair that matters: cross the line, and the size drops to zero.
      </p>

      <h2>5. The stopwatch: the crash-buy time stop</h2>
      <p>
        This is the one extra helper bolted on in Session 13. It watches the buys made while the coin is in a deep fall. If the bounce has not come within
        six hours, it takes those buys back, and the position stays small until the main strategy is flat again. Rides and everything else are left alone.
      </p>
      <DialTable rows={DIALS_STOP} />
      <p className="small soft">
        <b>Connected:</b> the stopwatch uses the buys from the dips (and any ride that happens to buy deep). It does not change a single dial above. It only
        takes buys back.
      </p>

      <h2>6. The seat belts around everything</h2>
      <p>These are not part of the strategy. They are the rules of the house, and they can be changed in the bot’s settings.</p>
      <DialTable rows={DIALS_BOT} />

      <h2>A day in the life, in six sentences</h2>
      <ol>
        <li>Every 15 minutes the bot looks at ether and at bitcoin’s weather.</li>
        <li>Sunny: it sizes the rides four times bigger. Cloudy: the normal size.</li>
        <li>Ether jumps above its one-month high: a ride starts, small if ether is wild and big if it is calm.</li>
        <li>The price rises 16%: the bot takes half of the ride’s money out, and again at 35%.</li>
        <li>Ether crashes hard instead: the dip buyers pick it up in steps, more if it fell fast.</li>
        <li>If that crash buy has not bounced in six hours, the stopwatch undoes it.</li>
      </ol>

      <div className="callout">
        <p>
          <b>About the numbers.</b> Dials like 27 days or 3.9 swings were found by testing on the past, and they sit on a plateau: nudging one by 15% costs a
          little, but nothing breaks. That is why the research articles keep asking how many dials are really needed. These are the live bot’s settings
          as of today. If the owner switches strategy, this list changes.
        </p>
      </div>
      <p className="small soft">
        Research, not financial advice. Past results say nothing certain about the future.
      </p>
    </>
  );
}

const S15_REAL: string[][] = [
  ['Sep 2019', '−10%', '+12%', '+4%', '+4%', '84%'],
  ['May 2020', '−10%', '+12%', '+10%', '+7%', '72%'],
  ['Feb 2021', '−8%', '+27%', '+41%', '+29%', '41%'],
  ['Mar 2021', '−12%', '+125%', '+18%', '+45%', '73%'],
  ['Oct 2021', '−10%', '+24%', '+13%', '+19%', '67%'],
  ['Jun 2022', '−9%', '+32%', '+1%', '+7%', '71%'],
  ['Jul 2022', '−6%', '+43%', '+2%', '+9%', '79%'],
  ['Jul 2025', '−5%', '+14%', '+14%', '+12%', '100%'],
];

const S15_FAKE: string[][] = [
  ['Lone climb', '−15%', '+49%', '+9%', '+13%'],
  ['Late spike', '−12%', '+60%', '+16%', '+23%'],
  ['Violent rebound', '−10%', '+70%', '+32%', '+24%'],
  ['Fake-out', '−18%', '−10%', '+2%', '+1%'],
];

function BitcoinDownS15() {
  return (
    <>
      <p className="lede">
        What does the number one of Session 15 do when bitcoin sinks and ether runs? We answered it two ways: eight real stretches from the past, and
        four made-up futures that we ran through the same backtester. The short version: it catches a slice of the run, never the whole thing, and it
        is not afraid of a fake-out.
      </p>

      <h2>First, who is the number one?</h2>
      <p>
        It is <b>Session 14’s old number one</b>, plus one extra helper called the <b>coin recovery ride</b>. The old book watches bitcoin like a weather
        report: sunny means big bets, cloudy means normal ones. The new helper does not look at bitcoin at all. It wakes up when two things are true:
      </p>
      <ul>
        <li>
          <b>The coin has been hurt.</b> Within the last half year it was at least 20% under its one-year high.
        </li>
        <li>
          <b>And now it is climbing out.</b> Today’s close beats the highest close of the last 30 days.
        </li>
      </ul>
      <p>
        Then it buys. How much? <b>0.5 divided by how wild the coin is</b> (a calm coin gets a big bet, a wild one a small bet), and never more than half
        the account. It leaves when the price closes under the lowest close of the last 20 days. Of all the rides that want to be in at once, the biggest one
        wins. The rest of the old book keeps doing its own thing next to it.
      </p>

      <div className="callout">
        <p>
          <b>In kid words.</b> Bitcoin is the weatherman. The old book will not go big unless he says sunny. The recovery ride is a second kid at the window
          who says: “I do not care what he says. My coin just got up off the floor, so I will take a small, careful step.”
        </p>
      </div>

      <h2>The real examples</h2>
      <p>
        Every 60-day stretch since mid-2019 where bitcoin fell at least 5% and ether rose at least 10%, one for each period (the one with the widest gap).
        The bot trades ether only. “Start” is Session 14’s #1 without the helper.
      </p>
      <SplitTable rows={S15_REAL} head={['60 days from', 'Bitcoin', 'Ether', 'Start', 'Session 15 #1', 'Time in the market']} />
      <ul>
        <li>
          <b>It made money in all eight.</b> It trailed ether in seven of them and beat it once, in February 2021.
        </li>
        <li>
          <b>The helper matters most where the start sits out.</b> In March 2021 ether rose 125% while bitcoin fell 12%. The start made 18%, mostly because it
          waits when a coin is already far above its average. The #1 made 45%: it was in the market 73% of the time instead of 36%. In June and July 2022 it
          turned +1% and +2% into +7% and +9%.
        </li>
        <li>
          <b>It is not always better.</b> In February 2021 the start made 41% and the #1 only 29%, even though the #1 was in the market longer (41% of the time against 28%). In May 2020 and
          July 2025 it also made a little less than the start.
        </li>
        <li>
          <b>It never gets close to ether’s full run.</b> It is in the market a part of the time and sizes by wildness, so a 125% rise becomes 45%. That is the
          price of not blowing up when the same jump goes the other way.
        </li>
      </ul>

      <h2>The made-up examples</h2>
      <p>
        Real history has only a few of these. So we made four. Each one picks up on 1 January 2023: ether has just fallen 67% under its one-year high and
        bitcoin is not in a bull. Then a 90-day future is drawn by hand with a bit of random wobble (ether 4.5% a day, bitcoin 2.5%), and both books trade it candle by
        candle with Bitvavo’s fees.
      </p>
      <SplitTable rows={S15_FAKE} head={['Made-up future', 'Bitcoin', 'Ether', 'Start', 'Session 15 #1']} />
      <ul>
        <li>
          <b>Lone climb:</b> bitcoin slides 15%, ether climbs 49% in a steady line. Both books ride it; the #1 trades 7 times against the start’s 15 and ends with +13% against +9%.
        </li>
        <li>
          <b>Late spike:</b> ether sleeps for six weeks, then jumps 60%. The #1 ends with +23% against +16%, again with half the trades (6 against 12).
        </li>
        <li>
          <b>Violent rebound:</b> ether jumps 70% in three weeks. This is the one where the helper loses: +24% against +32%, and it trades 5 times against 13. In this path the start’s own
          rides were the better fit and the helper’s extra entry gave no edge. We did not dig for more reason than that.
        </li>
        <li>
          <b>Fake-out:</b> ether jumps 40%, then gives it all back, ending 10% down. Both books give back almost everything they made on the way up and end about flat (+2% and +1%), while ether
          itself ends 10% down. It does not lose money on a spike that fails.
        </li>
      </ul>
      <p className="small soft">
        A first version with a calmer ether (2.5% a day) gave identical results for both books in the first two futures, because the start was already
        all-in. The helper only changes anything when the old book would have held back.
      </p>

      <h2>What this tells us</h2>
      <div className="callout brass">
        <p>
          <b>If bitcoin falls and ether rises, the bot still takes part, but only as a careful passenger.</b> The recovery ride lifts a typical slice of the run
          by a few points, and a lot more when the old book would have waited. It does not chase the whole move, and it has not shown it can reliably beat the
          start in a very sharp jump. The fake-out is the real test of the helper, and it passes: it does not lose money on a spike that fails.
        </p>
      </div>
      <p>
        Nothing changed on the bot: it keeps running the same strategy until the owner chooses to switch.
      </p>
      <p className="small soft">
        Method: the real rows come from the same backtest as the Session 15 tab, with Bitvavo’s fees. The made-up rows are one random draw each, so another draw
        would move the numbers by a few points but not the order of the story. Past results say nothing certain about the future; this is research, not
        financial advice.
      </p>
    </>
  );
}

export const ARTICLES: Article[] = [
  {
    slug: 'bitcoin-down-s15',
    title: 'If bitcoin falls and ether rises: what Session 15’s number one does',
    blurb: 'Eight real stretches and four made-up futures where bitcoin sinks and ether climbs, run through the new #1 and the book it came from: how much of the run it catches, where it loses, and what a fake-out does.',
    date: '2026-10-31T18:30:00+01:00',
    minutes: 6,
    tag: 'Research',
    body: BitcoinDownS15,
  },
  {
    slug: 'every-dial',
    title: 'Every dial on the bot, explained like you are five',
    blurb: 'All forty-four settings the live bot trades on, in plain words, grouped by job, with how they hand things to each other: the weather report, the rides, the dips, the overheating check and the stopwatch.',
    date: '2026-10-31T17:00:00+01:00',
    minutes: 10,
    tag: 'How it works',
    body: EveryDial,
  },
  {
    slug: 'less-bitcoin',
    title: 'Less bitcoin, 50 tries: can the new #1 move on its own?',
    blurb: 'We set 50 research agents on the bot’s habit of waiting for bitcoin when a coin takes off alone. How much of those spikes it now keeps, what half of the gain really was, and what it costs.',
    date: '2026-10-31T15:30:00+01:00',
    minutes: 7,
    tag: 'Research',
    body: LessBitcoin,
  },
  {
    slug: 'two-weak-spots',
    title: 'Two weak spots, 30 tries: what we fixed and what we could not',
    blurb: 'Why we went after the two problems from the last articles, how it went, and how the new #1 compares with the bot running today, including what could go wrong with it.',
    date: '2026-10-31T11:00:00+01:00',
    minutes: 7,
    tag: 'Research',
    body: TwoWeakSpots,
  },
  {
    slug: 'if-bitcoin-falls-and-ether-rises',
    title: 'If bitcoin falls and ether rises: what the seat belt bot would do',
    blurb: 'Session 13’s winner takes its orders from bitcoin while trading ether. We forced the bitcoin switch off, forced it on, and looked at every real stretch where the two parted ways.',
    date: '2026-10-30T23:33:00+01:00',
    minutes: 6,
    tag: 'Research',
    body: BitcoinDownEtherUp,
  },
  {
    slug: 'does-the-world-know-this-trick',
    title: 'Does the world already know this trick?',
    blurb: 'Session 13’s winner is a trend rule with a bitcoin switch, a dip buyer and a time stop. What the research literature found when it tested the same ideas, where they stand against known strategies, and how likely they are to beat holding ether.',
    date: '2026-10-30T23:33:00+01:00',
    minutes: 8,
    tag: 'Research',
    body: DoesTheWorldKnow,
  },
  {
    slug: 'the-seat-belt',
    title: 'The seat belt: Session 13’s winner against the bot you run',
    blurb: 'Session 13 added one careful habit to the strategy the bot runs and cut ether’s worst drop from 52% to 34%. What it does, explained simply, how likely each is to last, and which one to run.',
    date: '2026-10-30T23:33:00+01:00',
    minutes: 6,
    tag: 'Research',
    body: SeatBelt,
  },
  {
    slug: 'how-the-bot-trades',
    title: 'How the bot trades, in plain language',
    blurb: 'When it buys, when it sells, and when it stays out: real market moments with charts of every trade, from the biggest earners to the times it goes wrong.',
    date: '2026-10-30T18:05:00+01:00',
    minutes: 12,
    tag: 'How it works',
    body: HowItTrades,
  },
  {
    slug: 'twenty-nine-coins',
    title: 'Tested on 29 coins: why the cycle bull wins',
    blurb: 'The number one of Sessions 6 to 10, run unchanged on 19 coins no research agent ever saw. Session 9’s cycle bull comes out on top, and its main rule is why.',
    date: '2026-10-29T23:12:00+01:00',
    minutes: 5,
    tag: 'Research',
    body: AllCoins,
  },
  {
    slug: 'will-the-winners-last',
    title: 'Will the winners last?',
    blurb: 'An honest look at the top strategy of the last five research sessions: why each could keep working, why it could fail, and which one is the safest bet.',
    date: '2026-10-29T22:27:00+01:00',
    minutes: 6,
    tag: 'Research',
    body: WillItLast,
  },
];

export const articleBySlug = (slug: string) => ARTICLES.find((a) => a.slug === slug);
