// Liste des clippers : nom, comptes YouTube / TikTok / Instagram, lien (ClickMagick).
// Un fichier par serveur : clippers-GUILDID.json (même dossier que le reste des données).
const fs   = require('fs');
const path = require('path');

const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? process.env.RAILWAY_VOLUME_MOUNT_PATH
  : path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Clients (créés dans l'admin du site, poussés vers le bot dans admin-config.json)
function readAdminClients() {
  try {
    const p = path.join(dataDir, 'admin-config.json');
    if (!fs.existsSync(p)) return [];
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (Array.isArray(cfg.clients) ? cfg.clients : []).filter(c => c && c.name).map(c => ({ id: String(c.id ?? c.name), name: String(c.name) }));
  } catch { return []; }
}
function resolveClient(input) {
  const q = String(input).trim().toLowerCase();
  return readAdminClients().find(c => c.id.toLowerCase() === q || c.name.toLowerCase() === q) || null;
}
function searchClients(query) {
  const q = String(query || '').trim().toLowerCase();
  return readAdminClients().filter(c => c.name.toLowerCase().includes(q)).map(c => c.name).slice(0, 25);
}

const ACCOUNT_FIELDS = ['youtube', 'tiktok', 'instagram'];

const DOMAINS = {
  youtube:   ['youtube.com', 'youtu.be'],
  tiktok:    ['tiktok.com'],
  instagram: ['instagram.com'],
};

// ─── Fichiers ────────────────────────────────────────────────────────────────

function filePath(guildId) { return path.join(dataDir, `clippers-${guildId}.json`); }

function readFile(p) {
  if (!fs.existsSync(p)) return { clippers: [] };
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { clippers: Array.isArray(data.clippers) ? data.clippers : [] };
  } catch (err) {
    // Fichier illisible : on le met de côté au lieu de l'écraser.
    try { fs.copyFileSync(p, `${p}.corrupt-${Date.now()}`); } catch {}
    console.error(`[CLIPPERS] ${p} illisible: ${err.message}`);
    return { clippers: [] };
  }
}

