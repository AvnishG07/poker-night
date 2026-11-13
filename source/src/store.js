/* ============================================================
   STORE ADAPTER — the ONLY part that knows where data lives.
   To move to your own hosting (e.g. Firebase), write one more
   create…Store() returning the same shape. Nothing else changes.

   Shape:
     kind, me:{id,name}, isOwner, canWrite, dictation|null
     get(path) → data|null          set(path,data)      add(colPath,data)
     onDoc(path, fn(data|null), err) → unsubscribe
     onQuery(colPath, {orderBy,dir,limit}, fn([{id,...data}]), err) → unsubscribe
     lock(path, async fn)  — run fn with a short exclusive lease
   ============================================================ */
(function (root) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const plain = (o) => JSON.parse(JSON.stringify(o));

  async function createClaudeStore() {
    const [db, user] = await Promise.all([root.claude.use('db'), root.claude.use('user')]);
    if (!db) return { kind: 'blocked', reason: 'no_db', me: { id: 'anon', name: '' } };
    let id = null, name = '', isOwner = false, canWrite = null;
    try { id = user ? await user.id() : null; } catch (e) {}
    try { isOwner = !!(user && (await user.isOwner())); } catch (e) {}
    try { canWrite = user ? await user.can('data.write') : null; } catch (e) {}
    try { if (user && id) { const ps = await user.profiles([id]); name = (ps[id] && ps[id].name) || ''; } } catch (e) {}
    // Voice typing loads in the background; it never holds up the table.
    const dictationReady = root.claude.use('dictation').catch(() => null);

    return {
      kind: 'claude',
      me: { id: id || 'anon', name },
      isOwner, canWrite, dictation: null, dictationReady,
      async get(p) { const s = await db.doc(p).get(); return s.exists ? s.data() : null; },
      set: (p, d) => db.doc(p).set(plain(d)),
      add: (c, d) => db.collection(c).add(plain(d)),
      onDoc(p, fn, err) { return db.doc(p).onSnapshot((s) => fn(s.exists ? s.data() : null), err); },
      onQuery(c, q, fn, err) {
        let ref = db.collection(c);
        if (q.orderBy) ref = ref.orderBy(q.orderBy, q.dir || 'asc');
        if (q.limit) ref = ref.limit(q.limit);
        return ref.onSnapshot((s) => fn(s.docs.map((d) => ({ id: d.id, ...d.data() }))), err);
      },
      async lock(p, fn) {
        for (let i = 0; i < 6; i++) {
          let r;
          try { r = await db.doc(p).acquire({ holder: id || 'anon', ttlMs: 1500 }); }
          catch (e) { return fn(); } // leases unavailable: just run
          if (r.acquired) return fn();
          await sleep(400 + Math.random() * 500);
        }
        throw new Error('The table is busy — try again');
      },
    };
  }

  /* In-memory store: used when the page opens without shared storage
     (preview). Everything stays on this one device. */
  function createMemoryStore() {
    const KEY = 'poker-preview-v1';
    let data = {};
    try { data = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) {}
    const docL = {}, qL = [];
    const save = () => { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) {} };
    const fire = (p) => {
      (docL[p] || []).forEach((fn) => fn(data[p] ? plain(data[p]) : null));
      const col = p.split('/').slice(0, -1).join('/');
      qL.filter((l) => l.c === col).forEach(runQ);
    };
    function runQ(l) {
      let rows = Object.keys(data)
        .filter((k) => k.startsWith(l.c + '/') && k.split('/').length === l.c.split('/').length + 1)
        .map((k) => ({ id: k.split('/').pop(), ...plain(data[k]) }));
      if (l.q.orderBy) rows.sort((a, b) => ((a[l.q.orderBy] > b[l.q.orderBy]) - (a[l.q.orderBy] < b[l.q.orderBy])) * (l.q.dir === 'desc' ? -1 : 1));
      if (l.q.limit) rows = rows.slice(0, l.q.limit);
      setTimeout(() => l.fn(rows), 0);
    }
    return {
      kind: 'memory', splitSecrets: /split/.test(root.location ? root.location.hash : ''), voiceNotes: true,
      me: { id: 'me', name: 'You' },
      isOwner: true, canWrite: true, dictation: null,
      async get(p) { return data[p] ? plain(data[p]) : null; },
      async set(p, d) { data[p] = plain(d); save(); fire(p); },
      async add(c, d) { const id = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); data[c + '/' + id] = plain(d); save(); fire(c + '/' + id); },
      onDoc(p, fn) { (docL[p] = docL[p] || []).push(fn); setTimeout(() => fn(data[p] ? plain(data[p]) : null), 0); return () => { docL[p] = docL[p].filter((f) => f !== fn); }; },
      onQuery(c, q, fn) { const l = { c, q, fn }; qL.push(l); runQ(l); return () => { const i = qL.indexOf(l); if (i >= 0) qL.splice(i, 1); }; },
      async lock(p, fn) { return fn(); },
      reset() { data = {}; save(); location.reload(); },
    };
  }


  /* Firebase (your own hosting). Friends join with just a name. */
  async function createFirebaseStore(cfg) {
    const fb = root.firebase;
    if (!fb.apps.length) fb.initializeApp(cfg);
    const auth = fb.auth();
    const fs = fb.firestore();
    const user = await new Promise((resolve, reject) => {
      const off = auth.onAuthStateChanged((u) => {
        if (u) { off(); resolve(u); }
        else auth.signInAnonymously().catch((e) => { off(); reject(e); });
      });
    });
    let name = '';
    try { name = localStorage.getItem('poker-nick') || ''; } catch (e) {}
    return {
      kind: 'firebase', splitSecrets: true,
      me: { id: user.uid, name },
      isOwner: false, canWrite: true, dictation: null, voiceNotes: true,
      async get(p) { const d = await fs.doc(p).get(); return d.exists ? d.data() : null; },
      set: (p, d) => fs.doc(p).set(plain(d)),
      add: (c, d) => fs.collection(c).add(plain(d)),
      onDoc(p, fn, err) { return fs.doc(p).onSnapshot((d) => fn(d.exists ? d.data() : null), err); },
      onQuery(c, q, fn, err) {
        let ref = fs.collection(c);
        if (q.orderBy) ref = ref.orderBy(q.orderBy, q.dir || 'asc');
        if (q.limit) ref = ref.limit(q.limit);
        return ref.onSnapshot((snap) => fn(snap.docs.map((d) => ({ id: d.id, ...d.data() }))), err);
      },
      async lock(p, fn) { return fn(); },
      // Safe read-change-write: Firestore retries if two phones write at once.
      mutate(p, fn) {
        return fs.runTransaction(async (tx) => {
          const ref = fs.doc(p);
          const snap = await tx.get(ref);
          const cur = snap.exists ? snap.data() : null;
          const draft = cur ? JSON.parse(JSON.stringify(cur)) : null;
          const r = await fn(draft);
          if (r === false) return undefined;
          const out = r && r !== true ? r : draft;
          tx.set(ref, plain(out));
          return out;
        });
      },
      setName(n) { try { localStorage.setItem('poker-nick', n); } catch (e) {} },
    };
  }

  async function createStore() {
    if (root.FIREBASE_CONFIG && root.firebase) {
      try { return await createFirebaseStore(root.FIREBASE_CONFIG); }
      catch (e) { return { kind: 'blocked', reason: (e && (e.code || e.message)) || 'firebase', me: { id: 'anon', name: '' } }; }
    }
    // Inside Claude: always use shared storage. Never fall back to a private copy.
    if (root.claude && typeof root.claude.use === 'function') {
      try { return await createClaudeStore(); }
      catch (e) { return { kind: 'blocked', reason: (e && (e.code || e.message)) || 'error', me: { id: 'anon', name: '' } }; }
    }
    return createMemoryStore(); // opened as a plain file: practice mode
  }

  root.PokerStore = { createStore, createClaudeStore, createMemoryStore, createFirebaseStore };
})(typeof globalThis !== 'undefined' ? globalThis : this);
