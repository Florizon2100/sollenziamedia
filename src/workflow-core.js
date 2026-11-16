/* ─────────────────────────────────────────────────────────────
   Sollenzia — workflow core
   Règles du tableau, partagées à l'identique par l'API Railway
   (src/workflow.js) et par la page workflow.html (mode démo).
   Ne dépend de rien : ni Node, ni navigateur.
   ───────────────────────────────────────────────────────────── */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SollenziaWorkflow = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const COLS  = ['inspo', 'review', 'ready'];
  const PLATS = ['instagram', 'tiktok', 'youtube', 'facebook'];
  const MAX_CARDS = 500;
  const MAX_MESSAGES = 300;

  const str = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, n);
  const link = v => {
    const s = str(v, 800);
    if (/^https?:\/\//i.test(s)) return s;
    if (/^[\w\-./]+$/.test(s) && !s.includes('..')) return s; // fichier sur le site (démo)
    return '';
  };
  const newId = () => 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  function fail(status, message) { const e = new Error(message); e.status = status; throw e; }

  /* Qui a le droit de quoi */
  function canMove(card, to, role) {
    if (!card || !COLS.includes(to)) return false;
    if (role === 'editor') return true;
    if (card.col === to) return true;                         // réordonner
    if (card.col === 'review' && to === 'ready') return true; // approuver
    if (card.col === 'ready' && to === 'review') return true; // rouvrir
    return false;
  }
  function canDelete(card, role) { return !!card && (role === 'editor' || card.col === 'inspo'); }

  function cleanPlatforms(list, allowed) {
    const ok = (allowed && allowed.length ? allowed : ['instagram']);
    const p = (Array.isArray(list) ? list : []).filter(x => ok.includes(x));
    return p.length ? [...new Set(p)] : [ok[0]];
  }

  /**
   * Applique une action au tableau.
   * board  : { cards: [] }   (modifié sur place)
   * action : { type: 'add'|'comment'|'move'|'delete', ... }
   * role   : 'editor' | 'client'   (décidé par le serveur, jamais par la page)
   * opts   : { platforms: [...], now }
   * Retour : { board, events: [{ kind, cardId, text }] }  → events = notifications Discord
   */
  function apply(board, action, role, opts = {}) {
    const now = opts.now || Date.now();
    const by = role === 'editor' ? 'editor' : 'client';
    const isEd = by === 'editor';
    board.cards = Array.isArray(board.cards) ? board.cards : [];
    const cards = board.cards;
    const events = [];
    const a = action || {};
    const get = id => cards.find(c => c.id === id) || fail(404, 'This card no longer exists. It may have been deleted.');
    const say = (c, text, system) => {
      c.feedback = Array.isArray(c.feedback) ? c.feedback : [];
      c.feedback.push(system ? { by, text, ts: now, system: true } : { by, text, ts: now });
      if (c.feedback.length > MAX_MESSAGES) c.feedback.splice(0, c.feedback.length - MAX_MESSAGES);
    };
    const place = (c, col, index) => {
      const i = cards.indexOf(c);
      if (i > -1) cards.splice(i, 1);
      const inCol = cards.filter(x => x.col === col);
      const n = Math.max(0, Math.min(Number.isInteger(index) ? index : 0, inCol.length));
      const before = inCol[n];
      cards.splice(before ? cards.indexOf(before) : (inCol.length ? cards.indexOf(inCol[inCol.length - 1]) + 1 : cards.length), 0, c);
    };

    switch (a.type) {
      case 'add': {
        if (cards.length >= MAX_CARDS) fail(400, 'This board is full. Delete a few old cards first.');
        const d = a.card || {};
        const col = isEd && COLS.includes(d.col) ? d.col : 'inspo';
        const title = str(d.title, 140);
        if (!title) fail(400, 'A title is required.');
        const c = { id: newId(), col, title, by, platforms: cleanPlatforms(d.platforms, opts.platforms), createdAt: now, feedback: [] };
        const cat = str(d.cat, 24); if (cat) c.cat = cat;
        const note = str(d.note, 4000);
        if (col === 'inspo') { c.link = link(d.link); c.note = note; }
        else {
          Object.assign(c, { video: link(d.video || d.link), version: 1, hook: str(d.hook, 200), caption: str(d.caption, 2200), tags: str(d.tags, 500), notes: [] });
          if (note) { c.notes.unshift({ text: note, ts: now }); say(c, note); }
          if (col === 'review') c.status = 'awaiting';
          if (col === 'ready') { c.master = link(d.master) || c.video; c.approvedAt = now; c.status = 'approved'; }
        }
        place(c, col, 0);
        if (col === 'inspo') events.push({ kind: 'idea', cardId: c.id });
        if (col === 'review') events.push({ kind: 'cut', cardId: c.id, text: note });
        return { board, events, card: c };
      }

      case 'comment': {
        const c = get(a.id);
        const text = str(a.text, 4000);
        const cut = isEd && c.col !== 'inspo' ? link(a.cut) : '';
        if (!text && !cut) fail(400, 'Write a message first.');
        if (cut) {
          c.video = cut;
          c.version = (c.version || 1) + 1;
          if (c.col === 'ready') c.master = cut; else c.status = 'awaiting';
        }
        const msg = text || `V${c.version} uploaded.`;
        say(c, msg);
        if (isEd && c.col !== 'inspo') { c.notes = Array.isArray(c.notes) ? c.notes : []; c.notes.unshift({ text: msg, ts: now }); c.notes.length = Math.min(c.notes.length, 50); }
        if (cut) events.push({ kind: 'cut', cardId: c.id, text: msg });
        if (!isEd && c.col === 'review') { c.status = 'changes'; events.push({ kind: 'revision', cardId: c.id, text: msg }); }
        if (!isEd && c.col === 'ready') {
          c.col = 'review'; c.status = 'changes';
          say(c, 'Reopened for changes.', true);
          place(c, 'review', 0);
          events.push({ kind: 'revision', cardId: c.id, text: msg });
        }
        if (!isEd && c.col === 'inspo') events.push({ kind: 'comment', cardId: c.id, text: msg });
        return { board, events, card: c };
      }

      case 'move': {
        const c = get(a.id);
        const to = a.to;
        if (!canMove(c, to, by)) fail(403, 'Only your Sollenzia editor can move this card there.');
        const from = c.col;
        if (from !== to) {
          c.col = to;
          if (to === 'ready') {
            c.approvedAt = now; c.status = 'approved';
            say(c, `Approved V${c.version || 1}.`, true);
            events.push({ kind: 'approved', cardId: c.id });
          } else if (to === 'review') {
            c.version = c.version || 1;
            c.notes = Array.isArray(c.notes) ? c.notes : [];
            if (from === 'ready') { c.status = 'changes'; say(c, 'Reopened for changes.', true); events.push({ kind: 'reopen', cardId: c.id }); }
            else { c.status = 'awaiting'; say(c, 'Moved to review.', true); events.push({ kind: 'cut', cardId: c.id }); }
          } else {
            say(c, 'Moved back to ideas.', true);
          }
        }
        place(c, to, Number.isInteger(a.index) ? a.index : (from === to ? cards.filter(x => x.col === to).indexOf(c) : 0));
        return { board, events, card: c };
      }

      case 'delete': {
        const c = get(a.id);
        if (!canDelete(c, by)) fail(403, 'Only your Sollenzia editor can delete videos.');
        cards.splice(cards.indexOf(c), 1);
        if (c.col === 'inspo') events.push({ kind: 'idea_deleted', cardId: c.id });
        return { board, events, card: c };
      }

      default:
        fail(400, 'Unknown action.');
    }
  }

  return { COLS, PLATS, apply, canMove, canDelete, cleanPlatforms };
});
