import type { ReactNode } from 'react';
import { CHARTS } from './data';
import { ChartLegend, ChartNotes, TradeChart, type Note } from './TradeChart';
import './howItTrades.css';

function Section({ n, title, teaser, tag, children }: { n: number; title: string; teaser: string; tag?: string; children: ReactNode }) {
  return (
    <details className="hit-sec">
      <summary>
        <span className="hit-sec-n">{n}</span>
        <span className="hit-sec-head">
          <span className="hit-sec-title">{title}</span>
          <span className="hit-sec-teaser">{teaser}</span>
        </span>
        {tag && <span className="chip brass hit-sec-tag">{tag}</span>}
      </summary>
      <div className="hit-sec-body">{children}</div>
    </details>
  );
}

function Example({ chart, label, title, notes, bull, hot, log, children }: { chart: string; label: string; title: string; notes?: Note[]; bull?: boolean; hot?: boolean; log?: boolean; children?: ReactNode }) {
  return (
    <figure className="hit-fig">
      <figcaption>{title}</figcaption>
      <ChartLegend bull={bull} hot={hot} />
      <TradeChart data={CHARTS[chart]} label={label} log={log} />
      {notes && <ChartNotes notes={notes} />}
      {children}
    </figure>
  );
}

function Result({ bot, eth }: { bot: string; eth: string }) {
  return (
    <div className="hit-result">
      <div>
        <span className="tiny muted">The bot, over this chart</span>
        <b className="tnum">{bot}</b>
      </div>
      <div>
        <span className="tiny muted">Just holding ETH</span>
        <b className="tnum">{eth}</b>
      </div>
    </div>
  );
}

const SIZES: [string, string, string][] = [
  ['Bitcoin bull market, and ETH is at a new high or its trend is rising', '100%', 'Everything points the same way, so it goes all in.'],
  ['No bull market, ETH rising, and ETH is calm', '50 to 100%', 'Calm prices are less likely to shake it out.'],
  ['No bull market, ETH rising, and ETH is wild', '25 to 50%', 'The same idea, with less at stake while prices swing hard.'],
  ['A rally has run a long way', 'Trims a part', 'It banks some of a new-high ride and lets the rest run. In a bull market it waits for far bigger gains first.'],
  ['A slow slide well below the recent price', '25 to 50%', 'A slow fall often keeps falling, so it starts small, or doesn’t buy at all if the fall is very slow.'],
  ['A very fast crash', '75 to 100%', 'Fast panics tend to snap back, so it bets more.'],
  ['The drop keeps going after the first buy', 'Adds, up to 100%', 'It keeps some back on purpose, for a better price.'],
  ['ETH is overheated', 'Only panic buys', 'A drop is overdue, so it stops riding the rally.'],
  ['None of the above', '0%', 'It waits in euros.'],
];

const YEARS: [string, string, string][] = [
  ['2019 (from March)', '+4%', '−5%'],
  ['2020', '+241%', '+426%'],
  ['2021', '+718%', '+436%'],
  ['2022', '+8%', '−66%'],
  ['2023', '+72%', '+86%'],
  ['2024', '+79%', '+55%'],
  ['2025', '+77%', '−21%'],
  ['2026 (until 30 Oct)', '+67%', '−20%'],
];

