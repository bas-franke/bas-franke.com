// Garage: browse the five pods (the backdrop shows the selected one on a turntable on the track), compare their
// stats, buy and fly them, and buy upgrade levels per category for the pods you own.

import { buyPod, buyUpgrade, selectPod, upgradePrice, type CareerSave } from '../core/career';
import { applyUpgrades, MAX_UPGRADE, NO_UPGRADES, PODS, podById, type PodStats, type Upgrades } from '../core/pods';
import { menuAudio } from '../audio/menu';
import { Btn, CreditIcon, Credits, PodSwatch, TopBar } from './menuParts';
import { fmtCredits } from './menuStore';

type Cat = keyof Upgrades;

const CATS: { key: Cat; label: string; hint: string }[] = [
  { key: 'thrust', label: 'Thrust', hint: 'Acceleration out of corners' },
  { key: 'topSpeed', label: 'Top speed', hint: 'Speed on the straights' },
  { key: 'handling', label: 'Handling', hint: 'Turn rate and grip' },
  { key: 'boost', label: 'Boost', hint: 'Boost duration' },
];

const MAXED: Upgrades = { thrust: MAX_UPGRADE, topSpeed: MAX_UPGRADE, handling: MAX_UPGRADE, boost: MAX_UPGRADE };

/** Raw figure per category, so every pod and upgrade level lands on one scale. */
function raw(s: PodStats): Record<Cat, number> {
  return { thrust: s.thrust, topSpeed: s.topSpeed, handling: s.turn * 2 + s.grip * 0.4, boost: s.boostTime * (1 + s.boostRefill * 4) };
}

const RANGE = (() => {
  const lo = { thrust: Infinity, topSpeed: Infinity, handling: Infinity, boost: Infinity } as Record<Cat, number>;
  const hi = { thrust: 0, topSpeed: 0, handling: 0, boost: 0 } as Record<Cat, number>;
  for (const p of PODS) {
    const a = raw(p.stats);
    const b = raw(applyUpgrades(p.stats, MAXED));
    for (const c of CATS) {
      lo[c.key] = Math.min(lo[c.key], a[c.key]);
      hi[c.key] = Math.max(hi[c.key], b[c.key]);
    }
  }
  return { lo, hi };
})();

/** 0..1 bar length; the weakest stock pod still shows a bit of bar. */
function score(s: PodStats, c: Cat) {
  const v = raw(s)[c];
  return 0.12 + (0.88 * (v - RANGE.lo[c])) / (RANGE.hi[c] - RANGE.lo[c]);
}

export function Garage(props: { save: CareerSave; commit(s: CareerSave): void; onBack(): void; viewPod: string; setViewPod(id: string): void }) {
  const s = props.save;
  const pod = podById(props.viewPod);
  const owned = s.ownedPods.includes(pod.id);
  const flying = s.pod === pod.id;
  const u = s.upgrades[pod.id] ?? NO_UPGRADES;
  const base = pod.stats;
  const now = applyUpgrades(base, u);
  const buy = (next: CareerSave | null) => {
    if (!next) return menuAudio.error();
    menuAudio.purchase();
    props.commit(next);
  };
  return (
    <div className="dr-page dr-garage">
      <TopBar title="Garage" sub={<>Flying <b>{podById(s.pod).name}</b></>} onBack={props.onBack} right={<Credits n={s.credits} />} />
      <div className="dr-garage-body">
        <div className="dr-garage-stage" aria-hidden>
          <div className="dr-garage-plate">
            <span className="dr-kicker">{owned ? (flying ? 'Your pod' : 'In your hangar') : 'For sale'}</span>
            <b>{pod.name}</b>
          </div>
        </div>
        <section className="dr-panel dr-garage-panel">
          <div className="dr-pod-tabs" role="tablist">
            {PODS.map((p) => (
              <button key={p.id} role="tab" aria-selected={p.id === pod.id} className={`dr-pod-tab${p.id === pod.id ? ' on' : ''}`} onClick={() => props.setViewPod(p.id)} data-autofocus={p.id === pod.id ? '' : undefined}>
                <PodSwatch pod={p} />
                <span className="dr-pod-tab-name">{p.name}</span>
                <small>{s.pod === p.id ? 'Flying' : s.ownedPods.includes(p.id) ? 'Owned' : `${fmtCredits(p.price)} CR`}</small>
              </button>
            ))}
          </div>
          <div className="dr-pod-info">
            <h2>{pod.name}</h2>
            <p className="dr-dim">{pod.blurb}</p>
          </div>
          <div className="dr-bars">
            {CATS.map((c) => {
              const b = score(base, c.key);
              const n = score(now, c.key);
              return (
                <div className="dr-bar-row" key={c.key}>
                  <span className="dr-bar-label">{c.label}</span>
                  <span className="dr-bar">
                    <i className="dr-bar-base" style={{ width: `${b * 100}%` }} />
                    <i className="dr-bar-up" style={{ left: `${b * 100}%`, width: `${Math.max(0, n - b) * 100}%` }} />
                  </span>
                  <span className="dr-bar-num">{Math.round(n * 100)}</span>
                </div>
              );
            })}
          </div>
          <div className="dr-pod-action">
            {flying ? (
              <span className="dr-badge">Flying this pod</span>
            ) : owned ? (
              <Btn kind="primary" onClick={() => props.commit(selectPod(s, pod.id))}>
                Fly the {pod.name}
              </Btn>
            ) : (
              <Btn kind="primary" disabled={s.credits < pod.price} onClick={() => buy(buyPod(s, pod.id))}>
                Buy · <CreditIcon /> {fmtCredits(pod.price)}
              </Btn>
            )}
            {!owned && s.credits < pod.price && <span className="dr-short">Need {fmtCredits(pod.price - s.credits)} more</span>}
          </div>
          <h3 className="dr-section">Upgrades</h3>
          {owned ? (
            <div className="dr-upgrades">
              {CATS.map((c) => {
                const level = u[c.key];
                const price = upgradePrice(level);
                return (
                  <div className="dr-up-row" key={c.key}>
                    <div className="dr-up-label">
                      <b>{c.label}</b>
                      <small>{c.hint}</small>
                    </div>
                    <div className="dr-pips" aria-label={`Level ${level} of ${MAX_UPGRADE}`}>
                      {Array.from({ length: MAX_UPGRADE }, (_, i) => (
                        <i key={i} className={i < level ? 'on' : ''} />
                      ))}
                    </div>
                    <Btn className="dr-up-buy" disabled={price === null || s.credits < price} onClick={() => buy(buyUpgrade(s, c.key, pod.id))}>
                      {price === null ? 'Max' : (
                        <>
                          <CreditIcon /> {fmtCredits(price)}
                        </>
                      )}
                    </Btn>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="dr-dim dr-up-locked">Buy the {pod.name} to upgrade it. Upgrades belong to each pod.</p>
          )}
        </section>
      </div>
    </div>
  );
}
