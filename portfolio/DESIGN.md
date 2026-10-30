# Portfolio design direction

The brief every change to this site is judged against. Keep it short and current.

## The idea: one day at the window

The site is a single quiet day in Amsterdam, told from dawn to night as you scroll. The illustrations already show
this world (a window with a sleeping ginger cat, a morning desk, a canal at dusk, a reading chair by a lamp), so the
page should feel like walking through it, not like a template with pictures dropped in.

| Part of the page | Time of day | Feeling |
|------------------|-------------|---------|
| Hero             | Dawn        | Light comes in, the cat sleeps, the coffee steams |
| About            | Morning     | Clear, personal, unhurried |
| Experience       | The working day | Bright, precise, the most "professional" part of the page |
| Skills           | Late afternoon into dusk | Warm, the light gets lower |
| Contact          | Night, by the lamp | The warmest moment: pull up a chair |

## Principles

1. **Professional first, cozy second.** A hiring manager must get who Bas is, what he has done and how to reach him
   within 30 seconds. The mood supports that and never gets in its way.
2. **Classy means restraint.** Few colours, generous space, real typography. One signature moment per section, not
   five. If an effect is the first thing you notice, it is too loud.
3. **Impressive means crafted.** Details that reward attention (the light changing, a cat that breathes, a lamp that
   turns the page to night), not spectacle. Nothing scroll-jacks, nothing blocks reading, nothing spins.
4. **Words are never held hostage.** Text is readable at once. An animation may add polish but content must not sit
   invisible waiting for it, and a screen must never look empty mid-scroll.

## Visual language

- **Colour:** paper, ink, lamplight (`--warm`) and lake blue (`--accent`), all as tokens. The accent colours come from
  the paintings, so new colours are sampled from them too. No pure white, no pure black.
- **Type:** Newsreader for anything with a voice, Geist for reading. No mono and no uppercase labels: they read as a
  developer template rather than a warm room.
- **Pictures:** every picture belongs to the same painted world. Soft corners, soft warm shadows, no hard borders.
- **Layout:** one consistent left edge shared by nav, hero and sections.

## Motion rules

- Animate `transform` and `opacity` only (plus `filter` sparingly). Slow and eased, using `--ease` and `--dur`.
- Prefer CSS and scroll-driven animations; JS only where CSS can't. No animation library unless it pays for itself.
- Everything must work with `prefers-reduced-motion: reduce` (static, complete, no hidden content) and in browsers
  without scroll-driven animations.
- 60 fps on a mid-range phone. No layout shift when fonts or images arrive.

## Code rules

- Words live in `src/content.ts`; components decide how they look.
- Small focused components, one responsibility each. No dead code, no unused CSS, no drawn fallbacks for art that
  exists. Duplicated JSX or CSS gets extracted.
- CSS: tokens first, one file per part of the page, a section's responsive and motion rules live with that section.
- No new dependency without a clear reason.

## Review verdicts

Every visible change goes past reviewers who look at real screenshots, in light and dark, desktop and phone:

- **APPROVE**: ship it.
- **IMPROVE**: good direction; these specific changes first.
- **DECLINE**: wrong direction; revert or rethink, with the reason.

Reviewers judge against this file. A change that is merely different is not better.