export function HowItTrades() {
  return (
    <>
      <p className="lede">
        The bot looks at the market every 15 minutes and asks one question: is a rise or a drop more likely right now? The answer decides how much of
        the pot sits in ether (ETH) and how much waits in euros. Here is what that looks like in real market moments, in plain language.
      </p>

      <div className="hit-tiles">
        <div>
          <b className="tnum">45%</b>
          <span className="small soft">of the time it holds only euros</span>
        </div>
        <div>
          <b className="tnum">38%</b>
          <span className="small soft">of the time it is all in</span>
        </div>
        <div>
          <b className="tnum">17%</b>
          <span className="small soft">of the time it is partly in</span>
        </div>
      </div>

      <h2>The idea in four sentences</h2>
      <ul>
        <li>
          <b>Bitcoin sets the mood.</b> The bot trades ETH but watches bitcoin, because crypto bull markets lift nearly everything at once.
        </li>
        <li>
          <b>In a bitcoin bull market it wants to be all in</b> whenever ETH is rising.
        </li>
        <li>
          <b>Outside a bull market it holds much less, often nothing,</b> and waits for panic drops to buy.
        </li>
        <li>
          <b>It sells when a drop looks likely:</b> the rise has run out of steam, the bounce has happened, or the market has become overheated.
        </li>
      </ul>
      <p>
        Open any section below. They run from what makes the most money or happens most often to the rarer cases. Every chart is a real stretch of ETH
        prices with this plan replayed over it, Bitvavo’s fees included. The numbered dots match the story under each chart.
      </p>

      <div className="hit-list">
        <Section n={1} title="Bitcoin is in a bull market: all in, and stay in" teaser="One buy, one sell, weeks of patience." tag="Biggest earner">
          <p>
            This is where the money comes from. Roughly three quarters of all growth in the replay was made here, in about a third of the time. When
            bitcoin is in a bull market and ETH starts rising, a further rise looks likely, so the bot puts the whole pot in ETH. Then it sits still. Small
            dips don’t bother it.
          </p>
          <Example
            chart="oneRide"
            title="Autumn 2023: one buy, one sell"
            label="ETH from October 2023 to January 2024 with one buy near 1,516 euros and one sell near 1,994 euros"
            notes={[
              { day: '21 Oct, €1,516', act: 'buy', text: 'Bitcoin is in a bull market and ETH’s slow trend turns upward. A rise looks likely, so we go all in.' },
              { day: '19 Dec, €1,994', act: 'sell', text: 'ETH’s slow trend turns down. The rise looks finished and a drop looks more likely, so we sell everything.' },
            ]}
          >
            <Result bot="+31%" eth="+46%" />
          </Example>
          <p>
            That trade made 31%, the same as ETH over those two months. The bot saw several small dips on the way and did nothing, because it was already all in.
            The sell came a little early here: ETH kept rising for a while, which is why holding ends ahead on this chart. In January, when ETH reached a new
            high, the bot bought again.
          </p>
        </Section>

        <Section n={2} title="A rally starts before the bull market: small first, then all in" teaser="It doesn’t bet everything until bitcoin agrees." tag="Not all in">
          <p>
            Sometimes ETH turns up while bitcoin hasn’t confirmed a bull market yet. A rise looks possible, but it isn’t convincing. So the bot starts small
            and adds as the picture improves.
          </p>
          <Example
            chart="buildUp"
            title="Spring 2025: 25%, then 50%, then 100%"
            label="ETH from April to June 2025 with the position growing from a quarter to everything, then one sell"
            notes={[
              { day: '16 Apr, €1,384', act: 'buy', text: 'ETH’s trend turns up, but there’s no bull market and prices are still swinging wildly after a crash. We buy only a quarter.' },
              { day: '19 Apr, €1,405', act: 'buy', text: 'The swings calm down, so holding more is less risky. We go to half.' },
              { day: '23 Apr, €1,580', act: 'buy', text: 'Bitcoin enters a bull market. Now everything agrees, so we go all in.' },
              { day: '15 Jun, €2,189', act: 'sell', text: 'ETH’s trend turns down, so a drop looks likely and we sell it all.' },
            ]}
          >
            <Result bot="+47%" eth="+32%" />
          </Example>
          <p>
            Starting small costs something in a rally like this one. From the first buy to the sell ETH itself rose 58%, and the bot made 47%. That’s the price of not
            being all in on the many false starts, when ETH turns up and then falls straight back.
          </p>
        </Section>

        <Section n={3} title="A long climb: many small buys and sells along the way" teaser="It keeps adjusting, then leaves when the rise breaks." tag="Many trades">
          <p>
            Not every rise is one clean trade. Over a long climb the bot keeps resizing: more when ETH is calm, a little less when it gets nervous. After the
            climb ends it may hop in and out a few more times on sharp drops.
          </p>
          <Example
            chart="longClimb"
            title="Summer 2026: a climb of three months"
            label="ETH from June to October 2026 rising from about 1,400 to 2,300 euros with many small trades"
            notes={[
              { day: '3 Jul, €1,527', act: 'buy', text: 'ETH’s trend turns up. No bull market yet, so we buy half.' },
              { day: '5 Jul, €1,544', act: 'buy', text: 'ETH calms down, so we add and hold three quarters.' },
              { day: '26 Jul, €1,658', act: 'buy', text: 'Calmer still: we reach all in. For a week after this we move between three quarters and everything, as ETH’s swings grow and shrink. The small markers show each move.' },
              { day: '8 Oct, €2,269', act: 'sell', text: 'The bull market that began in August is still on, but ETH has fallen too far from its peak. The climb looks over, so we sell everything.' },
              { day: '8 Oct, €2,201', act: 'buy', text: 'Hours later ETH drops sharply. A panic drop tends to bounce, so we buy, and go all in 15 minutes later.' },
              { day: '8 Oct, €2,207', act: 'sell', text: 'The bounce has come. We sell, about even.' },
              { day: '13 Oct, €2,216', act: 'sell', text: 'Same again: bought in steps on the night of 12 October around €2,180, sold on the bounce.' },
            ]}
          >
            <Result bot="+46%" eth="+55%" />
          </Example>
        </Section>

        <Section n={4} title="A panic drop: buy it, sell the bounce" teaser="Its most frequent trade, usually over within hours." tag="Most trades">
          <p>
            When ETH falls far more than normal within hours, that’s usually people panicking, not a change in what ETH is worth. A bounce looks likely, so
            the bot buys. As soon as the bounce arrives it sells again, because it isn’t trying to stay.
          </p>
          <p>
            More than half of all trades in the replay are this kind: 50 of 92. They last about seven hours, 72% of them win, and the typical result is small:
            about +1%. They earn less than the bull market rides, but they also make money when the market is falling.
          </p>
          <p>
            <b>How much it buys depends on the speed of the fall.</b> A fast crash gets a big buy, a slow slide a small one.
          </p>
          <Example
            chart="panic"
            bull={false}
            title="February 2026: two panic buys in one week"
            label="ETH in early February 2026 falling from about 1,900 to 1,500 euros, with two buys near the lows and two sells on the bounces"
            notes={[
              { day: '3 Feb, €1,807', act: 'buy', text: 'A sharp drop, so a bounce looks likely. We buy three quarters.' },
              { day: '3 Feb, €1,903', act: 'sell', text: 'Two hours later the bounce is there. We sell.' },
              { day: '6 Feb, €1,504', act: 'buy', text: 'A much faster crash. We go all in at once.' },
              { day: '6 Feb, €1,694', act: 'sell', text: 'ETH is back near its recent average. The bounce has happened, so we sell: 12% in sixteen hours.' },
            ]}
          >
            <Result bot="+17%" eth="−12%" />
          </Example>
          <div className="callout">
            <p>
              <b>The latest real trade was one of these.</b> On the evening of 29 October 2026 ETH dropped suddenly and the bot bought with the whole pot.
              The next morning it sold again. The replay of that trade shows €2,015 in and €2,008 out, nearly flat. The real orders filled at €2,030.70 and
              €2,012.08, about half a percent worse overall, because the bot waits for a good price rather than paying the market price straight away, and on a
              fast bounce that can cost a little. Real results will usually trail a replay.
            </p>
          </div>
        </Section>

        <Section n={5} title="A crash week: in and out, again and again" teaser="Each new leg down is a new buy, sized by how fast it falls." tag="Not all in">
          <p>
            In a real crash the panic buy repeats. The bot buys, sells the bounce, and buys the next leg down. It usually doesn’t spend everything at
            once: the first buy keeps something back, in case ETH falls further.
          </p>
          <Example
            chart="crashWeek"
            bull={false}
            title="May 2022: the week of the LUNA collapse"
            label="ETH in May 2022 falling from about 2,400 to below 2,000 euros, with four rounds of buying and selling"
            notes={[
              { day: '9 May, €2,138', act: 'buy', text: 'A fast crash. We buy three quarters.' },
              { day: '10 May, €2,287', act: 'sell', text: 'It bounces. We sell for a 5% gain and are back in euros.' },
              { day: '11 May, €2,071', act: 'buy', text: 'A faster leg down. All in.' },
              { day: '11 May, €2,235', act: 'sell', text: 'Under two hours later the bounce is there. We sell for an 8% gain.' },
              { day: '11 May, €2,117', act: 'buy', text: 'ETH slides again, but more slowly. We buy only a quarter.' },
              { day: '11 May, €2,002', act: 'buy', text: 'It’s getting deeper, so we add and hold three quarters.' },
              { day: '12 May, €2,024', act: 'sell', text: 'A small bounce. We sell, about even.' },
              { day: '12 May, €1,825', act: 'buy', text: 'The hardest fall of the week. Three quarters, and all in half an hour later. ETH briefly fell further, to about €1,650, and we had nothing left to add.' },
              { day: '13 May, €1,982', act: 'sell', text: 'ETH recovers to its recent average. We sell for an 8% gain.' },
            ]}
          >
            <Result bot="+22%" eth="−17%" />
          </Example>
        </Section>

        <Section n={6} title="Nothing to do: sit in euros" teaser="Its most common state, and how it dodges the worst." tag="Most of the time">
          <p>
            No rise in sight, no panic to buy: then the bot holds only euros, and that’s the case 45% of the time. It feels like doing nothing, but this is
            what protects the pot. If a drop looks likely and nothing argues against it, not owning ETH is the trade.
          </p>
          <Example
            chart="cash"
            title="Winter 2021: a long wait while ETH fell by almost half"
            label="ETH from November 2021 to January 2022 falling from about 4,000 to 2,100 euros, with the bot mostly out of the market"
            notes={[
              { day: '18 Nov, €3,526', act: 'sell', text: 'The new-high ride ended a day earlier and now ETH’s slow trend turns down too. We’re out.' },
              { day: '1 Dec, €4,211', act: 'buy', text: 'A new high in a bull market, so we go all in. This one doesn’t work out.' },
              { day: '4 Dec, €3,762', act: 'sell', text: 'Bitcoin’s bull market ends that day, and we sell half straight away. A crash that morning triggers one last panic buy, which we sell on the bounce. Now a bigger drop looks likely and there’s no reason to own ETH.' },
              { day: '22 Jan, €2,102', act: 'buy', text: 'Seven weeks later: the next panic drop. We buy again, and sell the bounce a day later.' },
            ]}
          >
            <Result bot="−12%" eth="−47%" />
          </Example>
          <p>
            Some waits saved a lot. From 4 December to 22 January ETH fell 44% while the pot sat in euros. Waiting isn’t always free, though: in late
            January 2022 the bot sat out a 35% rise in two weeks.
          </p>
        </Section>

        <Section n={7} title="The trend breaks: sell before the drop" teaser="A loss taken early, to avoid a bigger one." tag="Sell signal">
          <p>
            Not every sell is at a profit. When ETH’s slow trend turns down, a bigger drop looks likely, even if the bot is sitting on a loss. It sells anyway.
          </p>
          <Example
            chart="trendBreak"
            title="Summer 2024: out before the crash, then a dip buy too early"
            label="ETH from July to August 2024 falling from about 3,200 to 2,300 euros, with a sell near 2,950 euros before the crash"
            notes={[
              { day: '21 Jul, €3,213', act: 'buy', text: 'Bull market, and ETH’s trend turns up. All in.' },
              { day: '1 Aug, €2,947', act: 'sell', text: 'The trend turns down. A drop looks likely, so we take a loss of about 9% and leave.' },
              { day: '4 Aug, €2,522', act: 'buy', text: 'The drop comes, and it’s a panic. After a first attempt on 2 August ended flat, we buy three quarters, then everything half an hour later.' },
              { day: '6 Aug, €2,325', act: 'sell', text: 'ETH bottoms near €2,000 and bounces. We sell for a 7% loss: this panic buy came too early.' },
            ]}
          >
            <Result bot="−16%" eth="−20%" />
          </Example>
          <p>The sell on 1 August was right. Selling there avoided most of a fall to about €2,000. The panic buy after it gave part of that back.</p>
        </Section>

        <Section n={8} title="The market overheats: sell into the rally" teaser="A rare moment when it sells while prices are still rising." tag="Sell signal">
          <p>
            When ETH trades far above its long-term average, the rally has become a mania, and a sharp drop is overdue. This only counts during a bitcoin bull
            market, about 2.5% of the time. The bot then stops riding the rally and only buys panic drops. When ETH cools off, it goes back in.
          </p>
          <Example
            chart="overheat"
            hot
            title="January 2021: selling into a very fast rise"
            label="ETH from December 2020 to January 2021 almost doubling, a sell near 973 euros and short panic trades after it"
            notes={[
              { day: '17 Dec, €528', act: 'buy', text: 'A new high in a bull market. All in.' },
              { day: '7 Jan, €973', act: 'sell', text: 'ETH has nearly doubled in three weeks and is overheated. A drop looks likely, so we sell everything for an 84% gain.' },
              { day: '8 Jan, €918', act: 'buy', text: 'The drop starts. Panic buying is the only thing allowed now: a quarter, then all in at €880.' },
              { day: '8 Jan, €959', act: 'sell', text: 'The bounce is there. We sell. The same thing happens three more times in four days.' },
              { day: '12 Jan, €874', act: 'buy', text: 'ETH has cooled down. The bull market is still on, so we’re all in again.' },
              { day: '15 Jan, €1,014', act: 'sell', text: 'Overheated again, so we sell again.' },
            ]}
          >
            <Result bot="+169%" eth="+139%" />
          </Example>
          <p>
            It doesn’t always work this well. From 27 April to 13 May 2021 ETH kept climbing, from about €2,080 to €3,250, while the bot was almost entirely
            out. Overheated markets can stay overheated for longer than you’d think.
          </p>
        </Section>

        <Section n={9} title="When it goes wrong" teaser="Buying right before a crash, and buying a crash that keeps going." tag="Losses">
          <p>The two costliest mistakes come from the two main habits. A rally can end the moment the bot joins it, and a drop can go on longer than expected.</p>
          <Example
            chart="wrong"
            title="October 2025: all in, three days before a crash"
            label="ETH in October 2025 with an all-in buy near 4,067 euros and a sell near 3,475 euros"
            notes={[
              { day: '7 Oct, €4,067', act: 'buy', text: 'A new high in a bull market. All in, as usual.' },
              { day: '12 Oct, €3,475', act: 'sell', text: 'A sudden crash on 10 October ends the ride, but the same crash counts as a panic drop to buy, so we stay all in. Two days later ETH is back at its recent average and we sell: a loss of 15%.' },
            ]}
          >
            <Result bot="−15%" eth="−10%" />
          </Example>
          <ul>
            <li>
              <b>A drop that keeps going.</b> In the spring of 2025 the bot held half the pot on a rising trend when ETH turned down. That alone cost about 12%.
              Panic buys then took it to all in by April. In total it lost 16% while ETH fell 30%.
            </li>
            <li>
              <b>A market going nowhere.</b> From February to April 2022 it made more than twenty small trades and ended about where it started, down 1%.
            </li>
            <li>
              <b>Being all in means feeling everything.</b> The worst fall of the pot in the replay was 52%. Holding ETH fell 80%, but a 52% fall is still painful.
            </li>
          </ul>
          <div className="callout loss">
            <p>
              <b>There’s one emergency brake.</b> If the pot loses 10% or more within 24 hours, the bot cancels its orders and switches itself off until you
              turn it on again. It doesn’t sell what it holds. The replay doesn’t include this brake, and an all-in crash like the one above could trigger it.
            </p>
          </div>
        </Section>

        <Section n={10} title="How much goes in: the cheat sheet" teaser="Every situation and its size, in one table." tag="Overview">
          <p>
            The bot only ever holds whole quarters of the pot: 0, 25, 50, 75 or 100%. Several reasons can be active at once. They don’t add up: the biggest
            one sets the size.
          </p>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Situation</th>
                  <th>In ETH</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {SIZES.map((r) => (
                  <tr key={r[0]}>
                    <td>{r[0]}</td>
                    <td className="nowrap">
                      <b>{r[1]}</b>
                    </td>
                    <td>{r[2]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section n={11} title="Seven years in one picture" teaser="The whole replay, and how far to trust it." tag="Results">
          <Example chart="whole" log title="March 2019 to October 2026" label="ETH price over seven years on a logarithmic scale, with bitcoin bull markets shaded and the share of the pot in ETH below">
            <p className="tiny muted hit-scale-note">Each step up the price scale is the same percentage rise, so early and late years are comparable.</p>
          </Example>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Year</th>
                  <th className="r">The bot</th>
                  <th className="r">Holding ETH</th>
                </tr>
              </thead>
              <tbody>
                {YEARS.map((r) => (
                  <tr key={r[0]}>
                    <td>{r[0]}</td>
                    <td className="r tnum">
                      <b>{r[1]}</b>
                    </td>
                    <td className="r tnum">{r[2]}</td>
                  </tr>
                ))}
                <tr>
                  <td>
                    <b>Yearly average</b>
                  </td>
                  <td className="r tnum">
                    <b>+110%</b>
                  </td>
                  <td className="r tnum">
                    <b>+44%</b>
                  </td>
                </tr>
                <tr>
                  <td>Worst fall</td>
                  <td className="r tnum">−52%</td>
                  <td className="r tnum">−80%</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            That’s about twelve round trips a year, and two out of three made money. Notice 2020 and 2023: in a strong, steady rise, holding wins, because the
            bot is sometimes out. It earns its keep by still making money in the years ETH falls.
          </p>
          <div className="callout brass">
            <p>
              <b>Don’t expect these numbers.</b> The plan was tuned on these same years, with ETH among its test coins, so a replay flatters it. Most of the
              gain comes from one huge bull market, and on the typical coin across all 29 we tested the result was about +49% a year. The other articles on the homepage
              explain why. This is research, not financial advice.
            </p>
          </div>
        </Section>
      </div>

      <p className="small soft hit-foot">
        This describes the plan the bot was running on 30 October 2026, “Bitcoin bull, cycle check” on ETH. If the plan changes, this article doesn’t change
        with it.
      </p>
    </>
  );
}
