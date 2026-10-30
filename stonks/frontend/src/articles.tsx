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

function SplitTable({ rows, head }: { rows: string[][]; head: string[] }) {
  return (
    <div className="table-wrap">
      <table className="data">
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
                <td key={i} className={i ? 'r tnum nowrap' : 'nowrap'}>
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

export const ARTICLES: Article[] = [
  {
    slug: 'if-bitcoin-falls-and-ether-rises',
    title: 'If bitcoin falls and ether rises: what the seat belt bot would do',
    blurb: 'Session 13’s winner takes its orders from bitcoin while trading ether. We forced the bitcoin switch off, forced it on, and looked at every real stretch where the two parted ways.',
    date: '2026-10-31',
    minutes: 6,
    tag: 'Research',
    body: BitcoinDownEtherUp,
  },
  {
    slug: 'does-the-world-know-this-trick',
    title: 'Does the world already know this trick?',
    blurb: 'Session 13’s winner is a trend rule with a bitcoin switch, a dip buyer and a time stop. What the research literature found when it tested the same ideas, where they stand against known strategies, and how likely they are to beat holding ether.',
    date: '2026-10-31',
    minutes: 8,
    tag: 'Research',
    body: DoesTheWorldKnow,
  },
  {
    slug: 'the-seat-belt',
    title: 'The seat belt: Session 13’s winner against the bot you run',
    blurb: 'Session 13 added one careful habit to the strategy the bot runs and cut ether’s worst drop from 52% to 34%. What it does, explained simply, how likely each is to last, and which one to run.',
    date: '2026-10-31',
    minutes: 6,
    tag: 'Research',
    body: SeatBelt,
  },
  {
    slug: 'how-the-bot-trades',
    title: 'How the bot trades, in plain language',
    blurb: 'When it buys, when it sells, and when it stays out: real market moments with charts of every trade, from the biggest earners to the times it goes wrong.',
    date: '2026-10-30',
    minutes: 12,
    tag: 'How it works',
    body: HowItTrades,
  },
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
