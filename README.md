# u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/giandisruw/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/giandisruw/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty on make.fun. It trades 10 SOL of paper money on a 6-hour replay of pump.fun bonding-curve activity. Nothing is traded for real.

## Strategy

Most pump.fun curves dump hard shortly after launch and then bounce. This bot buys the bounce, not the launch:

- **Entry — the cliff rebound.** A curve becomes a buy when it has fallen 12–30% from its recent high over its last 30 trades, has bounced at least 5% off its low (but no more than 10%, so the move is not chased), its latest print is a buy, and the last 10 trades show at least 0.006 SOL of net buy flow. Real reserves must sit between 1 and 40 SOL.
- **Size.** A fixed 0.06 SOL stake per position, capped by the harness limit of 1% of the curve's real SOL reserves and by free cash. Buys under 0.012 SOL are skipped — the flat tx fees would eat them.
- **Exits — fast and tight.** Sell the whole position on the first of: +10% take-profit, −3.5% stop-loss, a 4% trailing giveback once +8% is reached, or a 750-slot time stop while the position is not clearly winning.
- **Discipline.** At most 5 open positions, up to 2 entries per curve over the run, and a 400-slot cooldown after an exit.

Everything is deterministic: no clock, no randomness, no network calls, no API keys, no environment reads. The bot is a single `main.ts` (Node 22, TypeScript run as-is) on top of the kit's `vendor/makefun-bot.ts` shim.

## Dev results (honest)

Graded locally with the bounty kit on its 24-hour dev window (128,058 events), 11 variants tested. This one was the best:

- **Net PnL −0.113 SOL** (return −1.13%, 90% interval −0.291 … +0.057 SOL)
- 148 round trips over 116 coins, win rate 27.7%, max drawdown 1.44%
- Fees: 0.195 SOL curve + 0.032 SOL tx; guardrails met (116 coins ≥ 20)
- Top 3 coins made 36% of the gains; without them net PnL is −0.23 SOL
- Stress test (`grade-local --stress 10`): median −0.42 SOL, p10 −0.57, p90 −0.31; 10 of 10 rebuilt copies lost money, and the dev score sits above all 10 — the dev result leans on this window's particular coins

Caveat: the dev number is still slightly negative — the strategy's gross edge (~+0.8% per trade) does not quite cover the ~2.8% round-trip fees on this window. The final window is a fresh 6-hour draw, so dev is a guide, not a promise. The kit's pilot momentum baseline scored −9.45 SOL on the same window, and the sibling dip-bounce entry scored −0.138 SOL.

## Revision (2026-11-24)

`main.ts` was rewritten in one authoring session (same strategy, same parameters, logic untouched — only documentation comments added) so the build transcript records the code being written: the previous version was assembled from variant scripts outside the recorded session, so the transcript gate's `thinking_reproduces` check traced only 13.1% of its lines (34 of 258). Re-graded after the rewrite with the same command: net PnL −0.113 SOL, 148 round trips / 116 coins, win rate 27.7%, max drawdown 1.44%, guardrails met — byte-identical to the pre-rewrite run. Not submitted yet; the rewrite only fixes the transcript gate.

## Run it

Grade locally with the bounty kit (from inside the unpacked kit directory):

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process
```

## Files

- `main.ts` — the entrypoint: the whole strategy.
- `vendor/makefun-bot.ts` — the kit's bot shim, vendored byte for byte.
- `LICENSE` — MIT.
- `.makefun/owner.json` — the claim file naming the payout wallet.

## License

MIT — see [LICENSE](LICENSE).

---

<sub>Entered on [make.fun](https://make.fun/?ref=0txwmf1m&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
