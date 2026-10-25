// Tells which games' screenshots (and Last Light's key art) are out of date: a game is stale when the files its
// pictures are made from (INPUTS in inputs.mjs) changed since the last capture recorded in screenshots.lock.json.
//
//   npm run screenshots:check            from play/; exits 1 when any game is stale
//   node tools/screenshots/check.mjs --github   also prints ::warning:: annotations (CI)
//
// Fix a stale game with `npm run screenshots -- --stale` (or `--only <game>`). See ../../SCREENSHOTS.md.

import { INPUTS, fingerprint, readLock } from './inputs.mjs';

const github = process.argv.includes('--github');
const lock = readLock();
let stale = 0;

for (const [game, def] of Object.entries(INPUTS)) {
  const entry = lock[game];
  if (!def.routine) {
    console.log(`  ${game.padEnd(12)} no capture routine yet`);
    continue;
  }
  if (entry?.hash === fingerprint(game)) {
    console.log(`  ${game.padEnd(12)} fresh   (captured ${entry.at})`);
    continue;
  }
  stale++;
  const why = entry ? `graphics changed since the capture of ${entry.at}` : 'never captured with a fingerprint';
  console.log(`  ${game.padEnd(12)} STALE   (${why})`);
  if (github) console.log(`::warning title=Stale screenshots::${game}: ${why}. Run \`npm run screenshots -- --only ${game}\` in play/ and commit the result.`);
}

if (stale) {
  console.log(`\n${stale} game(s) with stale screenshots. Run \`npm run screenshots -- --stale\` in play/ and commit the result.`);
  process.exit(1);
}
console.log('\nAll screenshots are up to date.');
