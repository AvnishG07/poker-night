const E = require('../src/engine.js');
const assert = require('assert');
let n = 0; const ok = (c, m) => { assert(c, m); n++; };

// Hand ranking
const bh = (s) => E.bestHand(s.split(' '));
ok(bh('As Ks Qs Js Ts 2d 3c').name === 'Royal flush', 'royal');
ok(bh('Ah 2d 3c 4s 5h Kd Kc').name === 'Straight', 'wheel');
ok(E.cmp(bh('Ah 2d 3c 4s 5h 9d 9c').value, bh('6h 2d 3c 4s 5h 9d 9c').value) < 0, 'wheel < six-high');
ok(bh('Kh Kd Kc 2s 2h 9d 3c').name === 'Full house', 'boat');
ok(bh('Kh Qh 2h 7h 9h 9d 9c').name === 'Flush', 'flush beats trips');
ok(bh('Kh Kd 2c 2s 9h 9d 3c').value.join() === '2,13,9,3', 'best two pair');
// 3 hole + 6 board = 9 cards
ok(bh('Ah Ad Ac 2s 2h 9d 3c 4c 5c').name === 'Full house', '9 cards');

// Pots
let pots = E.buildPots({ a: 100, b: 300, c: 300 }, {});
ok(pots.length === 2 && pots[0].amt === 300 && pots[1].amt === 400, 'side pot');
pots = E.buildPots({ a: 100, b: 300, c: 500 }, { c: false, b: true });
ok(pots.reduce((s, p) => s + p.amt, 0) === 900, 'chips conserved');

// Split
const sp = E.splitPot(250, ['a', 'b'], ['a', 'b', 'c']);
ok(sp.a === 130 && sp.b === 120, 'odd chip to first');

// Full online hand, all-in game with caps
let h = E.startHand({ no: 1, game: 'allin', mode: 'online', seats: ['A', 'B', 'C'], dealer: 'C',
  stacks: { A: 1000, B: 1000, C: 1000 }, caps: { A: 200 } });
ok(h.contrib.C === 100 && h.toAct === 'A', 'dabba + first to act');
ok(h.start.A === 200, 'cap applied');
ok(E.myHole(h, 'A').length === 2, 'hole cards');
h = E.act(h, 'A', { type: 'raise', total: 200 });
ok(h.allin.A, 'A all in at cap');
ok(E.canChange(h, 'A'), 'A can change');
const changed = E.changeBet(h, 'A');
ok(changed.toAct === 'A' && changed.contrib.A === 0, 'change restores');
h = E.act(h, 'B', { type: 'raise', total: 500 });
ok(!E.canChange(h, 'A'), 'A locked after B acted');
h = E.act(h, 'C', { type: 'call' });
ok(h.street === 1 && h.board.length === 3, 'flop dealt');
h = E.act(h, 'B', { type: 'check' });
h = E.act(h, 'C', { type: 'check' });
h = E.act(h, 'B', { type: 'check' });
h = E.act(h, 'C', { type: 'check' });
h = E.act(h, 'B', { type: 'check' });
h = E.act(h, 'C', { type: 'check' });
ok(h.status === 'done', 'showdown done');
const tot = Object.values(h.result.payout).reduce((a, b) => a + b, 0);
ok(tot === 200 + 500 + 600, 'payout = pot ' + tot);
ok(Object.values(h.result.delta).reduce((a, b) => a + b, 0) === 0, 'deltas zero-sum');

// Limit game, physical, rising
h = E.startHand({ no: 2, game: 'limit', mode: 'physical', seats: ['A', 'B'], dealer: 'A',
  stacks: { A: 5000, B: 5000 }, limitStructure: 'rising' });
ok(h.toAct === 'B', 'B first');
let o = E.options(h, 'B');
ok(o.maxTotal === 100, 'preflop cap 100');
assert.throws(() => E.act(h, 'B', { type: 'raise', total: 150 }));
h = E.act(h, 'B', { type: 'raise', total: 60 });
h = E.act(h, 'A', { type: 'raise', total: 100 });
o = E.options(h, 'B');
ok(!o.canRaise && o.toCall === 40, 'at cap: call only');
h = E.act(h, 'B', { type: 'call' });
ok(h.street === 1 && E.options(h, 'B').maxTotal === 200, 'flop cap 200');
for (let i = 0; i < 6; i++) h = E.act(h, h.toAct, { type: 'check' });
ok(h.status === 'showdown', 'physical waits for winner');
h = E.resolveShowdown(h, [['A']]);
ok(h.result.delta.A === 100 && h.result.delta.B === -100, 'A wins B money + own dabba back');

