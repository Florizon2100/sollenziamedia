/* ─────────────────────────────────────────────────────────────
   Sollenzia — workflow core
   Règles du tableau, partagées à l'identique par l'API Railway
   (src/workflow.js) et par la page workflow.html (mode démo).

   3 rôles (décidés par le serveur, jamais par la page) :
     owner  → toi (clé API) : tout
     editor → un monteur (lien perso) : idées, vidéos en review, nouvelles versions, messages.
              Ne supprime rien, n'approuve pas, ne touche pas aux vidéos validées.
     client → idées, retours, supprime ses idées, approuve (→ Ready), marque "posté".
   Colonnes : inspo → review → ready → posted (liste repliable en bas)
   ───────────────────────────────────────────────────────────── */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SollenziaWorkflow = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const COLS  = ['inspo', 'review', 'ready', 'posted'];
  const PLATS = ['instagram', 'tiktok', 'youtube', 'facebook'];
  const ROLES = ['owner', 'editor', 'client'];
  const MAX_CARDS = 1000;
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
  const roleOf = r => (ROLES.includes(r) ? r : 'client');

  /* ── Qui a le droit de quoi ── */
  function canMove(card, to, role) {
    role = roleOf(role);
    if (!card || !COLS.includes(to)) return false;
    if (role === 'owner') return true;
    const from = card.col;
    if (role === 'editor') {
      // le monteur travaille sur idées + review, jamais sur ce que le client a validé
      return ['inspo', 'review'].includes(from) && ['inspo', 'review'].includes(to);
    }
    // client
    if (from === to) return from !== 'posted';
    return (from === 'review' && to === 'ready')    // approuver
        || (from === 'ready' && to === 'review')    // rouvrir
        || (from === 'ready' && to === 'posted')    // marquer posté
        || (from === 'posted' && to === 'ready');   // annuler "posté"
  }
  function canDelete(card, role) {
    role = roleOf(role);
    if (!card) return false;
    if (role === 'owner') return true;
    if (role === 'client') return card.col === 'inspo';
    return false;
  }
  function canAddTo(col, role) {
    role = roleOf(role);
    if (role === 'owner') return ['inspo', 'review', 'ready'].includes(col);
    if (role === 'editor') return ['inspo', 'review'].includes(col);
    return col === 'inspo';
  }
  function canUploadCut(card, role) {
    role = roleOf(role);
    if (!card || card.col === 'inspo') return false;
    if (role === 'owner') return true;
    return role === 'editor' && card.col === 'review';
  }

  function cleanPlatforms(list, allowed) {
    const ok = (allowed && allowed.length ? allowed : ['instagram']);
    const p = (Array.isArray(list) ? list : []).filter(x => ok.includes(x));
    return p.length ? [...new Set(p)] : [ok[0]];
  }

  /**
   * Applique une action au tableau.
   * board  : { cards: [] }   (modifié sur place)
   * action : { type: 'add'|'comment'|'move'|'delete', ... }
   * role   : 'owner' | 'editor' | 'client'
   * opts   : { platforms: [...], name: 'Lucas', now }
   * Retour : { board, events: [{ kind, cardId, text }], card }  → events = notifications Discord
   */
  function apply(board, action, role, opts = {}) {
    role = roleOf(role);
    const now = opts.now || Date.now();
    const by = role === 'client' ? 'client' : 'editor';      // côté "équipe" ou "client" dans les messages
    const name = by === 'editor' ? str(opts.name, 60) || 'Sollenzia' : undefined;
    board.cards = Array.isArray(board.cards) ? board.cards : [];
    const cards = board.cards;
    const events = [];
    const a = action || {};
    const get = id => cards.find(c => c.id === id) || fail(404, 'This card no longer exists. It may have been deleted.');
    const stamp = o => (name ? Object.assign(o, { name }) : o);
    const say = (c, text, system) => {
      c.feedback = Array.isArray(c.feedback) ? c.feedback : [];
      c.feedback.push(stamp(system ? { by, text, ts: now, system: true } : { by, text, ts: now }));
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
        const col = canAddTo(d.col, role) ? d.col : 'inspo';
        const title = str(d.title, 140);
        if (!title) fail(400, 'A title is required.');
        const c = stamp({ id: newId(), col, title, by, platforms: cleanPlatforms(d.platforms, opts.platforms), createdAt: now, feedback: [] });
        const cat = str(d.cat, 24); if (cat) c.cat = cat;
        const note = str(d.note, 4000);
        if (col === 'inspo') { c.link = link(d.link); c.note = note; }
        else {
          Object.assign(c, { video: link(d.video || d.link), version: 1, hook: str(d.hook, 200), caption: str(d.caption, 2200), tags: str(d.tags, 500), notes: [] });
          if (note) { c.notes.unshift(stamp({ text: note, ts: now })); say(c, note); }
          if (col === 'review') c.status = 'awaiting';
          if (col === 'ready') { c.master = link(d.master) || c.video; c.approvedAt = now; c.status = 'approved'; }
        }
        place(c, col, 0);
        if (col === 'inspo') events.push({ kind: 'idea', cardId: c.id });
        if (col === 'review' && c.video) events.push({ kind: 'cut', cardId: c.id, text: note });
        return { board, events, card: c };
      }

      case 'comment': {
        const c = get(a.id);
        const text = str(a.text, 4000);
        const cut = canUploadCut(c, role) ? link(a.cut) : '';
        if (!text && !cut) fail(400, 'Write a message first.');
        const firstVideo = !!cut && !c.video;
        if (cut) {
          c.version = firstVideo ? (c.version || 1) : (c.version || 1) + 1;   // 1er lien = V1, les suivants = V2, V3…
          c.video = cut;
          if (c.col === 'ready') c.master = cut; else c.status = 'awaiting';
        }
        const msg = text || (firstVideo ? 'Video uploaded.' : `V${c.version} uploaded.`);
        say(c, msg);
        if (by === 'editor' && c.col !== 'inspo') {
          c.notes = Array.isArray(c.notes) ? c.notes : [];
          c.notes.unshift(stamp({ text: msg, ts: now }));
          c.notes.length = Math.min(c.notes.length, 50);
        }
        if (cut) events.push({ kind: 'cut', cardId: c.id, text: msg });
        if (by === 'client') {
          if (c.col === 'review') { c.status = 'changes'; events.push({ kind: 'revision', cardId: c.id, text: msg }); }
          else if (c.col === 'ready') {
            c.col = 'review'; c.status = 'changes';
            say(c, 'Reopened for changes.', true);
            place(c, 'review', 0);
            events.push({ kind: 'revision', cardId: c.id, text: msg });
          }
          else if (c.col === 'inspo') events.push({ kind: 'comment', cardId: c.id, text: msg });
        }
        return { board, events, card: c };
      }

      case 'move': {
        const c = get(a.id);
        const to = a.to;
        if (!canMove(c, to, role)) {
          fail(403, to === 'ready' ? 'Only the client can approve a video.'
            : role === 'editor' ? 'Editors can only move cards between Ideas and Review.'
            : 'Only your Sollenzia team can move this card there.');
        }
        const from = c.col;
        if (from !== to) {
          c.col = to;
          if (to === 'ready' && from === 'review') {
            c.approvedAt = now; c.status = 'approved';
            say(c, `Approved V${c.version || 1}.`, true);
            events.push({ kind: 'approved', cardId: c.id });
          } else if (to === 'ready' && from === 'posted') {
            delete c.postedAt; c.status = 'approved';
            say(c, 'Moved back to Ready to post.', true);
          } else if (to === 'ready') {
            c.approvedAt = now; c.status = 'approved';
            say(c, 'Moved to Ready to post.', true);
          } else if (to === 'posted') {
            c.postedAt = now; c.status = 'posted';
            say(c, 'Marked as posted.', true);
            events.push({ kind: 'posted', cardId: c.id });
          } else if (to === 'review') {
            c.version = c.version || 1;
            c.notes = Array.isArray(c.notes) ? c.notes : [];
            if (from === 'ready' || from === 'posted') { c.status = 'changes'; say(c, 'Reopened for changes.', true); events.push({ kind: 'reopen', cardId: c.id }); }
            else {
              c.status = 'awaiting';
              const v = role !== 'client' ? link(a.video) : '';
              if (v && !c.video) c.video = v;
              say(c, c.video ? 'Moved to review with the video.' : 'Moved to review (no video yet).', true);
              if (c.video) events.push({ kind: 'cut', cardId: c.id });   // pas de vidéo → pas de notif
            }
          } else {
            say(c, 'Moved back to ideas.', true);
          }
        }
        place(c, to, Number.isInteger(a.index) ? a.index : (from === to ? cards.filter(x => x.col === to).indexOf(c) : 0));
        return { board, events, card: c };
      }

      case 'delete': {
        const c = get(a.id);
        if (!canDelete(c, role)) fail(403, role === 'editor' ? 'Editors can\'t delete cards. Ask Sollenzia or the client.' : 'Only your Sollenzia team can delete videos.');
        cards.splice(cards.indexOf(c), 1);
        if (c.col === 'inspo') events.push({ kind: 'idea_deleted', cardId: c.id });
        return { board, events, card: c };
      }

      default:
        fail(400, 'Unknown action.');
    }
  }

  return { COLS, PLATS, ROLES, apply, canMove, canDelete, canAddTo, canUploadCut, cleanPlatforms };
});
