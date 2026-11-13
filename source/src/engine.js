/* ============================================================
   POKER ENGINE — pure game rules. No storage, no UI.
   Portable: works unchanged in the Claude page, Firebase app or Node.
   ============================================================ */
(function (root) {
  const RANKS = '23456789TJQKA';
  const SUITS = 'shdc';
  const CHIPS = [100, 40, 20, 10];
  const STREETS = ['Pre-flop', 'Flop', 'Turn', 'River'];
  const DABBA = 100;

  const GAMES = {
    allin: { label: "All-in Hold'em", short: 'All-in', hole: 2, board: [0, 3, 1, 1] },
    limit: { label: 'Limit · 3 cards', short: 'Limit', hole: 3, board: [0, 3, 1, 2] },
  };

  function limitsFor(structure, lastLimit) {
    if (structure === 'rising') return [100, 200, 300, 400];
    return [100, 100, 100, lastLimit || 300];
  }

  const clone = (o) => JSON.parse(JSON.stringify(o));

  /* ---------- cards ---------- */
  function newDeck() {
    const d = [];
    for (const r of RANKS) for (const s of SUITS) d.push(r + s);
    return d;
  }
  function shuffle(deck) {
    const a = deck.slice();
    const rnd = new Uint32Array(a.length);
    root.crypto.getRandomValues(rnd);
    for (let i = a.length - 1; i > 0; i--) {
      const j = rnd[i] % (i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  // Light scrambling so cards are not plain text in storage.
  // NOT secure — anyone technical could decode. Fine among friends.
  function seal(obj, key) {
    const s = JSON.stringify(obj);
    let out = '';
    for (let i = 0; i < s.length; i++) out += String.fromCharCode(s.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    return btoaSafe(out);
  }
  function unseal(str, key) {
    if (!str) return null;
    const s = atobSafe(str);
    let out = '';
    for (let i = 0; i < s.length; i++) out += String.fromCharCode(s.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    return JSON.parse(out);
  }
  function btoaSafe(s) { return typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'binary').toString('base64'); }
  function atobSafe(s) { return typeof atob === 'function' ? atob(s) : Buffer.from(s, 'base64').toString('binary'); }

  /* ---------- hand ranking ---------- */
  const CAT = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];
  const rv = (c) => RANKS.indexOf(c[0]) + 2;

  function eval5(cards) {
    const v = cards.map(rv).sort((a, b) => b - a);
    const flush = cards.every((c) => c[1] === cards[0][1]);
    const uniq = [...new Set(v)];
    let sh = 0;
    if (uniq.length === 5) {
      if (v[0] - v[4] === 4) sh = v[0];
      else if (v[0] === 14 && v[1] === 5) sh = 5; // A-2-3-4-5
    }
    const cnt = {};
    v.forEach((x) => (cnt[x] = (cnt[x] || 0) + 1));
    const g = Object.entries(cnt).map(([r, c]) => [c, +r]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    if (sh && flush) return [8, sh];
    if (g[0][0] === 4) return [7, g[0][1], g[1][1]];
    if (g[0][0] === 3 && g[1][0] === 2) return [6, g[0][1], g[1][1]];
    if (flush) return [5, ...v];
    if (sh) return [4, sh];
    if (g[0][0] === 3) return [3, g[0][1], ...g.slice(1).map((x) => x[1])];
    if (g[0][0] === 2 && g[1][0] === 2) return [2, g[0][1], g[1][1], g[2][1]];
    if (g[0][0] === 2) return [1, g[0][1], ...g.slice(1).map((x) => x[1])];
    return [0, ...v];
  }
  function cmp(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] || 0) - (b[i] || 0);
      if (d) return d;
    }
    return 0;
  }
  // Best 5 out of any number of cards (any combination allowed).
  function bestHand(cards) {
    let best = null, bestCards = null;
    const n = cards.length, pick = [];
    (function rec(start) {
      if (pick.length === 5) {
        const five = pick.map((i) => cards[i]);
        const val = eval5(five);
        if (!best || cmp(val, best) > 0) { best = val; bestCards = five; }
        return;
      }
      for (let i = start; i <= n - (5 - pick.length); i++) { pick.push(i); rec(i + 1); pick.pop(); }
    })(0);
    if (!best) return null;
    let name = CAT[best[0]];
    if (best[0] === 8 && best[1] === 14) name = 'Royal flush';
    return { value: best, cards: bestCards, name };
  }

  /* ---------- chips ---------- */
  function chipBreakdown(amount) {
    const out = {};
    let left = amount;
    for (const c of CHIPS) { const n = Math.floor(left / c); if (n) { out[c] = n; left -= n * c; } }
    if (left > 0) out.rest = left;
    return out;
  }

  /* ---------- pots (with side pots) ---------- */
  function buildPots(contrib, folded) {
    const ps = Object.keys(contrib).filter((p) => contrib[p] > 0);
    const live = ps.filter((p) => !folded[p]);
    const levels = [...new Set(live.map((p) => contrib[p]))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const lvl of levels) {
      let amt = 0;
      for (const p of ps) amt += Math.max(0, Math.min(contrib[p], lvl) - prev);
      const eligible = live.filter((p) => contrib[p] >= lvl);
      if (amt > 0) {
        const last = pots[pots.length - 1];
        if (last && last.eligible.join() === eligible.join()) last.amt += amt;
        else pots.push({ amt, eligible });
      }
      prev = lvl;
    }
    const total = ps.reduce((s, p) => s + contrib[p], 0);
    const counted = pots.reduce((s, p) => s + p.amt, 0);
    if (!pots.length && total > 0) pots.push({ amt: total, eligible: Object.keys(contrib).filter((p) => !folded[p]) });
    else if (total > counted) pots[pots.length - 1].amt += total - counted;
    return pots;
  }

  // Split a pot among winners in units of 10; odd chips go to first winner after dealer.
  function splitPot(amt, winners, seats) {
    const ordered = seats.filter((p) => winners.includes(p));
    const unit = 10;
    const units = Math.floor(amt / unit);
    const each = Math.floor(units / ordered.length) * unit;
    let rem = amt - each * ordered.length;
    const out = {};
    ordered.forEach((p) => { out[p] = each; });
    let i = 0;
    while (rem > 0) { const give = Math.min(unit, rem); out[ordered[i % ordered.length]] += give; rem -= give; i++; }
    return out;
  }

  /* ---------- hand flow ---------- */
  /**
   * opts: { no, game, mode, seats (in seat order), dealer, stacks{pid}, caps{pid},
   *         limitStructure, lastLimit }
   */
  function startHand(opts) {
    const game = GAMES[opts.game];
    const di = opts.seats.indexOf(opts.dealer);
    // Order of play: left of dealer first, dealer last.
    const seats = opts.seats.slice(di + 1).concat(opts.seats.slice(0, di + 1));
    const behind = {}, contrib = {}, roundBet = {}, folded = {}, allin = {}, acted = {}, start = {};
    for (const p of seats) {
      const stack = opts.stacks[p] || 0;
      const cap = opts.game === 'allin' && opts.caps && opts.caps[p] > 0 ? Math.min(stack, opts.caps[p]) : stack;
      behind[p] = cap; start[p] = cap; contrib[p] = 0; roundBet[p] = 0;
    }
    const h = {
      no: opts.no, game: opts.game, mode: opts.mode, seats, dealer: opts.dealer,
      limits: opts.game === 'limit' ? limitsFor(opts.limitStructure, opts.lastLimit) : null,
      start, behind, contrib, roundBet, folded, allin, acted,
      street: 0, currentBet: 0, board: [], status: 'betting', toAct: null,
      log: [], undo: null, lastActor: null, v: 1, ts: Date.now(),
    };
    // Dabba: dealer puts 100 into the pot (dead money, nobody has to match it).
    const d = Math.min(DABBA, h.behind[opts.dealer]);
    h.behind[opts.dealer] -= d; h.contrib[opts.dealer] += d;
    if (h.behind[opts.dealer] === 0) h.allin[opts.dealer] = true;
    h.dabba = d;
    h.log.push({ t: 'dabba', p: opts.dealer, a: d });

    if (opts.mode === 'online') {
      const deck = shuffle(newDeck());
      const holes = {};
      for (const p of seats) holes[p] = deck.splice(0, game.hole);
      h.key = 'k' + Math.random().toString(36).slice(2, 10);
      h.secret = seal({ deck, holes }, h.key);
    }
    h.toAct = nextToAct(h, seats[seats.length - 1]);
    if (!h.toAct) return advance(h);
    return h;
  }

  function canActList(h) { return h.seats.filter((p) => !h.folded[p] && !h.allin[p]); }
  function liveList(h) { return h.seats.filter((p) => !h.folded[p]); }
  function roundCap(h) { return h.limits ? h.limits[h.street] : Infinity; }

  function needsAction(h, p) {
    if (h.folded[p] || h.allin[p]) return false;
    return !h.acted[p] || h.roundBet[p] < h.currentBet;
  }
  function nextToAct(h, after) {
    const i = h.seats.indexOf(after);
    for (let k = 1; k <= h.seats.length; k++) {
      const p = h.seats[(i + k) % h.seats.length];
      if (needsAction(h, p)) {
        // A lone player facing nobody who can act doesn't need to act.
        const others = canActList(h).filter((x) => x !== p);
        if (others.length === 0 && h.roundBet[p] >= h.currentBet) return null;
        return p;
      }
    }
    return null;
  }

  /** What the player to act may do right now. */
  function options(h, p) {
    if (h.status !== 'betting' || h.toAct !== p) return null;
    const toCall = Math.max(0, h.currentBet - h.roundBet[p]);
    const maxTotal = Math.min(h.roundBet[p] + h.behind[p], roundCap(h));
    const callAmt = Math.min(toCall, h.behind[p]);
    const canRaise = maxTotal > h.currentBet && h.behind[p] > toCall;
    return {
      toCall, callAmt, canCheck: toCall === 0, canRaise,
      minTotal: h.currentBet + 10 <= maxTotal ? h.currentBet + 10 : maxTotal,
      maxTotal, roundBet: h.roundBet[p], behind: h.behind[p], cap: roundCap(h),
    };
  }

  function put(h, p, x) {
    h.behind[p] -= x; h.roundBet[p] += x; h.contrib[p] += x;
    if (h.behind[p] === 0) h.allin[p] = true;
  }

  /** action: {type:'fold'|'check'|'call'|'raise', total?} — returns new hand or throws */
  function act(hand, p, action) {
    const o = options(hand, p);
    if (!o) throw new Error("It's not your turn");
    const before = clone(hand); before.undo = null;
    const h = clone(hand);
    let entry = { t: action.type, p, s: h.street };
    if (action.type === 'fold') {
      h.folded[p] = true;
    } else if (action.type === 'check') {
      if (!o.canCheck) throw new Error('You must call or fold');
    } else if (action.type === 'call') {
      if (o.toCall === 0) throw new Error('Nothing to call — check instead');
      put(h, p, o.callAmt); entry.a = o.callAmt;
    } else if (action.type === 'raise') {
      const T = Math.round(action.total);
      if (!o.canRaise) throw new Error('You cannot raise here');
      if (T <= h.currentBet) throw new Error('Raise must be more than ₹' + h.currentBet);
      if (T > o.maxTotal) throw new Error('Maximum here is ₹' + o.maxTotal);
      put(h, p, T - h.roundBet[p]);
      h.currentBet = T; h.acted = {};
      entry.a = T; entry.t = before.currentBet === 0 ? 'bet' : 'raise';
    } else throw new Error('Unknown action');
    if (h.allin[p] && action.type !== 'fold') entry.allin = true;
    h.acted[p] = true;
    h.log.push(entry);
    h.lastActor = p;
    h.undo = before;
    h.v = (hand.v || 0) + 1;
    return advance(h, p);
  }

  /** Change last bet: allowed until the next player acts (and the round hasn't closed). */
  function canChange(h, p) {
    return h.status === 'betting' && h.lastActor === p && !!h.undo && h.undo.street === h.street;
  }
  function changeBet(hand, p) {
    if (!canChange(hand, p)) throw new Error('Too late to change — next player has acted');
    const h = clone(hand.undo);
    h.undo = null; h.lastActor = null; h.v = (hand.v || 0) + 1;
    return h;
  }

  // When the deck isn't on this device (only the host's phone holds it),
  // remember how many cards are owed; the host's phone deals them via resume().
  function dealStreet(h) {
    if (h.mode !== 'online') return;
    const n = GAMES[h.game].board[h.street];
    if (!h.secret) { h.owed = (h.owed || 0) + n; return; }
    const sec = unseal(h.secret, h.key);
    h.board = h.board.concat(sec.deck.splice(0, n));
    h.secret = seal(sec, h.key);
  }

  function advance(h, lastP) {
    const live = liveList(h);
    if (live.length === 1) return finish(h, [{ amt: potTotal(h), eligible: live, winners: live }], 'fold');
    const nxt = lastP ? nextToAct(h, lastP) : null;
    if (nxt) { h.toAct = nxt; return h; }
    return nextStreet(h);
  }

  function nextStreet(h) {
    // Round closed → bets are locked in.
    h.undo = null;
    if (h.street >= 3) return toShowdown(h);
    h.street++;
    h.roundBet = {}; h.seats.forEach((p) => (h.roundBet[p] = 0));
    h.currentBet = 0; h.acted = {};
    dealStreet(h);
    h.log.push({ t: 'street', s: h.street });
    if (canActList(h).length <= 1) return nextStreet(h); // run it out
    h.toAct = nextToAct(h, h.seats[h.seats.length - 1]);
    if (!h.toAct) return nextStreet(h);
    if (h.owed) h.status = 'dealing';
    return h;
  }

  // Dabba is dead money: everyone still in the hand can win it, so it goes in the main pot.
  function potsFor(h) {
    const c = { ...h.contrib };
    c[h.dealer] = Math.max(0, (c[h.dealer] || 0) - (h.dabba || 0));
    const pots = buildPots(c, h.folded);
    const live = liveList(h);
    if (h.dabba) {
      if (pots.length && pots[0].eligible.length === live.length) pots[0].amt += h.dabba;
      else pots.unshift({ amt: h.dabba, eligible: live });
    }
    return pots;
  }

  function toShowdown(h) {
    h.toAct = null;
    const pots = potsFor(h);
    h.pots = pots;
    if (h.mode === 'online' && !h.secret) { h.status = 'reveal'; return h; }
    if (h.mode === 'online') {
      const sec = unseal(h.secret, h.key);
      const shown = {};
      for (const p of liveList(h)) {
        const bh = bestHand(sec.holes[p].concat(h.board));
        shown[p] = { cards: sec.holes[p], best: bh.cards, name: bh.name, value: bh.value };
      }
      h.shown = shown;
      const decided = pots.map((pot) => {
        let best = null, winners = [];
        for (const p of pot.eligible) {
          const c = best ? cmp(shown[p].value, best) : 1;
          if (c > 0) { best = shown[p].value; winners = [p]; } else if (c === 0) winners.push(p);
        }
        return { ...pot, winners };
      });
      return finish(h, decided, 'showdown');
    }
    h.status = 'showdown'; // physical cards: admin picks winners
    return h;
  }

  /** Physical mode: winnersPerPot = [[pid,...], ...] in the same order as h.pots */
  function resolveShowdown(hand, winnersPerPot) {
    if (hand.status !== 'showdown') throw new Error('Not at showdown');
    const h = clone(hand);
    const decided = h.pots.map((pot, i) => {
      let w = (winnersPerPot[i] || []).filter((p) => pot.eligible.includes(p));
      if (!w.length && pot.eligible.length === 1) w = pot.eligible.slice();
      if (!w.length) throw new Error('Pick a winner for every pot');
      return { ...pot, winners: w };
    });
    return finish(h, decided, 'showdown');
  }

  function finish(h, decidedPots, how) {
    const payout = {};
    h.seats.forEach((p) => (payout[p] = 0));
    for (const pot of decidedPots) {
      const s = splitPot(pot.amt, pot.winners, h.seats);
      for (const p in s) payout[p] += s[p];
    }
    const delta = {};
    h.seats.forEach((p) => (delta[p] = payout[p] - h.contrib[p]));
    h.status = 'done'; h.toAct = null; h.undo = null; h.lastActor = null;
    h.result = { how, pots: decidedPots, payout, delta };
    if (h.mode === 'online' && h.secret) h.reveal = unseal(h.secret, h.key).holes;
    return h;
  }

  /** Host's phone: deal owed cards and finish a showdown waiting for the deck. */
  function resume(hand) {
    if (!hand.secret) throw new Error('Deck not available on this device');
    const h = clone(hand);
    if (h.owed) {
      const sec = unseal(h.secret, h.key);
      h.board = h.board.concat(sec.deck.splice(0, h.owed));
      h.secret = seal(sec, h.key);
      h.owed = 0;
    }
    if (h.status === 'reveal') return toShowdown(h);
    if (h.status === 'dealing') h.status = 'betting';
    h.v = (hand.v || 0) + 1;
    return h;
  }

  function myHole(h, p) {
    if (h.mode !== 'online' || !h.secret) return null;
    const s = unseal(h.secret, h.key);
    return s.holes[p] || null;
  }

  function potTotal(h) { return Object.values(h.contrib).reduce((a, b) => a + b, 0); }

  /* ---------- money / settlement ---------- */
  /**
   * session: { stacks{pid}, issued{pid}, loans:[{from,to,amt}], repaid? }
   * net = what each person ends up with vs what they started (0).
   */
  function ledger(session, pids) {
    const rows = {};
    for (const p of pids) rows[p] = { stack: session.stacks?.[p] || 0, issued: session.issued?.[p] || 0, borrowed: 0, lent: 0 };
    for (const l of session.loans || []) {
      if (rows[l.to]) rows[l.to].borrowed += l.amt;
      if (rows[l.from]) rows[l.from].lent += l.amt;
    }
    for (const p of pids) { const r = rows[p]; r.net = r.stack - r.issued - r.borrowed + r.lent; }
    return rows;
  }
  // Fewest payments so everyone is square.
  function settleUp(rows) {
    const cred = [], debt = [];
    for (const p in rows) {
      if (rows[p].net > 0) cred.push([p, rows[p].net]);
      else if (rows[p].net < 0) debt.push([p, -rows[p].net]);
    }
    cred.sort((a, b) => b[1] - a[1]); debt.sort((a, b) => b[1] - a[1]);
    const out = [];
    let i = 0, j = 0;
    while (i < debt.length && j < cred.length) {
      const x = Math.min(debt[i][1], cred[j][1]);
      out.push({ from: debt[i][0], to: cred[j][0], amt: x });
      debt[i][1] -= x; cred[j][1] -= x;
      if (!debt[i][1]) i++;
      if (!cred[j][1]) j++;
    }
    return out;
  }
  // Net open debts between two people from loan list (loans and repayments are both entries).
  function openLoans(loans) {
    const m = {};
    for (const l of loans || []) {
      const k = [l.from, l.to].sort().join('|');
      const sign = l.from < l.to ? 1 : -1;
      m[k] = (m[k] || 0) + sign * l.amt;
    }
    const out = [];
    for (const k in m) {
      if (!m[k]) continue;
      const [a, b] = k.split('|');
      out.push(m[k] > 0 ? { lender: a, borrower: b, amt: m[k] } : { lender: b, borrower: a, amt: -m[k] });
    }
    return out;
  }

  function pickBank(pids, lastBank) {
    let pool = pids.filter((p) => p !== lastBank);
    if (!pool.length) pool = pids.slice();
    const r = new Uint32Array(1); root.crypto.getRandomValues(r);
    return pool[r[0] % pool.length];
  }

  const Engine = {
    RANKS, CHIPS, STREETS, GAMES, DABBA, limitsFor,
    newDeck, shuffle, eval5, bestHand, cmp, chipBreakdown, buildPots, splitPot,
    startHand, options, act, canChange, changeBet, resolveShowdown, resume, myHole, seal, unseal, potTotal,
    liveList, canActList, ledger, settleUp, openLoans, pickBank,
  };
  root.PokerEngine = Engine;
  if (typeof module !== 'undefined') module.exports = Engine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
