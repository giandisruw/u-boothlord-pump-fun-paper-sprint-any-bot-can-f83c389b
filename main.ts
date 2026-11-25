// Fresh paper-trading bot for the Pump.fun replay, protocol agent-fun/replay/v2.
// hello: the harness opens with one hello line, then sends batch lines — each
// batch carries a slot number, market events, marks, fills and our account —
// and ends with a done line. We answer every batch with exactly one reply
// line holding the orders for that batch. Every choice here is deterministic:
// it depends only on slot numbers and event data, never on wall time or on
// randomness, so two runs of this bot emit identical orders.
//
// Idea: catch young bonding-curve coins while real buyers are still piling in.
// A coin is a candidate only while it is fresh, its price has already climbed
// a little from launch, and recent trades are mostly buys. We take a fixed
// slice, then leave on a profit target, a stop loss, a trailing fall from the
// peak, a hold-time cap, or the coin completing its curve. Losers are cut
// fast; winners are allowed to run a little before the trailing exit bites.

interface CoinBook {
  mint: string;
  firstSlot: number;
  firstPrice: number;
  lastPrice: number;
  lastSlot: number;
  realSol: number;
  samples: Array<{ slot: number; price: number }>;
  buckets: Map<number, { buyVol: number; sellVol: number; buys: number; sells: number }>;
  finished: boolean;
}

interface OpenTrade {
  mint: string;
  entryPrice: number;
  entrySlot: number;
  peakPrice: number;
}

interface OrderOut {
  side: "buy" | "sell";
  client_id: string;
  mint: string;
  quote_lamports?: string;
  token_amount?: string;
  max_slippage_bps: number;
}

// ---- tunables (lamports; 1 SOL = 1_000_000_000 lamports) ----
const BUY_LAMPORTS = 250_000_000;
const MIN_BUY_LAMPORTS = 15_000_000;
const ORDER_BPS_OF_RESERVE = 90;
const ENTRY_RISE = 0.03;
const MAX_CHASE_MULT = 1.8;
const MIN_REAL_SOL = 5_000_000_000;
const MAX_AGE_SLOTS = 3000;
const TAKE_PROFIT_MULT = 2.5;
const STOP_LOSS_MULT = 0.8;
const TRAIL_MULT = 0.85;
const MAX_HOLD_SLOTS = 4000;
const REBUY_COOLDOWN_SLOTS = 500;
const SAMPLE_EVERY_SLOTS = 50;
const MAX_SAMPLES = 12;
const BUCKET_SLOTS = 100;
const RECENT_BUCKETS = 3;
const MIN_RECENT_TRADES = 4;
const MIN_BUY_SHARE = 0.65;
const MIN_RECENT_BUY_SOL = 0;
const FRESH_RISE = 0.01;
const MAX_SLIPPAGE_BPS = 200;
const SELL_SLIPPAGE_BPS = 1000;

const coins = new Map<string, CoinBook>();
const trades = new Map<string, OpenTrade>();
const waitingBuys = new Map<string, { mint: string; size: number }>();
const waitingBuyMints = new Set<string>();
const waitingSells = new Set<string>();
const lastSoldSlot = new Map<string, number>();
let orderCounter = 0;
let maxOpen = 5;
let maxOrdersPerBatch = 16;
let cashCommitted = 0;