// Dabba contested by all at physical showdown
h = E.startHand({ no: 9, game: 'limit', mode: 'physical', seats: ['A', 'B', 'C'], dealer: 'C', stacks: { A: 500, B: 500, C: 500 }, limitStructure: 'flat', lastLimit: 300 });
for (let i = 0; i < 12 && h.status === 'betting'; i++) h = E.act(h, h.toAct, { type: 'check' });
ok(h.pots.length === 1 && h.pots[0].amt === 100 && h.pots[0].eligible.length === 3, 'dabba pot open to all');
h = E.resolveShowdown(h, [['B']]);
ok(h.result.delta.B === 100 && h.result.delta.C === -100, 'B wins dabba');
// All-in short stack still eligible for dabba
h = E.startHand({ no: 10, game: 'allin', mode: 'physical', seats: ['A', 'B', 'C'], dealer: 'C', stacks: { A: 50, B: 500, C: 500 } });
h = E.act(h, 'A', { type: 'raise', total: 50 });
h = E.act(h, 'B', { type: 'raise', total: 200 });
h = E.act(h, 'C', { type: 'call' });
for (let i = 0; i < 6 && h.status === 'betting'; i++) h = E.act(h, h.toAct, { type: 'check' });
ok(h.pots[0].amt === 250 && h.pots[0].eligible.length === 3 && h.pots[1].amt === 300, 'main 50x3+dabba, side 300');
h = E.resolveShowdown(h, [['A'], ['B']]);
ok(h.result.payout.A === 250 && h.result.payout.B === 300, 'side pot payouts');

// Fold win
h = E.startHand({ no: 3, game: 'allin', mode: 'online', seats: ['A', 'B', 'C'], dealer: 'A', stacks: { A: 500, B: 500, C: 500 } });
h = E.act(h, 'B', { type: 'raise', total: 50 });
h = E.act(h, 'C', { type: 'fold' });
h = E.act(h, 'A', { type: 'fold' });
ok(h.status === 'done' && h.result.delta.B === 100, 'B takes dabba');

// Everyone all-in runs out board
h = E.startHand({ no: 4, game: 'allin', mode: 'online', seats: ['A', 'B'], dealer: 'A', stacks: { A: 300, B: 800 } });
h = E.act(h, 'B', { type: 'raise', total: 800 });
h = E.act(h, 'A', { type: 'call' });
ok(h.status === 'done' && h.board.length === 5, 'run out');
ok(h.result.payout.B >= 500, 'B gets uncalled back');

// Split mode: players act without the deck; host resumes
{
  let full = E.startHand({ no: 20, game: 'limit', mode: 'online', seats: ['A', 'B', 'C'], dealer: 'C', stacks: { A: 900, B: 900, C: 900 }, limitStructure: 'rising' });
  const strip = (x) => { const y = JSON.parse(JSON.stringify(x)); delete y.secret; delete y.key; if (y.undo) { delete y.undo.secret; delete y.undo.key; } return y; };
  const attach = (x) => { const y = JSON.parse(JSON.stringify(x)); y.secret = full.secret; y.key = full.key; return y; };
  let pub = strip(full);
  let guard = 0;
  while (guard++ < 100) {
    if (pub.status === 'dealing' || pub.status === 'reveal') { full = E.resume(attach(pub)); pub = strip(full); continue; }
    if (pub.status !== 'betting') break;
    pub = E.act(pub, pub.toAct, { type: E.options(pub, pub.toAct).canCheck ? 'check' : 'call' });
    if (pub.status === 'betting' && pub.owed) throw new Error('should be dealing');
  }
  ok(pub.status === 'done' || full.status === 'done', 'split hand finishes');
  const fin = full.status === 'done' ? full : pub;
  ok(fin.board.length === 6 && fin.shown && Object.keys(fin.shown).length === 3, 'board + showdown via host');
}

// Ledger
const rows = E.ledger({ stacks: { A: 1500, B: 200, C: 300 }, issued: { A: 1000, B: 500, C: 500 }, loans: [{ from: 'A', to: 'B', amt: 100 }] }, ['A', 'B', 'C']);
ok(rows.A.net === 600 && rows.B.net === -400 && rows.C.net === -200, 'net');
const pays = E.settleUp(rows);
ok(pays.reduce((s, p) => s + p.amt, 0) === 600, 'settle');
ok(E.pickBank(['A', 'B'], 'A') === 'B', 'bank not repeated');

