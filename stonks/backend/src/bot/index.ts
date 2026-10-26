// Placeholder until the trading bot lands (SPEC.md §5).
export function startBot() {}
export function stopBot() {}
export async function botHealth() {
  return { bitvavo: false, bot: { enabled: false, mode: 'paper' } };
}