function asNum(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function priceFromReserves(quoteReserves: unknown, tokenReserves: unknown): number {
  const quote = asNum(quoteReserves);
  const tokens = asNum(tokenReserves);
  if (quote <= 0 || tokens <= 0) return 0;
  return quote / tokens;
}

function bookFor(mint: string, slot: number, price: number): CoinBook {
  let book = coins.get(mint);
  if (!book) {
    book = {
      mint,
      firstSlot: slot,
      firstPrice: price,
      lastPrice: price,
      lastSlot: slot,
      realSol: 0,
      samples: price > 0 ? [{ slot, price }] : [],
      buckets: new Map(),
      finished: false,
    };
    coins.set(mint, book);
  }
  return book;
}

function notePrice(book: CoinBook, slot: number, price: number): void {
  if (price <= 0) return;
  book.lastPrice = price;
  book.lastSlot = slot;
  const last = book.samples[book.samples.length - 1];
  if (!last || slot - last.slot >= SAMPLE_EVERY_SLOTS) {
    book.samples.push({ slot, price });
    if (book.samples.length > MAX_SAMPLES) book.samples.shift();
  }
}

function noteTrade(book: CoinBook, slot: number, isBuy: boolean, solVolume: number): void {
  const key = Math.floor(slot / BUCKET_SLOTS);
  let bucket = book.buckets.get(key);
  if (!bucket) {
    bucket = { buyVol: 0, sellVol: 0, buys: 0, sells: 0 };
    book.buckets.set(key, bucket);
  }
  if (isBuy) {
    bucket.buyVol += solVolume;
    bucket.buys += 1;
  } else {
    bucket.sellVol += solVolume;
    bucket.sells += 1;
  }
  const oldestKept = key - RECENT_BUCKETS;
  for (const k of Array.from(book.buckets.keys())) {
    if (k <= oldestKept) book.buckets.delete(k);
  }
}

function recentBuyShare(book: CoinBook): { share: number; count: number; buyVol: number } {
  let buyVol = 0;
  let sellVol = 0;
  let count = 0;
  for (const bucket of book.buckets.values()) {
    buyVol += bucket.buyVol;
    sellVol += bucket.sellVol;
    count += bucket.buys + bucket.sells;
  }
  const total = buyVol + sellVol;
  return { share: total > 0 ? buyVol / total : 0, count, buyVol };
}

function freshRise(book: CoinBook): number {
  if (book.samples.length < 4) return 0;
  const ref = book.samples[book.samples.length - 3].price;
  if (ref <= 0 || book.lastPrice <= 0) return 0;
  return book.lastPrice / ref - 1;
}

function windowRise(book: CoinBook): number {
  if (book.samples.length < 3) return 0;
  const oldest = book.samples[0].price;
  if (oldest <= 0 || book.lastPrice <= 0) return 0;
  return book.lastPrice / oldest - 1;
}

function handleTradeEvent(ev: any): void {
  const mint = String(ev.mint);
  const slot = asNum(ev.slot);
  const price = priceFromReserves(ev.virtual_sol_reserves, ev.virtual_token_reserves);
  const book = bookFor(mint, slot, price);
  book.realSol = asNum(ev.real_sol_reserves);
  notePrice(book, slot, price);
  noteTrade(book, slot, ev.is_buy === true, asNum(ev.sol_amount));
}

function handleCreateEvent(ev: any): void {
  const mint = String(ev.mint);
  const slot = asNum(ev.slot);
  const price = priceFromReserves(ev.virtual_sol_reserves, ev.virtual_token_reserves);
  const book = bookFor(mint, slot, price);
  book.realSol = 0;
  notePrice(book, slot, price);
}

function handleCompleteEvent(ev: any): void {
  const mint = String(ev.mint);
  const book = coins.get(mint);
  if (book) book.finished = true;
}

function handleMark(mark: any): void {
  const mint = String(mark.mint);
  const slot = asNum(mark.slot);
  const price = priceFromReserves(mark.virtual_quote_reserves, mark.virtual_token_reserves);
  const book = bookFor(mint, slot, price);
  book.realSol = asNum(mark.real_quote_reserves);
  notePrice(book, slot, price);
}

function handleFill(fill: any): void {
  const mint = String(fill.mint);
  const clientId = String(fill.client_id);
  const pending = waitingBuys.get(clientId);
  if (pending) {
    waitingBuys.delete(clientId);
    waitingBuyMints.delete(pending.mint);
    cashCommitted -= pending.size;
    if (fill.status === "filled") {
      const paid = asNum(fill.quote_lamports);
      const got = asNum(fill.token_amount);
      if (paid > 0 && got > 0) {
        const entryPrice = paid / got;
        trades.set(mint, {
          mint,
          entryPrice,
          entrySlot: asNum(fill.decided_slot),
          peakPrice: entryPrice,
        });
      }
    }
  }
  if (waitingSells.has(mint) && fill.side === "sell") {
    waitingSells.delete(mint);
    if (fill.status === "filled") {
      trades.delete(mint);
      lastSoldSlot.set(mint, asNum(fill.decided_slot));
    }
  }
}

function reconcileAccount(account: any, slot: number): void {
  const held = new Map<string, { tokens: number; cost: number }>();
  const positions = Array.isArray(account?.positions) ? account.positions : [];
  for (const pos of positions) {
    held.set(String(pos.mint), {
      tokens: asNum(pos.token_amount),
      cost: asNum(pos.cost_lamports),
    });
  }
  for (const mint of Array.from(trades.keys())) {
    if (!held.has(mint)) trades.delete(mint);
  }
  for (const [mint, pos] of held) {
    if (!trades.has(mint) && pos.tokens > 0 && pos.cost > 0) {
      const basis = pos.cost / pos.tokens;
      trades.set(mint, { mint, entryPrice: basis, entrySlot: slot, peakPrice: basis });
    }
  }
}

function planExits(account: any, slot: number, orders: OrderOut[]): void {
  const positions = Array.isArray(account?.positions) ? account.positions : [];
  for (const pos of positions) {
    const mint = String(pos.mint);
    const tokens = asNum(pos.token_amount);
    if (tokens <= 0) continue;
    if (waitingSells.has(mint)) continue;
    const trade = trades.get(mint);
    const book = coins.get(mint);
    const price = book ? book.lastPrice : 0;
    let leave = false;
    if (book?.finished) leave = true;
    if (trade && price > 0) {
      if (price > trade.peakPrice) trade.peakPrice = price;
      if (price >= trade.entryPrice * TAKE_PROFIT_MULT) leave = true;
      if (price <= trade.entryPrice * STOP_LOSS_MULT) leave = true;
      if (price <= trade.peakPrice * TRAIL_MULT) leave = true;
      if (slot - trade.entrySlot >= MAX_HOLD_SLOTS) leave = true;
    }
    if (leave) {
      orderCounter += 1;
      orders.push({
        side: "sell",
        client_id: `x${orderCounter}`,
        mint,
        token_amount: String(Math.floor(tokens)),
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      });
      waitingSells.add(mint);
    }
  }
}

function planEntries(cash: number, slot: number, orders: OrderOut[]): void {
  const openCount = trades.size + waitingBuyMints.size;
  const freeSlots = maxOpen - openCount;
  if (freeSlots <= 0) return;
  const hopeful: Array<{ book: CoinBook; rise: number }> = [];
  for (const book of coins.values()) {
    if (book.finished) continue;
    if (trades.has(book.mint) || waitingBuyMints.has(book.mint)) continue;
    if (waitingSells.has(book.mint)) continue;
    const cooled = lastSoldSlot.get(book.mint);
    if (cooled !== undefined && slot - cooled < REBUY_COOLDOWN_SLOTS) continue;
    if (slot - book.firstSlot > MAX_AGE_SLOTS) continue;
    if (slot - book.lastSlot > 500) continue;
    if (book.realSol < MIN_REAL_SOL) continue;
    if (book.firstPrice <= 0 || book.lastPrice > book.firstPrice * MAX_CHASE_MULT) continue;
    const rise = windowRise(book);
    if (rise < ENTRY_RISE) continue;
    if (freshRise(book) < FRESH_RISE) continue;
    const recent = recentBuyShare(book);
    if (recent.count < MIN_RECENT_TRADES || recent.share < MIN_BUY_SHARE) continue;
    if (recent.buyVol < MIN_RECENT_BUY_SOL) continue;
    hopeful.push({ book, rise });
  }
  hopeful.sort((a, b) => b.rise - a.rise);
  let spendable = cash - cashCommitted;
  for (const { book } of hopeful) {
    if (orders.length >= maxOrdersPerBatch) break;
    if (trades.size + waitingBuyMints.size >= maxOpen) break;
    const capped = Math.floor((book.realSol * ORDER_BPS_OF_RESERVE) / 10000);
    const size = Math.min(BUY_LAMPORTS, capped);
    if (size < MIN_BUY_LAMPORTS) continue;
    if (spendable < size) continue;
    orderCounter += 1;
    const clientId = `b${orderCounter}`;
    orders.push({
      side: "buy",
      client_id: clientId,
      mint: book.mint,
      quote_lamports: String(size),
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    });
    waitingBuys.set(clientId, { mint: book.mint, size });
    waitingBuyMints.add(book.mint);
    cashCommitted += size;
    spendable -= size;
  }
}

function handleBatch(msg: any): OrderOut[] {
  const slot = asNum(msg.slot);
  const events = Array.isArray(msg.events) ? msg.events : [];
  for (const ev of events) {
    if (ev.event === "TradeEvent") handleTradeEvent(ev);
    else if (ev.event === "CreateEvent") handleCreateEvent(ev);
    else if (ev.event === "CompleteEvent") handleCompleteEvent(ev);
  }
  const marks = Array.isArray(msg.marks) ? msg.marks : [];
  for (const mark of marks) handleMark(mark);
  const fills = Array.isArray(msg.fills) ? msg.fills : [];
  for (const fill of fills) handleFill(fill);
  const account = msg.account ?? {};
  reconcileAccount(account, slot);
  const cash = asNum(account.cash_lamports);
  const orders: OrderOut[] = [];
  planExits(account, slot, orders);
  planEntries(cash, slot, orders);
  return orders.slice(0, maxOrdersPerBatch);
}

function handleHello(msg: any): void {
  const caps = msg.caps ?? {};
  if (asNum(caps.max_open_positions) > 0) maxOpen = Math.floor(asNum(caps.max_open_positions));
  if (asNum(caps.max_orders_per_batch) > 0) {
    maxOrdersPerBatch = Math.floor(asNum(caps.max_orders_per_batch));
  }
}

let leftover = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  leftover += chunk;
  let cut = leftover.indexOf("\n");
  while (cut >= 0) {
    const line = leftover.slice(0, cut).trim();
    leftover = leftover.slice(cut + 1);
    cut = leftover.indexOf("\n");
    if (line.length === 0) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type === "hello") {
      handleHello(msg);
    } else if (msg.type === "batch") {
      const orders = handleBatch(msg);
      process.stdout.write(JSON.stringify({ type: "reply", seq: msg.seq, orders }) + "\n");
    } else if (msg.type === "done") {
      process.exit(0);
    }
  }
});
process.stdin.on("end", () => {
  process.exit(0);
});