function writeFile(guildId, db) {
  const p = filePath(guildId);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

// ─── Validation ──────────────────────────────────────────────────────────────

const makeId = name => String(name).trim().toLowerCase().replace(/\s+/g, ' ');

function profileUrl(platform, handle, kind = 'handle') {
  const h = encodeURIComponent(handle);
  if (platform === 'tiktok')    return `https://www.tiktok.com/@${h}`;
  if (platform === 'instagram') return `https://www.instagram.com/${h}/`;
  if (kind === 'channel')       return `https://www.youtube.com/channel/${h}`;
  if (kind === 'c' || kind === 'user') return `https://www.youtube.com/${kind}/${h}`;
  return `https://www.youtube.com/@${h}`;
}

// Accepte "@pseudo", "pseudo" ou un lien de profil. Renvoie { handle, url } ou { error }.
function parseAccount(platform, input) {
  const raw = String(input).trim();
  const label = { youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram' }[platform];

  const looksLikeUrl = /^https?:\/\//i.test(raw) || /^(www\.|m\.)?(tiktok|instagram|youtube)\.com\//i.test(raw) || /^youtu\.be\//i.test(raw);
  if (looksLikeUrl) {
    let u;
    try { u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); }
    catch { return { error: `${label} : lien invalide.` }; }
    const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
    if (!DOMAINS[platform].some(d => host === d || host.endsWith(`.${d}`))) {
      return { error: `${label} : ce lien n'est pas un lien ${label}.` };
    }
    const parts = u.pathname.split('/').filter(Boolean).map(p => { try { return decodeURIComponent(p); } catch { return p; } });
    if (!parts.length) return { error: `${label} : donne le lien du profil (pas la page d'accueil).` };

    if (platform === 'youtube') {
      if (['channel', 'c', 'user'].includes(parts[0])) {
        if (!parts[1]) return { error: `${label} : lien de chaîne incomplet.` };
        return { handle: parts[1], url: profileUrl('youtube', parts[1], parts[0]) };
      }
      if (['watch', 'shorts', 'playlist', 'results'].includes(parts[0]) || host === 'youtu.be') {
        return { error: `${label} : donne le lien de la chaîne (youtube.com/@pseudo), pas celui d'une vidéo.` };
      }
    }
    if (platform === 'instagram' && ['p', 'reel', 'reels', 'stories', 'explore', 'tv'].includes(parts[0])) {
      return { error: `${label} : donne le lien du profil (instagram.com/pseudo), pas celui d'une publication.` };
    }
    if (platform === 'tiktok' && parts[0] === 'video') {
      return { error: `${label} : donne le lien du profil (tiktok.com/@pseudo), pas celui d'une vidéo.` };
    }
    const handle = parts[0].replace(/^@/, '');
    if (!handle) return { error: `${label} : pseudo introuvable dans le lien.` };
    return { handle, url: profileUrl(platform, handle) };
  }

  const handle = raw.replace(/^@/, '');
  if (!/^[\w.\-]{1,100}$/.test(handle)) {
    return { error: `${label} : pseudo invalide (lettres, chiffres, . _ - uniquement). Tu peux aussi coller le lien du profil.` };
  }
  if (platform === 'youtube' && /^UC[\w-]{22}$/.test(handle)) {
    return { handle, url: profileUrl('youtube', handle, 'channel') };
  }
  return { handle, url: profileUrl(platform, handle) };
}

// Lien (ClickMagick) : on ajoute https:// s'il manque.
function parseLink(input) {
  let raw = String(input).trim();
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let u;
  try { u = new URL(raw); } catch { return { error: 'Link : lien invalide.' }; }
  if (!['http:', 'https:'].includes(u.protocol) || !u.hostname.includes('.')) return { error: 'Link : lien invalide.' };
  if (u.href.length > 500) return { error: 'Link : lien trop long.' };
  return { url: u.href };
}

// ─── Opérations ──────────────────────────────────────────────────────────────

const isClear = v => String(v).trim() === '-';

// fields : { youtube, tiktok, instagram, link } — undefined = ne pas toucher, "-" = effacer.
// Si le nom existe déjà, seuls les champs fournis sont modifiés.
function upsertClipper(guildId, name, fields, addedBy = null) {
  const cleanName = String(name).trim().replace(/\s+/g, ' ');
  if (!cleanName) return { error: 'Nom invalide.' };
  if (cleanName.length > 50) return { error: 'Nom trop long (50 caractères max).' };

  // On valide tout avant d'écrire quoi que ce soit.
  const updates = {};
  for (const f of ACCOUNT_FIELDS) {
    if (fields[f] === undefined || fields[f] === null) continue;
    if (isClear(fields[f])) { updates[f] = null; continue; }
    const r = parseAccount(f, fields[f]);
    if (r.error) return { error: r.error };
    updates[f] = { handle: r.handle, url: r.url };
  }
  if (fields.link !== undefined && fields.link !== null) {
    if (isClear(fields.link)) updates.link = null;
    else {
      const r = parseLink(fields.link);
      if (r.error) return { error: r.error };
      updates.link = r.url;
    }
  }

  if (fields.client !== undefined && fields.client !== null) {
    if (isClear(fields.client)) { updates.clientId = null; updates.clientName = null; }
    else {
      const cl = resolveClient(fields.client);
      if (!cl) {
        const known = readAdminClients().map(c => c.name);
        return { error: known.length ? `Client « ${String(fields.client).trim()} » introuvable. Clients connus : ${known.join(', ')}` : "Aucun client trouvé. Crée d'abord tes clients dans l'admin du site, puis clique « Push Local Data to Railway »." };
      }
      updates.clientId = cl.id; updates.clientName = cl.name;
    }
  }

  const db = readFile(filePath(guildId));
  const id = makeId(cleanName);
  const now = new Date().toISOString();
  let clipper = db.clippers.find(c => c.id === id);
  const created = !clipper;
  if (created) {
    clipper = { id, name: cleanName, youtube: null, tiktok: null, instagram: null, link: null, clientId: null, clientName: null, createdAt: now, addedBy };
    db.clippers.push(clipper);
  }
  Object.assign(clipper, updates);
  clipper.updatedAt = now;
  writeFile(guildId, db);
  return { clipper, created, changed: Object.keys(updates).length };
}

// Assigne (ou retire, clientId = null) le client d'un clipper — utilisé par le site.
function assignClient(guildId, clipperId, clientId) {
  const db = readFile(filePath(guildId));
  const c = db.clippers.find(x => x.id === String(clipperId));
  if (!c) return { error: 'Clipper not found' };
  if (!clientId) { c.clientId = null; c.clientName = null; }
  else {
    const cl = readAdminClients().find(x => x.id === String(clientId));
    if (!cl) return { error: 'Client not found' };
    c.clientId = cl.id; c.clientName = cl.name;
  }
  c.updatedAt = new Date().toISOString();
  writeFile(guildId, db);
  return { clipper: c };
}

function removeClipper(guildId, name) {
  const db = readFile(filePath(guildId));
  const id = makeId(name);
  const idx = db.clippers.findIndex(c => c.id === id);
  if (idx === -1) return null;
  const [removed] = db.clippers.splice(idx, 1);
  writeFile(guildId, db);
  return removed;
}

function listClippers(guildId) { return readFile(filePath(guildId)).clippers; }

function searchNames(guildId, query) {
  const q = String(query || '').trim().toLowerCase();
  return listClippers(guildId)
    .filter(c => c.id.includes(q))
    .map(c => c.name)
    .slice(0, 25);
}

// Pour l'API du site : tous les serveurs (ou un seul si guildId est fourni).
function getAllClippers(guildId = null) {
  const files = guildId
    ? [`clippers-${guildId}.json`]
    : fs.readdirSync(dataDir).filter(f => /^clippers-.+\.json$/.test(f));
  const out = [];
  const clients = readAdminClients();
  for (const f of files) {
    const gid = f.replace(/^clippers-/, '').replace(/\.json$/, '');
    for (const c of readFile(path.join(dataDir, f)).clippers) {
      const live = c.clientId ? clients.find(x => x.id === c.clientId) : null;
      out.push({ ...c, clientName: live ? live.name : (c.clientName || null), guildId: gid });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = {
  ACCOUNT_FIELDS, parseAccount, parseLink,
  upsertClipper, assignClient, removeClipper, listClippers, searchNames, getAllClippers,
  readAdminClients, resolveClient, searchClients,
};
