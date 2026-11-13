/* ============================================================
   APP — screens and user actions. Talks to storage only through
   PokerStore's adapter, and to rules only through PokerEngine.
   ============================================================ */
(function () {
  const E = window.PokerEngine;
  const $app = document.getElementById('app');

  const S = {
    store: null, me: null, ready: false,
    config: null, session: null, hand: null, history: [], chat: [], nights: [],
    tab: 'table', sid: null, unsub: [], lastSeenChat: 0, applyTimer: null,
    ui: { newMode: 'physical', raise: 0, raiseFor: null, nick: '', chat: '', newNight: '', offName: '', modal: null, amt: 0, potPick: {}, viewNight: null, partial: '' },
  };

  /* ---------- helpers ---------- */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rs = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
  const sgn = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + '₹' + Math.abs(n).toLocaleString('en-IN');
  const nm = (pid) => (S.session && S.session.players && S.session.players[pid] && S.session.players[pid].name) || 'Player';
  const sessPath = () => 'sessions/' + S.sid;
  const handPath = () => 'sessions/' + S.sid + '/live/hand';
  const secretPath = () => 'sessions/' + S.sid + '/secret/hand';
  const holePath = (pid) => 'sessions/' + S.sid + '/holes/' + pid;
  const split = () => !!(S.store && S.store.splitSecrets);
  // Hidden cards: the deck lives only where the host's phone can read it.
  function strip(h) {
    if (!split() || !h) return h;
    const y = JSON.parse(JSON.stringify(h));
    delete y.secret; delete y.key; delete y.reveal;
    if (y.undo) { delete y.undo.secret; delete y.undo.key; delete y.undo.reveal; }
    return y;
  }
  function attach(h, sec) {
    if (!split() || !h || !sec || sec.no !== h.no) return h;
    const y = JSON.parse(JSON.stringify(h));
    y.secret = sec.secret; y.key = sec.key;
    if (y.undo) { y.undo.secret = sec.secret; y.undo.key = sec.key; }
    return y;
  }
  function cardsOf(pid) {
    const h = S.hand;
    if (!h || h.mode !== 'online') return null;
    if (!split()) return E.myHole(h, pid);
    if (isAdmin() && S.secret && S.secret.no === h.no) return E.myHole(attach(h, S.secret), pid);
    if (pid === S.me.id && S.myHole && S.myHole.no === h.no) return S.myHole.cards;
    return null;
  }
  const isAdmin = () => !!S.session && (S.session.adminId === S.me.id || S.store.isOwner);
  const isBank = () => !!S.session && S.session.bankId === S.me.id;
  const isPlayer = () => !!S.session && !!S.session.players && !!S.session.players[S.me.id];
  const handLive = () => S.hand && S.session && S.hand.no === S.session.handNo && S.hand.status !== 'done';
  const pids = () => (S.session ? (S.session.order || []).filter((p) => S.session.players[p] && !S.session.players[p].left) : []);

  function toast(msg, err) {
    const t = document.createElement('div');
    t.className = 'toast' + (err ? ' err' : '');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }
  async function run(fn) {
    try { await fn(); } catch (e) {
      console.error(e);
      if (e && e.code === 'invalid_argument') { toast("You can watch but not play yet. Host: turn off the public link and invite this person as Editor.", true); return; }
      toast(e && e.message ? e.message : 'Something went wrong', true);
    }
  }

  function cardHTML(c, cls = '') {
    if (!c) return `<div class="pc slot ${cls}"></div>`;
    if (c === '??') return `<div class="pc back ${cls}"></div>`;
    const r = c[0] === 'T' ? '10' : c[0];
    const s = { s: '♠', h: '♥', d: '♦', c: '♣' }[c[1]];
    const red = c[1] === 'h' || c[1] === 'd';
    return `<div class="pc ${red ? 'red' : ''} ${cls}"><span class="r">${r}</span><span class="s">${s}</span></div>`;
  }
  // Limit game: the 2 river cards lie sideways, stacked across the end of the row.
  function boardHTML(cards, game, size, slots) {
    const g = E.GAMES[game];
    const total = g.board.reduce((a, b) => a + b, 0);
    const list = slots ? Array.from({ length: total }, (_, i) => cards[i]) : cards.slice();
    if (game !== 'limit') return list.map((c) => cardHTML(c, size)).join('');
    const main = list.slice(0, 4), river = list.slice(4, 6);
    return main.map((c) => cardHTML(c, size)).join('') +
      (river.length ? `<div class="rivercol">${river.map((c) => cardHTML(c, 'side ' + size)).join('')}</div>` : '');
  }
  function chipStack(amount) {
    const b = E.chipBreakdown(amount);
    const col = { 10: '#f2f2f2', 20: '#e2524a', 40: '#2f7dd1', 100: '#1d1d1d' };
    return Object.keys(b).filter((k) => k !== 'rest').sort((a, z) => z - a)
      .map((k) => `<span class="small mute">${b[k]}×</span><span class="mini" style="background:${col[k]}"></span><span class="small" style="margin-right:6px">${k}</span>`).join('');
  }

  /* ---------- data mutations (all go through the store) ---------- */
  async function mutate(path, fn) {
    if (S.store.mutate) return S.store.mutate(path, fn);
    let out;
    await S.store.lock(path, async () => {
      const cur = await S.store.get(path);
      const draft = cur ? JSON.parse(JSON.stringify(cur)) : null;
      const r = await fn(draft);
      if (r === false) return;
      out = r && r !== true ? r : draft;
      await S.store.set(path, out);
    });
    return out;
  }
  const mutateSession = (fn) => mutate(sessPath(), (s) => { if (!s) throw new Error('Night not found'); return fn(s); });

  function logEntry(s, e) {
    s.moneyLog = s.moneyLog || [];
    s.moneyLog.push({ ...e, ts: Date.now(), by: S.me.id });
    if (s.moneyLog.length > 300) s.moneyLog = s.moneyLog.slice(-300);
  }

  async function startNight() {
    const cfg = await S.store.get('config/main');
    if (cfg && cfg.activeSessionId) { const ex = await S.store.get('sessions/' + cfg.activeSessionId); if (ex && ex.status === 'open') throw new Error('A night is already running — reloading'); }
    if (S.store.setName && (S.ui.nick || '').trim()) S.store.setName(S.ui.nick.trim());
    const name = (S.ui.newNight || '').trim() || 'Poker night · ' + new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    const sid = 's' + Date.now().toString(36);
    const me = S.me.id;
    const session = {
      id: sid, name, createdAt: Date.now(), adminId: me, status: 'open',
      players: { [me]: { name: S.ui.nick || S.me.name || 'Host', uid: me, offline: false, joinedAt: Date.now() } },
      order: [me], requests: {}, bankId: null, issued: {}, stacks: {}, loans: [], caps: {},
      settings: { game: 'allin', mode: S.ui.newMode === 'online' ? 'online' : 'physical', limitStructure: 'flat', lastLimit: 300 },
      handNo: 0, appliedHand: 0, lastDealer: null, moneyLog: [],
    };
    await S.store.set('sessions/' + sid, session);
    await mutate('config/main', (c) => ({ ...(c || {}), activeSessionId: sid }));
    S.ui.newNight = '';
  }

  async function requestJoin() {
    const nick = (S.ui.nick || S.me.name || '').trim();
    if (!nick) throw new Error('Type your name first');
    if (S.store.setName) S.store.setName(nick);
    await mutateSession((s) => {
      if (s.players[S.me.id]) return false;
      s.requests = s.requests || {};
      s.requests[S.me.id] = { name: nick.slice(0, 24), ts: Date.now() };
    });
    toast('Request sent — the host will add you');
  }
  async function approve(uid, yes) {
    await mutateSession((s) => {
      const r = s.requests && s.requests[uid];
      if (!r) return false;
      delete s.requests[uid];
      if (yes && !s.players[uid]) {
        s.players[uid] = { name: r.name, uid, offline: false, joinedAt: Date.now() };
        s.order.push(uid);
      }
    });
  }
  async function addOffline() {
    const n = (S.ui.offName || '').trim();
    if (!n) throw new Error('Type a name');
    const pid = 'off' + Date.now().toString(36);
    await mutateSession((s) => {
      s.players[pid] = { name: n.slice(0, 24), uid: null, offline: true, joinedAt: Date.now() };
      s.order.push(pid);
    });
    S.ui.offName = '';
  }
  async function toggleOut(pid) {
    await mutateSession((s) => { s.players[pid].out = !s.players[pid].out; });
  }
  async function pickBank() {
    let chosen;
    const cfg = (await S.store.get('config/main')) || {};
    await mutateSession((s) => {
      if (s.bankId) throw new Error('Bank already chosen');
      const list = s.order.filter((p) => !s.players[p].left);
      if (list.length < 2) throw new Error('Add at least 2 players first');
      chosen = E.pickBank(list, cfg.lastBankId);
      s.bankId = chosen;
      if (!s.firstDealer) s.firstDealer = list[Math.floor(Math.random() * list.length)];
      logEntry(s, { t: 'bank', p: chosen });
    });
    await mutate('config/main', (c) => ({ ...(c || {}), lastBankId: chosen }));
    toast(nm(chosen) + ' is the bank tonight 🏦');
  }
  function noHandCheck() { if (handLive()) throw new Error('Wait until this hand is over'); }
  // Chips can move at any time; if a hand is running, the player's chips in the hand are updated too.
  async function syncHand(from, to, amt, fromStackBefore) {
    if (!handLive()) return;
    await mutate(handPath(), (h) => {
      if (!h || h.status === 'done') return false;
      let x = h, changed = false;
      if (from) { const r = E.adjustInHand(x, from, -amt, fromStackBefore); if (r) { x = r; changed = true; } }
      if (to) { const r = E.adjustInHand(x, to, amt, 0); if (r) { x = r; changed = true; } }
      return changed ? x : false;
    });
  }
  async function giveChips(pid, amt) {
    amt = Math.round(amt);
    if (!(amt > 0)) throw new Error('Pick an amount');
    await mutateSession((s) => {
      s.stacks[pid] = (s.stacks[pid] || 0) + amt;
      s.issued[pid] = (s.issued[pid] || 0) + amt;
      logEntry(s, { t: 'issue', p: pid, a: amt });
    });
    await syncHand(null, pid, amt, 0);
    toast('Bank gave ' + rs(amt) + ' to ' + nm(pid));
  }
  async function lend(from, to, amt, kind) {
    amt = Math.round(amt);
    if (!(amt > 0)) throw new Error('Pick an amount');
    let before = null;
    if (handLive()) {
      const h = await S.store.get(handPath());
      if (h && h.status !== 'done') E.adjustInHand(h, from, -amt, S.session.stacks[from] || 0); // throws if not enough free chips
    }
    await mutateSession((s) => {
      before = s.stacks[from] || 0;
      if ((s.stacks[from] || 0) < amt) throw new Error(nm(from) + ' has only ' + rs(s.stacks[from] || 0));
      s.stacks[from] -= amt;
      s.stacks[to] = (s.stacks[to] || 0) + amt;
      s.loans.push({ from, to, amt, ts: Date.now(), kind: kind || 'loan' });
      logEntry(s, { t: kind || 'loan', from, to, a: amt });
    });
    await syncHand(from, to, amt, before);
    toast((kind === 'repay' ? 'Repaid ' : 'Lent ') + rs(amt));
  }
  // All-in game: everyone sets their limit for the NEXT hand before it can be dealt.
  async function setCap(v, pid) {
    pid = pid || S.me.id;
    const n = Math.max(0, Math.round(Number(v) || 0));
    await mutateSession((s) => {
      const N = (s.handNo || 0) + 1;
      if (!s.capRound || s.capRound.no !== N) s.capRound = { no: N, caps: {} };
      s.capRound.caps[pid] = n;
      s.caps = s.caps || {}; s.caps[pid] = n;
    });
    toast(n ? 'All-in limit set: ' + rs(n) : 'No limit set');
  }
  function seatsFor(s) {
    return s.order.filter((p) => s.players[p] && !s.players[p].out && !s.players[p].left && (s.stacks[p] || 0) > 0);
  }
  function nextDealer(s) {
    const seats = seatsFor(s);
    if (!seats.length) return null;
    if (!s.lastDealer || s.order.indexOf(s.lastDealer) < 0) return s.firstDealer && seats.includes(s.firstDealer) ? s.firstDealer : null;
    const i = s.order.indexOf(s.lastDealer);
    for (let k = 1; k <= s.order.length; k++) { const p = s.order[(i + k) % s.order.length]; if (seats.includes(p)) return p; }
    return null;
  }
  function capsPending(s) {
    const N = (s.handNo || 0) + 1;
    const got = s.capRound && s.capRound.no === N ? s.capRound.caps : {};
    return seatsFor(s).filter((p) => !(p in got) && !s.players[p].offline);
  }
  function canChooseGame() {
    const s = S.session;
    const d = nextDealer(s);
    return isAdmin() || (d && d === S.me.id);
  }
  async function saveSettings(patch) {
    await mutateSession((s) => { s.settings = { ...s.settings, ...patch }; });
  }

  /* ---------- hand lifecycle ---------- */
  async function dealHand() {
    const cur = await S.store.get(handPath());
    if (cur && cur.status !== 'done') throw new Error('A hand is already running');
    let hand;
    await mutateSession((s) => {
      if ((s.appliedHand || 0) < (s.handNo || 0)) throw new Error('Last hand is still being settled — wait a second');
      const seats = seatsFor(s);
      if (seats.length < 2) throw new Error('Need at least 2 players with chips (bank gives chips in Players)');
      const dealer = nextDealer(s) || seats[Math.floor(Math.random() * seats.length)];
      const st = s.settings;
      const N = (s.handNo || 0) + 1;
      let caps = {};
      if (st.game === 'allin') {
        const waiting = capsPending(s);
        if (waiting.length) throw new Error('Waiting for all-in limits from: ' + waiting.map((p) => s.players[p].name).join(', '));
        caps = (s.capRound && s.capRound.no === N && s.capRound.caps) || {};
      }
      hand = E.startHand({
        no: N, game: st.game, mode: st.mode, seats, dealer,
        stacks: s.stacks, caps, limitStructure: st.limitStructure, lastLimit: st.lastLimit,
      });
      s.handNo = hand.no; s.lastDealer = dealer;
    });
    if (split() && hand.mode === 'online') {
      await S.store.set(secretPath(), { secret: hand.secret, key: hand.key, no: hand.no });
      const sec = E.unseal(hand.secret, hand.key);
      await Promise.all(hand.seats.map((p) => S.store.set(holePath(p), {
        uid: S.session.players[p] && !S.session.players[p].offline ? p : 'host', cards: sec.holes[p], no: hand.no,
      })));
    }
    await S.store.set(handPath(), strip(hand));
    S.ui.raise = 0;
    if (hand.status === 'done') await applyResult(hand);
  }

  async function handAction(fn, opts) {
    let after;
    const seenV = S.hand && S.hand.v;
    const useSecret = split() && isAdmin() && S.hand && S.hand.mode === 'online';
    const sec = useSecret ? await S.store.get(secretPath()) : null;
    const step = (h) => {
      if (!h) throw new Error('No hand running');
      if (seenV && h.v !== seenV && !(opts && opts.ignoreV)) throw new Error('Table just changed — look again');
      after = fn(attach(h, sec));
      return strip(after);
    };
    if (S.store.mutate) await S.store.mutate(handPath(), step);
    else await S.store.lock(handPath(), async () => { const h = await S.store.get(handPath()); await S.store.set(handPath(), step(h)); });
    if (useSecret && after && sec && after.secret && after.secret !== sec.secret) {
      await S.store.set(secretPath(), { secret: after.secret, key: after.key, no: after.no });
    }
    S.ui.raise = 0;
    if (after && after.status === 'done') await applyResult(after);
  }
  let resuming = false;
  async function hostResume() {
    if (resuming) return;
    resuming = true;
    try { await handAction((h) => E.resume(h), { ignoreV: true }); }
    finally { resuming = false; }
  }
  let holeFetch = null;
  async function fetchMyHole(no) {
    if (holeFetch === no) return;
    holeFetch = no;
    for (let i = 0; i < 6; i++) {
      try {
        const d = await S.store.get(holePath(S.me.id));
        if (d && d.no === no) { S.myHole = d; render(); return; }
      } catch (e) {}
      await new Promise((r) => setTimeout(r, 700));
    }
    holeFetch = null;
  }

  async function applyResult(h) {
    let applied = false;
    await mutateSession((s) => {
      if ((s.appliedHand || 0) >= h.no || s.handNo !== h.no) return false;
      for (const p in h.result.delta) s.stacks[p] = (s.stacks[p] || 0) + h.result.delta[p];
      s.appliedHand = h.no;
      applied = true;
    });
    if (!applied) return;
    const names = {};
    h.seats.forEach((p) => (names[p] = nm(p)));
    await S.store.set(sessPath() + '/hands/h' + String(h.no).padStart(5, '0'), {
      no: h.no, ts: Date.now(), game: h.game, mode: h.mode, dealer: h.dealer, board: h.board || [],
      pots: h.result.pots.map((p) => ({ amt: p.amt, winners: p.winners })), delta: h.result.delta,
      how: h.result.how, names,
      shown: h.shown ? Object.fromEntries(Object.entries(h.shown).map(([p, v]) => [p, { cards: v.cards, name: v.name }])) : null,
    });
  }

  function actorPid() {
    const h = S.hand;
    if (!h || h.status !== 'betting') return null;
    if (h.toAct === S.me.id) return S.me.id;
    const pl = S.session.players[h.toAct];
    if (isAdmin() && pl && pl.offline) return h.toAct;
    return null;
  }

  async function endNight() {
    noHandCheck();
    const ids = pids();
    await mutateSession((s) => {
      const rows = E.ledger(s, ids);
      s.final = { rows, pays: E.settleUp(rows), at: Date.now() };
      s.status = 'closed';
    });
    await mutate('config/main', (c) => ({ ...(c || {}), activeSessionId: null }));
  }

  async function sendChat() {
    const text = (S.ui.chat || '').trim();
    if (!text) return;
    S.ui.chat = '';
    await S.store.add(sessPath() + '/chat', { by: S.me.id, name: nm(S.me.id), text: text.slice(0, 500), ts: Date.now() });
  }

  /* ---------- voice notes (own hosting) ---------- */
  let rec = null, recChunks = [], recTimer = null, recStart = 0, recTick = null;
  const blobToDataURL = (b) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
  async function toggleRecord() {
    if (rec) { rec.stop(); return; }
    if (!navigator.mediaDevices || !window.MediaRecorder) throw new Error('Voice notes are not supported in this browser');
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { throw new Error('Microphone blocked — allow it in your browser settings'); }
    const types = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
    const mime = types.find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
    const r = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 24000 } : { audioBitsPerSecond: 24000 });
    recChunks = [];
    r.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
    r.onstop = () => run(async () => {
      stream.getTracks().forEach((t) => t.stop());
      clearTimeout(recTimer); clearInterval(recTick);
      const dur = Math.round((Date.now() - recStart) / 1000);
      const blob = new Blob(recChunks, { type: r.mimeType || mime || 'audio/webm' });
      rec = null; render();
      if (dur < 1 || !blob.size) return;
      const url = await blobToDataURL(blob);
      if (url.length > 900000) throw new Error('Voice note too long');
      await S.store.add(sessPath() + '/chat', { by: S.me.id, name: nm(S.me.id), audio: url, dur, ts: Date.now() });
    });
    rec = r;
    r.start();
    recStart = Date.now();
    recTimer = setTimeout(() => { if (rec) rec.stop(); }, 30000);
    recTick = setInterval(render, 1000);
    render();
  }

  /* ---------- dictation (voice → text) ---------- */
  let dictState = 'idle';
  async function setupDictation() {
    if (S.store.dictationReady) S.store.dictation = await S.store.dictationReady;
    const d = S.store.dictation;
    if (!d) return;
    render();
    d.onPartial(({ text }) => { S.ui.partial = text; render(); });
    d.onFinal(({ text }) => {
      S.ui.chat = (S.ui.chat ? S.ui.chat + text : text.replace(/^\s+/, ''));
      S.ui.partial = ''; render();
    });
    d.onState(({ state, reason }) => {
      dictState = state;
      if (state === 'idle' && reason === 'not_granted') toast('Microphone not allowed — use your keyboard mic', true);
      render();
    });
  }
  function toggleMic() {
    const d = S.store.dictation;
    if (!d) return;
    if (d.active()) { d.stop(); return; }
    d.start().catch((e) => { if (e && e.code !== 'stopped') toast('Voice not available here — use your keyboard mic', true); });
  }

  /* ---------- subscriptions ---------- */
  function subscribeSession(sid) {
    S.unsub.forEach((u) => { try { u(); } catch (e) {} });
    S.unsub = [];
    S.sid = sid; S.session = null; S.hand = null; S.history = []; S.chat = [];
    S.secretSub = null; S.secret = null; S.myHole = null; holeFetch = null;
    if (!sid) { render(); return; }
    S.unsub.push(S.store.onDoc('sessions/' + sid, (d) => {
      S.session = d;
      if (d && split() && !S.secretSub && (d.adminId === S.me.id || S.store.isOwner)) {
        S.secretSub = S.store.onDoc('sessions/' + sid + '/secret/hand', (x) => { S.secret = x; render(); }, () => {});
        S.unsub.push(S.secretSub);
      }
      render();
    }, onErr));
    S.unsub.push(S.store.onDoc('sessions/' + sid + '/live/hand', onHand, onErr));
    S.unsub.push(S.store.onQuery('sessions/' + sid + '/hands', { orderBy: 'no', dir: 'desc', limit: 60 }, (rows) => { S.history = rows; render(); }, onErr));
    S.unsub.push(S.store.onQuery('sessions/' + sid + '/chat', { orderBy: 'ts', dir: 'desc', limit: 50 }, (rows) => { S.chat = rows.reverse(); render(); }, onErr));
  }
  function onHand(d) {
      const wasMyTurn = S.hand && S.hand.toAct === S.me.id && S.hand.status === 'betting';
      S.hand = d;
      const myTurn = d && d.toAct === S.me.id && d.status === 'betting';
      if (myTurn && !wasMyTurn) { try { navigator.vibrate && navigator.vibrate(120); } catch (e) {} }
      // Fallback: if a finished hand wasn't settled (someone's phone dropped), the admin settles it.
      if (d && split() && d.mode === 'online' && d.seats.includes(S.me.id) && d.status !== 'done' && !(S.myHole && S.myHole.no === d.no)) fetchMyHole(d.no);
      if (d && split() && isAdmin() && (d.status === 'dealing' || d.status === 'reveal')) setTimeout(() => run(hostResume), 300);
      clearTimeout(S.applyTimer);
      if (d && d.status === 'done' && S.session && (S.session.appliedHand || 0) < d.no && isAdmin()) {
        S.applyTimer = setTimeout(() => run(() => applyResult(d)), 2500);
      }
      render();
  }
  // Safety net: if live updates stall (Safari, weak network), check the table every few seconds.
  async function pollTable() {
    if (!S.sid || document.hidden || !S.store || S.store.kind !== 'firebase') return;
    try {
      const d = await S.store.get(handPath());
      if (d && (!S.hand || d.no !== S.hand.no || d.v !== S.hand.v || d.status !== S.hand.status)) onHand(d);
    } catch (e) {}
  }
  setInterval(pollTable, 6000);
  async function refreshAll() {
    if (!S.sid || !S.store || S.store.kind !== 'firebase') return;
    try {
      const sd = await S.store.get(sessPath()); if (sd) { S.session = sd; render(); }
    } catch (e) {}
    pollTable();
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAll(); });
  window.addEventListener('online', refreshAll);
  window.addEventListener('pageshow', refreshAll);
  function onErr(e) {
    console.warn('store error', e);
    S.connErr = (e && (e.code || e.message)) || 'error';
    render();
  }

  /* ---------- rendering ---------- */
  function render() {
    const playing = [...document.querySelectorAll('audio')].some((a) => !a.paused);
    if (playing && S.tab === 'chat') { clearTimeout(S.rerender); S.rerender = setTimeout(render, 800); return; }
    if (!S.ready) { $app.innerHTML = `<div class="empty" style="padding-top:40vh">Shuffling the deck…</div>`; return; }
    const ae = document.activeElement;
    const focusKey = ae && ae.dataset && ae.dataset.bind;
    const selStart = ae && ae.selectionStart;
    const scrollMsgs = document.querySelector('.msgs');
    const atBottom = scrollMsgs ? scrollMsgs.scrollHeight - scrollMsgs.scrollTop - scrollMsgs.clientHeight < 40 : true;

    let body = '';
    const banners = [];
    if (S.store.kind === 'memory') banners.push(`<div class="banner info">Preview mode — data stays on this device only. Open the shared link signed in to play with friends.</div>`);
    if (S.connErr) banners.push(`<div class="banner">Connection problem (${esc(S.connErr)}). Close the page and open the link again in a minute.</div>`);
    if (S.store.canWrite === false) banners.push(`<div class="banner">You can watch but not play. Ask the host to invite you as an <b>Editor</b>.</div>`);

    if (!S.session || S.session.status === 'closed') body = lobbyView();
    else if (!isPlayer() && !isAdmin()) body = joinView();
    else if (S.tab === 'table') body = tableView();
    else if (S.tab === 'players') body = playersView();
    else if (S.tab === 'hands') body = handsView();
    else if (S.tab === 'chat') body = chatView();
    else if (S.tab === 'settle') body = settleView();

    const top = `<div class="top"><div class="brand">♠ Poker <b>Night</b></div><div class="sub">${S.session && S.session.status === 'open' ? esc(S.session.name) + ' · ' + (S.session.settings.mode === 'online' ? 'online' : 'real cards') + '<br>' : ''}${esc(S.me.name || '')}${S.session && isAdmin() ? ' · admin' : ''}</div></div>`;
    const showNav = S.session && S.session.status === 'open' && (isPlayer() || isAdmin());
    const unread = S.chat.length && S.chat[S.chat.length - 1].ts > S.lastSeenChat && S.tab !== 'chat' && S.chat[S.chat.length - 1].by !== S.me.id;
    const myTurn = S.hand && S.hand.status === 'betting' && actorPid();
    const nav = showNav ? `<div class="nav"><div class="in">
      ${navBtn('table', '🂡', 'Table', myTurn && S.tab !== 'table')}
      ${navBtn('players', '👥', 'Players', isAdmin() && S.session.requests && Object.keys(S.session.requests).length)}
      ${navBtn('hands', '📜', 'Hands')}
      ${navBtn('chat', '💬', 'Chat', unread)}
      ${navBtn('settle', '🧮', 'Settle')}
    </div></div>` : '';
    $app.innerHTML = top + banners.join('') + `<div class="wrap">${body}</div>` + nav + modalView();

    if (focusKey) {
      const el = $app.querySelector(`[data-bind="${focusKey}"]`);
      if (el) { el.focus(); try { if (selStart != null) el.setSelectionRange(selStart, selStart); } catch (e) {} }
    }
    const m = document.querySelector('.msgs');
    if (m && atBottom) m.scrollTop = m.scrollHeight;
    if (S.tab === 'chat' && S.chat.length) S.lastSeenChat = S.chat[S.chat.length - 1].ts;
    document.title = (myTurn ? '🔔 Your turn · ' : '') + 'Poker Night';
  }
  const navBtn = (t, i, l, dot) => `<button data-act="tab" data-v="${t}" class="${S.tab === t ? 'on' : ''}"><span class="i">${i}</span>${l}${dot ? '<span class="dot"></span>' : ''}</button>`;

  function lobbyView() {
    let h = '';
    if (S.store.canWrite !== false) {
      h += `<div class="card"><h3>Start a new night</h3>
        <div class="small mute" style="margin-bottom:6px">No game is running. Whoever starts the night becomes its admin, and everyone else who opens the link joins it.</div>
        <label class="lb">Name for tonight (optional)</label>
        <input class="in" data-bind="newNight" placeholder="Friday game" value="${esc(S.ui.newNight)}">
        <label class="lb">Your name at the table</label>
        <input class="in" data-bind="nick" placeholder="${esc(S.me.name || 'Host')}" value="${esc(S.ui.nick)}">
        <label class="lb">Cards for the whole night</label>
        <div class="seg"><button class="${S.ui.newMode !== 'online' ? 'on' : ''}" data-act="newMode" data-v="physical">Real cards</button><button class="${S.ui.newMode === 'online' ? 'on' : ''}" data-act="newMode" data-v="online">Online (app deals)</button></div>
        <div class="small mute" style="margin-top:6px">${S.ui.newMode === 'online' ? 'The app shuffles and deals. Everyone sees their cards on their phone.' : 'You deal real cards. The app handles chips, bets and accounts.'} This can't be changed once the night starts.</div>
        <div style="height:10px"></div>
        <button class="btn gold full" data-act="startNight">Start night</button></div>`;
    } else {
      h += `<div class="card empty">No game running right now.<br>The host will start one — keep this page open.</div>`;
    }
    const past = S.nights.filter((n) => n.status === 'closed');
    if (past.length) {
      h += `<div class="card"><h3>Past nights</h3><div class="list">` + past.map((n) => {
        const open = S.ui.viewNight === n.id;
        let inner = '';
        if (open && n.final) {
          inner = `<div style="width:100%">` + finalTable(n.final.rows, n.players) +
            `<div style="margin-top:8px">` + (n.final.pays.length ? n.final.pays.map((p) => `<div class="small">${esc(n.players[p.from]?.name)} → ${esc(n.players[p.to]?.name)} <b>${rs(p.amt)}</b></div>`).join('') : '<div class="small mute">Everyone is square</div>') + `</div></div>`;
        }
        return `<div class="li" style="flex-wrap:wrap"><div class="grow"><div><b>${esc(n.name)}</b></div><div class="small mute">${new Date(n.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })} · ${n.handNo || 0} hands</div></div>
          <button class="btn sm" data-act="viewNight" data-v="${esc(n.id)}">${open ? 'Hide' : 'Results'}</button>${inner}</div>`;
      }).join('') + `</div></div>`;
    }
    return h;
  }

  function joinView() {
    const s = S.session;
    const req = s.requests && s.requests[S.me.id];
    return `<div class="card"><h3>${esc(s.name)}</h3>
      ${req ? `<div class="empty">Waiting for the host to add you…</div>` : `
      <label class="lb">Your name at the table</label>
      <input class="in" data-bind="nick" placeholder="${esc(S.me.name || 'Your name')}" value="${esc(S.ui.nick)}">
      <div style="height:10px"></div><button class="btn gold full" data-act="join">Ask to join</button>`}
      <div class="small mute" style="margin-top:10px">${pids().length} player(s) at the table</div></div>`;
  }

  function tableView() {
    const s = S.session, h = S.hand;
    let out = '';
    const handActive = h && h.no === s.handNo;
    if (!handActive || h.status === 'done') {
      if (handActive && h.status === 'done') out += resultCard(h);
      out += setupCard();
      if (!s.bankId) out += `<div class="banner">No bank yet. ${isAdmin() ? 'Go to <b>Players</b> → pick the bank randomly.' : 'The host will pick one.'}</div>`;
      out += seatsPreview();
      return out;
    }
    const g = E.GAMES[h.game];
    const pot = E.potTotal(h);
    const street = h.status === 'showdown' || h.status === 'reveal' ? 'Showdown' : E.STREETS[h.street];
    const limit = h.limits ? ` · limit <b>${rs(h.limits[h.street] || 0)}</b>/round` : '';
    // Board
    let board = '';
    if (h.mode === 'online') {
      board = boardHTML(h.board, h.game, '', true);
    } else {
      const say = h.status === 'showdown' ? 'Show your cards!' : ['Deal ' + g.hole + ' cards to each player', 'Deal the flop (3 cards)', 'Deal the turn (1 card)', 'Deal the river (' + g.board[3] + ' card' + (g.board[3] > 1 ? 's' : '') + ')'][h.street];
      board = `<div class="mute" style="text-align:center">🃏 Physical cards<br><b style="color:var(--ink)">${say}</b></div>`;
    }
    out += `<div class="felt">
      <div class="hinfo"><span>Hand #${h.no} · ${esc(g.label)}</span><span>${h.mode === 'online' ? 'Online' : 'Real cards'}</span></div>
      <div class="pot"><div class="lbl">Pot</div><div class="amt">${rs(pot)}</div><div class="small mute">incl. ${rs(h.dabba)} dabba from ${esc(nm(h.dealer))}</div></div>
      <div class="board">${board}</div>
      <div class="street"><b>${street}</b>${h.status === 'betting' ? limit : ''}</div>
      <div class="seats">${h.seats.map((p) => seatRow(h, p)).join('')}</div>
    </div>`;
    // my cards
    if (h.mode === 'online' && h.seats.includes(S.me.id)) {
      const mine = cardsOf(S.me.id) || [];
      let hint = '';
      if (mine.length && h.board.length >= 3 && !h.folded[S.me.id]) { const b = E.bestHand(mine.concat(h.board)); hint = `<div class="small mute" style="text-align:center">You have: <b style="color:var(--ink)">${b.name}</b></div>`; }
      out += `<div class="card" style="padding:10px"><div class="mine">${mine.map((c) => cardHTML(c, 'big')).join('')}</div>${hint}</div>`;
    }
    // change bet
    if (E.canChange(h, S.me.id) || (isAdmin() && h.lastActor && S.session.players[h.lastActor]?.offline && E.canChange(h, h.lastActor))) {
      out += `<button class="btn full" data-act="change" style="margin:6px 0">↩︎ Change ${h.lastActor === S.me.id ? 'my' : esc(nm(h.lastActor)) + "'s"} last move</button>`;
    }
    if (h.status === 'dealing' || h.status === 'reveal') out += `<div class="card small mute" style="text-align:center">Dealing… (the host's phone deals the cards — keep it open)</div>`;
    if (h.status === 'betting') out += actionPanel(h);
    if (h.status === 'showdown') out += showdownPicker(h);
    return out;
  }

  function seatRow(h, p) {
    const pl = S.session.players[p] || {};
    const turn = h.status === 'betting' && h.toAct === p;
    let badges = '';
    if (p === h.dealer) badges += '<span class="badge b-d">D</span>';
    if (p === S.session.bankId) badges += '<span class="badge b-b">BANK</span>';
    if (p === S.me.id) badges += '<span class="badge b-me">YOU</span>';
    if (pl.offline) badges += '<span class="badge b-off">OFFLINE</span>';
    if (h.allin[p] && !h.folded[p]) badges += '<span class="badge b-ai">ALL-IN</span>';
    let meta = `Behind ${rs(h.behind[p])} · in pot ${rs(h.contrib[p])}`;
    if (h.game === 'allin' && h.start[p] < (S.session.stacks[p] || 0)) meta += ` · limit ${rs(h.start[p])}`;
    const last = [...h.log].reverse().find((e) => e.p === p && e.t !== 'dabba' && e.s === h.street);
    let status = '';
    if (h.folded[p]) status = 'Folded';
    else if (turn) status = '⏳ Thinking…';
    else if (last) status = { check: 'Check', call: 'Call', bet: 'Bet', raise: 'Raise', fold: 'Fold' }[last.t] || '';
    let cards = '';
    if (h.mode === 'online') {
      if (h.shown && h.shown[p]) cards = `<div class="row" style="gap:3px">${h.shown[p].cards.map((c) => cardHTML(c, 'sm')).join('')}</div>`;
      else if (!h.folded[p] && p !== S.me.id) cards = `<div class="row" style="gap:3px">${Array(E.GAMES[h.game].hole).fill(cardHTML('??', 'sm')).join('')}</div>`;
    }
    return `<div class="seat ${turn ? 'turn' : ''} ${h.folded[p] ? 'fold' : ''}">
      <div class="grow"><div class="nm">${esc(pl.name)}${badges}</div><div class="meta">${meta}</div></div>
      ${cards}
      <div><div class="bet">${h.roundBet[p] ? rs(h.roundBet[p]) : ''}</div><div class="small mute" style="text-align:right">${status}</div></div>
    </div>`;
  }

  function actionPanel(h) {
    const actor = actorPid();
    if (!actor) {
      return `<div class="card small mute" style="text-align:center">Waiting for <b style="color:var(--ink)">${esc(nm(h.toAct))}</b>…</div>`;
    }
    const o = E.options(h, actor);
    const key = h.no + ':' + h.v;
    if (S.ui.raiseFor !== key) { S.ui.raise = h.currentBet; S.ui.raiseFor = key; }
    const forWho = actor === S.me.id ? 'Your turn' : 'Acting for ' + esc(nm(actor));
    const theirs = actor !== S.me.id && h.mode === 'online' ? cardsOf(actor) : null;
    const r = S.ui.raise;
    const raiseOk = o.canRaise && r > h.currentBet && r <= o.maxTotal;
    const isAllIn = r === o.roundBet + o.behind;
    const word = h.currentBet === 0 ? 'Bet' : 'Raise to';
    return `<div class="act"><div class="card">
      ${theirs ? `<div class="mine" style="margin-bottom:6px">${theirs.map((c) => cardHTML(c, 'sm')).join('')}</div>` : ''}
      <div class="row" style="margin-bottom:8px"><b class="grow" style="color:var(--gold)">${forWho}</b>
        <span class="small mute">You have ${rs(o.behind)}${o.roundBet ? ' · in ' + rs(o.roundBet) : ''}${isFinite(o.cap) ? ' · round max ' + rs(o.cap) : ''}</span></div>
      ${o.canRaise ? `
      <div class="raiseto"><div><div class="small mute">${word}${r <= h.currentBet ? ' · tap chips' : ''}</div><div class="v">${rs(r)}</div></div>
        <div class="row"><button class="btn sm" data-act="rz" data-v="clear">Reset</button><button class="btn sm" data-act="rz" data-v="max">${h.game === 'allin' ? 'All-in' : 'Max'}</button></div></div>
      <div class="chips">${E.CHIPS.slice().reverse().map((c) => `<button class="chip c${c}" data-act="rz" data-v="${c}"><span>+${c}</span></button>`).join('')}</div>` : ''}
      <div class="btns">
        <button class="btn red" data-act="fold">Fold</button>
        ${o.canCheck ? `<button class="btn" data-act="check">Check</button>` : `<button class="btn" data-act="call">Call ${rs(o.callAmt)}${o.callAmt < o.toCall ? ' (all-in)' : ''}</button>`}
        ${o.canRaise ? `<button class="btn gold" style="grid-column:1/3" data-act="raise" ${raiseOk ? '' : 'disabled'}>${isAllIn ? 'ALL-IN ' + rs(r) : word + ' ' + rs(r)}</button>` : ''}
      </div></div></div>`;
  }

  function showdownPicker(h) {
    if (!isAdmin()) return `<div class="card small mute" style="text-align:center">Show your cards — the host picks the winner.</div>`;
    const contested = h.pots.map((p, i) => ({ ...p, i })).filter((p) => p.eligible.length > 1);
    return `<div class="act"><div class="card"><h3>Who won?</h3>
      ${contested.map((p) => `<div style="margin-bottom:10px"><div class="small mute">${h.pots.length > 1 ? (p.i === 0 ? 'Main pot' : 'Side pot ' + p.i) + ' · ' : ''}${rs(p.amt)} — tap winner (tap 2+ to split)</div>
        <div class="row wrapr" style="margin-top:6px">${p.eligible.map((pid) => {
          const on = (S.ui.potPick[p.i] || []).includes(pid);
          return `<button class="btn sm ${on ? 'gold' : ''}" data-act="pick" data-pot="${p.i}" data-v="${esc(pid)}">${esc(nm(pid))}</button>`;
        }).join('')}</div></div>`).join('')}
      <button class="btn gold full" data-act="resolve">Confirm winner</button></div></div>`;
  }

  function resultCard(h) {
    const res = h.result;
    const winners = Object.entries(res.delta).filter(([, d]) => d > 0).sort((a, b) => b[1] - a[1]);
    let shown = '';
    if (h.shown) {
      shown = `<div class="seats" style="margin-top:10px">` + Object.entries(h.shown).map(([p, v]) => `<div class="seat"><div class="grow"><div class="nm">${esc(nm(p))}</div><div class="meta">${esc(v.name)}</div></div><div class="row" style="gap:3px">${v.cards.map((c) => cardHTML(c, 'sm' + (v.best.includes(c) ? ' hl' : ''))).join('')}</div></div>`).join('') + `</div>`;
    }
    return `<div class="felt result"><div class="hinfo"><span>Hand #${h.no} result</span><span>${res.how === 'fold' ? 'Others folded' : 'Showdown'}</span></div>
      ${h.board && h.board.length ? `<div class="board">${boardHTML(h.board, h.game, '')}</div>` : '<div style="height:8px"></div>'}
      ${winners.map(([p, d]) => `<div class="w">🏆 ${esc(nm(p))} wins ${rs(res.payout[p])} <span class="small mute">(${sgn(d)})</span></div>`).join('')}
      ${shown}</div>`;
  }

  function setupCard() {
    const s = S.session, st = s.settings;
    let h = '';
    const dealerNext = nextDealer(s);
    const dName = dealerNext ? esc(nm(dealerNext)) : 'the dealer';
    if (canChooseGame()) {
      h += `<div class="card"><h3>Next hand${dealerNext ? ' · dealer ' + dName : ''}</h3>
        ${dealerNext === S.me.id ? '<div class="small" style="color:var(--gold);margin-bottom:6px">You\'re the dealer — choose the game.</div>' : ''}
        <label class="lb">Game</label>
        <div class="seg">${segBtn('game', 'allin', "All-in Hold'em", st.game)}${segBtn('game', 'limit', 'Limit · 3 cards', st.game)}</div>
        ${st.game === 'limit' ? `<label class="lb">Round limits (pre-flop / flop / turn / river)</label>
          <div class="seg">${segBtn('limitStructure', 'flat', '100·100·100·' + st.lastLimit, st.limitStructure)}${segBtn('limitStructure', 'rising', '100·200·300·400', st.limitStructure)}</div>
          ${st.limitStructure === 'flat' ? `<div class="seg" style="margin-top:6px">${segBtn('lastLimit', 300, 'Last round ₹300', st.lastLimit)}${segBtn('lastLimit', 400, 'Last round ₹400', st.lastLimit)}</div>` : ''}` : ''}
        <div class="small mute" style="margin:10px 0">Tonight: <b style="color:var(--ink)">${st.mode === 'online' ? 'online cards' : 'real cards'}</b>. Dealer puts ${rs(E.DABBA)} dabba. Dealer moves one seat each hand.</div>
        ${st.game === 'allin' && capsPending(s).length ? `<button class="btn full" disabled>Waiting for limits: ${esc(capsPending(s).map((p) => nm(p)).join(', '))}</button>` : `<button class="btn gold full" data-act="deal">Deal hand #${(s.handNo || 0) + 1}</button>`}</div>`;
    } else {
      h += `<div class="card empty">Waiting for <b style="color:var(--ink)">${dName}</b> (dealer) to choose and deal<br><span class="small">${esc(E.GAMES[st.game].label)} · ${st.mode === 'online' ? 'online cards' : 'real cards'}</span></div>`;
    }
    if (st.game === 'allin') {
      const N = (s.handNo || 0) + 1;
      const got = s.capRound && s.capRound.no === N ? s.capRound.caps : {};
      if (isPlayer() && seatsFor(s).includes(S.me.id)) {
        const mine = got[S.me.id];
        const last = (s.caps || {})[S.me.id] || 0;
        h += `<div class="card" style="${mine === undefined ? 'border-color:var(--gold)' : ''}"><h3>My all-in limit · hand #${N}</h3>
          ${mine === undefined ? `<div class="small" style="color:var(--gold)">Set your limit — the hand can't start until everyone has.</div>` : `<div class="small">Set: <b>${mine ? rs(mine) : 'No limit'}</b> — you can still change it.</div>`}
          <div class="small mute" style="margin-top:4px">You have ${rs(s.stacks[S.me.id] || 0)}. This is the most you'll risk this hand.</div>
          <div class="row" style="margin-top:8px"><input class="in grow" type="number" inputmode="numeric" step="10" min="0" placeholder="e.g. 2000" data-bind="cap" value="${esc(S.ui.cap != null ? S.ui.cap : (mine || ''))}">
          <button class="btn gold" data-act="setCap">Set</button></div>
          <div class="row" style="margin-top:6px"><button class="btn sm grow" data-act="capNone">No limit</button>${last ? `<button class="btn sm grow" data-act="capSame" data-v="${last}">Same as last (${rs(last)})</button>` : ''}</div></div>`;
      }
      const list = seatsFor(s);
      if (list.length) h += `<div class="card"><h3>Limits for hand #${N}</h3><div class="list">${list.map((p) => {
        const v = got[p]; const off = s.players[p].offline;
        return `<div class="li small"><div class="grow">${esc(nm(p))}</div><div>${v === undefined ? (off ? '<span class="mute">No limit (offline)</span>' : '<span style="color:var(--gold)">⏳ waiting</span>') : (v ? '<b>' + rs(v) + '</b>' : 'No limit')}</div></div>`;
      }).join('')}</div></div>`;
    }
    return h;
  }
  const segBtn = (k, v, l, cur) => `<button class="${String(cur) === String(v) ? 'on' : ''}" data-act="setting" data-k="${k}" data-v="${v}">${esc(l)}</button>`;

  function seatsPreview() {
    const s = S.session;
    const list = pids();
    if (!list.length) return '';
    return `<div class="card"><h3>At the table</h3><div class="list">${list.map((p) => {
      const pl = s.players[p];
      return `<div class="li"><div class="grow">${esc(pl.name)}${p === s.bankId ? '<span class="badge b-b">BANK</span>' : ''}${p === S.me.id ? '<span class="badge b-me">YOU</span>' : ''}${pl.out ? ' <span class="small mute">(sitting out)</span>' : ''}</div><div class="num">${rs(s.stacks[p] || 0)}</div></div>`;
    }).join('')}</div></div>`;
  }

  function playersView() {
    const s = S.session;
    let h = '';
    // Bank
    h += `<div class="card"><h3>Bank</h3>${s.bankId
      ? `<div class="row"><div class="grow"><b style="font-size:18px">🏦 ${esc(nm(s.bankId))}</b><div class="small mute">Lends chips to everyone tonight</div></div></div>`
      : (isAdmin() ? `<div class="small mute" style="margin-bottom:8px">Picked at random. Last night's bank can't be bank again.</div><button class="btn gold full" data-act="pickBank">🎲 Pick bank randomly</button>` : `<div class="mute">Not chosen yet</div>`)}</div>`;
    // Requests
    const reqs = Object.entries(s.requests || {});
    if (isAdmin() && reqs.length) {
      h += `<div class="card"><h3>Want to join</h3><div class="list">${reqs.map(([uid, r]) => `<div class="li"><div class="grow">${esc(r.name)}</div><button class="btn sm" data-act="approve" data-v="${esc(uid)}" data-yes="0">Ignore</button><button class="btn sm gold" data-act="approve" data-v="${esc(uid)}" data-yes="1">Add</button></div>`).join('')}</div></div>`;
    }
    // Players
    const canBank = isAdmin() || isBank();
    h += `<div class="card"><h3>Players</h3><div class="list">${pids().map((p) => {
      const pl = s.players[p];
      const btns = [];
      if (canBank) btns.push(`<button class="btn sm" data-act="modal" data-m="give" data-v="${esc(p)}">+ Chips</button>`);
      if (p !== S.me.id && isPlayer()) btns.push(`<button class="btn sm" data-act="modal" data-m="lend" data-v="${esc(p)}">Lend</button>`);
      if (p === S.me.id || isAdmin()) btns.push(`<button class="btn sm ghost" data-act="out" data-v="${esc(p)}">${pl.out ? 'Sit in' : 'Sit out'}</button>`);
      return `<div class="li" style="flex-wrap:wrap"><div class="grow"><div><b>${esc(pl.name)}</b>${p === s.bankId ? '<span class="badge b-b">BANK</span>' : ''}${p === S.me.id ? '<span class="badge b-me">YOU</span>' : ''}${pl.offline ? '<span class="badge b-off">OFFLINE</span>' : ''}</div>
        <div class="small mute">Chips ${rs(s.stacks[p] || 0)} · from bank ${rs((s.issued || {})[p] || 0)}${pl.out ? ' · sitting out' : ''}</div></div>
        <div class="row" style="gap:4px">${btns.join('')}</div></div>`;
    }).join('')}</div>
    ${isAdmin() ? `<label class="lb">Add a player without a phone (you'll play their moves)</label><div class="row"><input class="in grow" data-bind="offName" placeholder="Name" value="${esc(S.ui.offName)}"><button class="btn" data-act="addOffline">Add</button></div>` : ''}
    </div>`;
    // Loans
    const open = E.openLoans(s.loans);
    h += `<div class="card"><h3>Loans between players</h3>${open.length ? `<div class="list">${open.map((l) => `<div class="li"><div class="grow">${esc(nm(l.borrower))} owes ${esc(nm(l.lender))}</div><div class="num">${rs(l.amt)}</div>${l.borrower === S.me.id || isAdmin() ? `<button class="btn sm" data-act="repay" data-from="${esc(l.borrower)}" data-to="${esc(l.lender)}" data-v="${l.amt}">Repay</button>` : ''}</div>`).join('')}</div>` : '<div class="small mute">No loans</div>'}</div>`;
    // Money log
    const log = (s.moneyLog || []).slice(-12).reverse();
    if (log.length) {
      h += `<div class="card"><h3>Recent money moves</h3><div class="list">${log.map((e) => {
        let t = '';
        if (e.t === 'issue') t = `🏦 Bank → ${esc(nm(e.p))} <b>${rs(e.a)}</b>`;
        else if (e.t === 'loan') t = `${esc(nm(e.from))} lent ${esc(nm(e.to))} <b>${rs(e.a)}</b>`;
        else if (e.t === 'repay') t = `${esc(nm(e.from))} repaid ${esc(nm(e.to))} <b>${rs(e.a)}</b>`;
        else if (e.t === 'bank') t = `🎲 ${esc(nm(e.p))} picked as bank`;
        return `<div class="li small"><div class="grow">${t}</div><div class="mute">${new Date(e.ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</div></div>`;
      }).join('')}</div></div>`;
    }
    return h;
  }

  function handsView() {
    if (!S.history.length) return `<div class="card empty">No hands played yet</div>`;
    return `<div class="card"><h3>Hand history</h3><div class="list">${S.history.map((r) => {
      const ws = Object.entries(r.delta).filter(([, d]) => d > 0);
      const name = (p) => (r.names && r.names[p]) || nm(p);
      return `<div class="li" style="flex-wrap:wrap"><div class="grow"><div><b>#${r.no}</b> <span class="small mute">${esc(E.GAMES[r.game].short)} · ${r.how === 'fold' ? 'won uncontested' : 'showdown'}</span></div>
        <div class="small">${ws.map(([p, d]) => `🏆 ${esc(name(p))} <span class="pos">${sgn(d)}</span>`).join(' · ')}</div>
        <div class="small mute">${Object.entries(r.delta).filter(([, d]) => d < 0).map(([p, d]) => `${esc(name(p))} <span class="neg">${sgn(d)}</span>`).join(' · ')}</div></div>
        ${r.board && r.board.length ? `<div class="row" style="gap:2px">${boardHTML(r.board, r.game, 'sm')}</div>` : ''}</div>`;
    }).join('')}</div></div>`;
  }

  function chatView() {
    const msgs = S.chat.map((m) => `<div class="msg ${m.by === S.me.id ? 'me' : ''}">${m.by !== S.me.id ? `<div class="w">${esc(m.name)}</div>` : ''}${m.audio
      ? `<audio controls preload="none" src="${esc(m.audio)}" style="max-width:220px;height:36px"></audio><div class="small mute">🎙 ${m.dur || ''}s</div>`
      : esc(m.text)}</div>`).join('');
    const canVoice = S.store.voiceNotes && navigator.mediaDevices && window.MediaRecorder;
    const recBtn = canVoice ? `<button class="btn mic ${rec ? 'on' : ''}" data-act="rec" title="Voice note">${rec ? '■ ' + Math.round((Date.now() - recStart) / 1000) + 's' : '🎙'}</button>` : '';
    const d = S.store.dictation;
    const mic = d ? `<button class="btn mic ${dictState !== 'idle' ? 'on' : ''}" data-act="mic" title="Voice">${dictState !== 'idle' ? '■' : '🎤'}</button>` : '';
    return `<div class="card" style="padding:10px"><div class="msgs">${msgs || '<div class="msg sys">Say hi 👋</div>'}</div>
      ${S.ui.partial ? `<div class="small mute">🎤 ${esc(S.ui.partial)}</div>` : ''}
      ${rec ? '<div class="small" style="color:var(--red)">● Recording… tap ■ to send (max 30s)</div>' : ''}
      <div class="composer">${recBtn}${mic}<input class="in grow" data-bind="chat" placeholder="Message…" value="${esc(S.ui.chat)}" enterkeyhint="send"><button class="btn gold" data-act="send">Send</button></div>
      <div class="small mute">${canVoice ? 'Tap 🎙 to record a voice note, tap again to send.' : 'Tip: tap the 🎤 on your phone keyboard to speak your message.'}</div></div>`;
  }

  function finalTable(rows, players) {
    const name = (p) => (players && players[p] && players[p].name) || nm(p);
    return `<table class="t"><tr><th>Player</th><th>Chips</th><th>Bank</th><th>Loans</th><th>Net</th></tr>${Object.entries(rows).map(([p, r]) =>
      `<tr><td>${esc(name(p))}</td><td>${rs(r.stack)}</td><td>−${rs(r.issued)}</td><td>${sgn(r.lent - r.borrowed)}</td><td class="${r.net > 0 ? 'pos' : r.net < 0 ? 'neg' : ''}"><b>${sgn(r.net)}</b></td></tr>`).join('')}</table>`;
  }

  function settleView() {
    const s = S.session;
    const rows = E.ledger(s, pids());
    const pays = E.settleUp(rows);
    let h = `<div class="card"><h3>Where everyone stands</h3>${finalTable(rows, s.players)}
      <div class="small mute" style="margin-top:8px">Net = chips now − taken from bank − borrowed + lent.</div></div>`;
    h += `<div class="card"><h3>If we stopped now</h3>${pays.length ? `<div class="list">${pays.map((p) => `<div class="li"><div class="grow">${esc(nm(p.from))} pays <b>${esc(nm(p.to))}</b></div><div class="num">${rs(p.amt)}</div></div>`).join('')}</div>` : '<div class="small mute">Everyone is square</div>'}</div>`;
    if (isAdmin()) h += `<button class="btn red full" data-act="modal" data-m="end">End the night</button>`;
    return h;
  }

  function modalView() {
    const m = S.ui.modal;
    if (!m) return '';
    let inner = '';
    const amtPicker = () => `<div class="raiseto" style="margin:10px 0"><div class="v">${rs(S.ui.amt)}</div><button class="btn sm" data-act="amt" data-v="clear">Reset</button></div>
      <div class="row wrapr">${[100, 500, 1000, 2000, 5000].map((a) => `<button class="btn sm" data-act="amt" data-v="${a}">+${a}</button>`).join('')}</div>
      <div class="chips">${E.CHIPS.slice().reverse().map((c) => `<button class="chip c${c}" data-act="amt" data-v="${c}"><span>+${c}</span></button>`).join('')}</div>`;
    if (m.type === 'give') {
      inner = `<h2>🏦 Bank gives chips to ${esc(nm(m.pid))}</h2><div class="small mute">${esc(nm(m.pid))} will owe the bank this amount.</div>${amtPicker()}
        <button class="btn gold full" data-act="doGive">Give ${rs(S.ui.amt)}</button>`;
    } else if (m.type === 'lend') {
      inner = `<h2>Lend to ${esc(nm(m.pid))}</h2><div class="small mute">From your chips (${rs(S.session.stacks[S.me.id] || 0)}). ${esc(nm(m.pid))} will owe you.</div>${amtPicker()}
        <button class="btn gold full" data-act="doLend">Lend ${rs(S.ui.amt)}</button>`;
    } else if (m.type === 'end') {
      inner = `<h2>End the night?</h2><div class="small mute" style="margin-bottom:12px">Final balances get saved and the table closes. This can't be undone.</div>
        <button class="btn red full" data-act="doEnd">Yes, end and save results</button>`;
    }
    return `<div class="modal" data-act="closeModal"><div class="sheet" data-stop="1">${inner}<div style="height:8px"></div><button class="btn ghost full" data-act="closeModal">Cancel</button></div></div>`;
  }

  /* ---------- events ---------- */
  document.addEventListener('input', (e) => {
    const k = e.target.dataset && e.target.dataset.bind;
    if (k) S.ui[k] = e.target.value;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.dataset && e.target.dataset.bind === 'chat') { e.preventDefault(); run(sendChat); }
  });
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    if (el.dataset.act === 'closeModal' && e.target.closest('[data-stop]') && !e.target.closest('button')) return;
    const a = el.dataset.act, v = el.dataset.v;
    const h = S.hand;
    switch (a) {
      case 'mic': toggleMic(); return; // must run synchronously in the click
      case 'rec': return run(toggleRecord);
      case 'tab': S.tab = v; render(); window.scrollTo(0, 0); return;
      case 'startNight': return run(startNight);
      case 'newMode': S.ui.newMode = v; render(); return;
      case 'join': return run(requestJoin);
      case 'approve': return run(() => approve(v, el.dataset.yes === '1'));
      case 'addOffline': return run(addOffline);
      case 'out': return run(() => toggleOut(v));
      case 'pickBank': return run(pickBank);
      case 'setCap': return run(async () => { await setCap(S.ui.cap); S.ui.cap = null; });
      case 'capNone': return run(async () => { await setCap(0); S.ui.cap = null; });
      case 'capSame': return run(async () => { await setCap(Number(v)); S.ui.cap = null; });
      case 'setting': if (el.dataset.k === 'mode') return; return run(() => saveSettings({ [el.dataset.k]: el.dataset.k === 'lastLimit' ? Number(v) : v }));
      case 'deal': return run(dealHand);
      case 'rz': {
        const o = E.options(h, actorPid());
        if (!o) return;
        if (v === 'clear') S.ui.raise = h.currentBet;
        else if (v === 'max') S.ui.raise = o.maxTotal;
        else {
          const base = S.ui.raise <= h.currentBet ? h.currentBet : S.ui.raise;
          S.ui.raise = Math.min(o.maxTotal, base + Number(v));
        }
        render(); return;
      }
      case 'fold': return run(() => handAction((x) => E.act(x, actorPid(), { type: 'fold' })));
      case 'check': return run(() => handAction((x) => E.act(x, actorPid(), { type: 'check' })));
      case 'call': return run(() => handAction((x) => E.act(x, actorPid(), { type: 'call' })));
      case 'raise': { const t = S.ui.raise; return run(() => handAction((x) => E.act(x, actorPid(), { type: 'raise', total: t }))); }
      case 'change': {
        const who = E.canChange(h, S.me.id) ? S.me.id : h.lastActor;
        return run(() => handAction((x) => E.changeBet(x, who)));
      }
      case 'pick': {
        const i = Number(el.dataset.pot);
        const cur = S.ui.potPick[i] || [];
        S.ui.potPick[i] = cur.includes(v) ? cur.filter((x) => x !== v) : cur.concat(v);
        render(); return;
      }
      case 'resolve': {
        const picks = h.pots.map((_, i) => S.ui.potPick[i] || []);
        return run(async () => { await handAction((x) => E.resolveShowdown(x, picks)); S.ui.potPick = {}; });
      }
      case 'repay': return run(() => lend(el.dataset.from, el.dataset.to, Number(v), 'repay'));
      case 'modal': S.ui.modal = { type: el.dataset.m, pid: v }; S.ui.amt = 0; render(); return;
      case 'closeModal': S.ui.modal = null; render(); return;
      case 'amt': S.ui.amt = v === 'clear' ? 0 : S.ui.amt + Number(v); render(); return;
      case 'doGive': return run(async () => { await giveChips(S.ui.modal.pid, S.ui.amt); S.ui.modal = null; render(); });
      case 'doLend': return run(async () => { await lend(S.me.id, S.ui.modal.pid, S.ui.amt); S.ui.modal = null; render(); });
      case 'doEnd': return run(async () => { await endNight(); S.ui.modal = null; S.tab = 'table'; render(); });
      case 'send': return run(sendChat);
      case 'viewNight': S.ui.viewNight = S.ui.viewNight === v ? null : v; render(); return;
    }
  });

  /* ---------- boot ---------- */
  (async function boot() {
    render();
    S.store = await window.PokerStore.createStore();
    S.me = S.store.me;
    S.ready = true;
    if (S.store.kind === 'blocked') {
      $app.innerHTML = `<div class="top"><div class="brand">♠ Poker <b>Night</b></div></div><div class="wrap"><div class="card"><h3>Can't reach the table</h3>
        <p>This page couldn't connect to the shared game.</p>
        ${window.FIREBASE_CONFIG ? `<ol class="small" style="padding-left:18px;line-height:1.7"><li>Check your internet connection.</li><li>Open the link in Chrome or Safari, not inside WhatsApp or another app.</li><li>Close and open the link again.</li></ol>` : `<ol class="small" style="padding-left:18px;line-height:1.7"><li>Make sure you're signed in to Claude with the email the host invited.</li><li>Ask the host to check your access is <b>Editor</b>.</li><li>Open the link in Chrome or Safari, not inside another app.</li><li>Close and open the link again.</li></ol>`}
        <div class="small mute">Code: ${esc(S.store.reason)}</div></div></div>`;
      return;
    }
    setupDictation();
    S.store.onDoc('config/main', (c) => {
      S.config = c;
      const sid = c && c.activeSessionId;
      if (sid !== S.sid) subscribeSession(sid);
      else render();
    }, onErr);
    S.store.onQuery('sessions', { orderBy: 'createdAt', dir: 'desc', limit: 20 }, (rows) => { S.nights = rows; render(); }, onErr);
    render();
  })();
})();