// Random fuzz: chips always conserved
for (let t = 0; t < 2000; t++) {
  const seats = ['A', 'B', 'C', 'D'].slice(0, 2 + (t % 3));
  const stacks = {}; seats.forEach((p) => (stacks[p] = 100 + Math.floor(Math.random() * 30) * 50));
  const game = t % 2 ? 'limit' : 'allin';
  h = E.startHand({ no: t, game, mode: 'online', seats, dealer: seats[t % seats.length], stacks,
    caps: { A: Math.random() < .3 ? 200 : 0 }, limitStructure: 'flat', lastLimit: 400 });
  let guard = 0;
  while (h.status === 'betting' && guard++ < 200) {
    const p = h.toAct; const o = E.options(h, p);
    const r = Math.random();
    if (r < .15) h = E.act(h, p, { type: 'fold' });
    else if (r < .5 && o.canRaise) h = E.act(h, p, { type: 'raise', total: Math.min(o.maxTotal, o.minTotal + 10 * Math.floor(Math.random() * 20)) });
    else h = E.act(h, p, { type: o.canCheck ? 'check' : 'call' });
  }
  assert(h.status === 'done', 'finished ' + t);
  const sum = Object.values(h.result.delta).reduce((a, b) => a + b, 0);
  assert(sum === 0, 'zero sum ' + t + ' ' + sum);
  for (const p of seats) assert(h.result.delta[p] >= -h.start[p], 'never lose more than cap');
}
n++;
console.log('all', n, 'checks passed');

// Chips during a hand
{
  let h = E.startHand({ no: 30, game: 'limit', mode: 'physical', seats: ['A', 'B'], dealer: 'A', stacks: { A: 300, B: 300 }, limitStructure: 'flat' });
  let x = E.adjustInHand(h, 'B', 500, 0);
  ok(x.behind.B === 800 && x.start.B === 800, 'receive mid-hand');
  ok(E.adjustInHand(h, 'B', -100, 1300) === null, 'lend from outside chips');
  x = E.adjustInHand(h, 'B', -200, 300);
  ok(x.behind.B === 100, 'lend from unbet chips');
  let threw = false; try { E.adjustInHand(h, 'B', -300, 300); } catch (e) { threw = true; }
  ok(threw, 'cannot lend chips needed in hand');
  const c = E.startHand({ no: 31, game: 'allin', mode: 'physical', seats: ['A', 'B'], dealer: 'A', stacks: { A: 3000, B: 300 }, caps: { A: 500 } });
  ok(E.adjustInHand(c, 'A', 500, 0) === null, 'capped player: new chips stay outside the hand');
}
console.log('mid-hand checks ok');

{
  // Board makes a flush with 3 hole hearts only if all 3 used → not allowed
  const b = E.bestFor('limit', ['Ah','Kh','Qh'], ['2h','3h','9c','9d','5s','7c']);
  ok(b.name !== 'Flush', '3-card flush not allowed: ' + b.name);
  const b2 = E.bestFor('limit', ['Ah','Kh','2c'], ['2h','3h','9h','9d','5s','7c']);
  ok(b2.name === 'Flush', '2 own + 3 board flush ok');
  ok(E.bestFor('allin', ['Ah','Kh'], ['2h','3h','9h','9d','5s']).name === 'Flush', 'holdem unchanged');
  // rejudge
  let h = E.startHand({ no: 50, game: 'limit', mode: 'online', seats: ['A','B'], dealer: 'A', stacks: { A: 900, B: 900 }, limitStructure: 'flat' });
  while (h.status === 'betting') h = E.act(h, h.toAct, { type: E.options(h, h.toAct).canCheck ? 'check' : 'call' });
  const r = E.rejudge(h);
  ok(r && Object.values(r.diff).reduce((a,b)=>a+b,0) === 0, 'rejudge diff zero-sum');
  console.log('two-card rule ok');
}

{
  // Both river cards would give a flush; only one may be used → no flush
  const b = E.bestFor('limit', ['Ah','Kh','2c'], ['2h','9c','9d','5s','3h','4h']);
  ok(b.name !== 'Flush', 'only one river card: ' + b.name);
  // One river card completes a straight
  const s2 = E.bestFor('limit', ['9h','8d','2c'], ['7s','6c','Kd','Qh','5h','2s']);
  ok(s2.name === 'Straight', 'river option straight: ' + s2.name);
  ok(s2.cards.filter((c) => ['5h','2s'].includes(c)).length <= 1, 'max one river card used');
  console.log('one-river rule ok');
}
