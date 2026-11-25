import { db } from "./firebase-config.js";
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, writeBatch, query, where, orderBy, limit,
  startAfter, increment, serverTimestamp, documentId, getCountFromServer, getAggregateFromServer, sum
} from "./fs.js";
import {
  normalize, buildKeywords, buildNameKeywords, searchTokens, seriesSortKey, toCents, chunk, hashStr, sleep
} from "./utils.js";
import { normalizeIsbn } from "./isbn.js";
import { BD_SORTS, COLLECTION_SORTS, PUBLISHER_SORTS, ETAT_KEYS, DEFAULT_HOME } from "./constants.js";

/*
 * Modèle Firestore (tout est rangé sous users/{uid}) :
 *   users/{uid}                    shareEnabled, shareName, home (réglages de l'accueil)
 *   users/{uid}/meta/stats         compteurs globaux (BD, collections, éditeurs, cote, états…)
 *   users/{uid}/bds/{id}           albums
 *   users/{uid}/collections/{id}   séries : nom, éditeur, nombre de tomes, nombre possédé
 *   users/{uid}/publishers/{id}    éditeurs : nom, nombre de collections
 *
 * Avec des dizaines de milliers d'albums, rien n'est jamais chargé en entier :
 * les listes sont paginées, les compteurs sont tenus à jour par incréments,
 * et la recherche passe par un tableau de mots-clés indexé (array-contains).
 */

const coll = (uid, name) => collection(db, "users", uid, name);
const ref = (uid, name, id) => doc(db, "users", uid, name, id);
const userRef = (uid) => doc(db, "users", uid);
const statsRef = (uid) => doc(db, "users", uid, "meta", "stats");

export const PAGE_SIZE = 30;

/** Attend l'accusé du serveur, sans bloquer l'interface hors connexion. */
async function commitSoon(batch, ms = 4000) {
  const p = batch.commit();
  p.catch((e) => console.error("Écriture refusée", e));
  await Promise.race([p, sleep(ms)]);
}

function snapToList(snap) {
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// ---------------------------------------------------------------- Compte

export async function ensureUser(uid) {
  const s = await getDoc(userRef(uid));
  if (!s.exists()) {
    await setDoc(userRef(uid), { shareEnabled: false, shareName: "", home: DEFAULT_HOME, createdAt: serverTimestamp() });
  }
  const st = await getDoc(statsRef(uid));
  if (!st.exists()) {
    await setDoc(statsRef(uid), { bdCount: 0, collectionCount: 0, publisherCount: 0, coteCents: 0, achatCents: 0, etat: {} });
  }
}

export async function getUserDoc(uid) {
  const s = await getDoc(userRef(uid));
  return s.exists() ? s.data() : null;
}

export async function updateUserDoc(uid, data) {
  await setDoc(userRef(uid), data, { merge: true });
}

export async function getStats(uid) {
  const s = await getDoc(statsRef(uid));
  return { bdCount: 0, collectionCount: 0, publisherCount: 0, coteCents: 0, achatCents: 0, etat: {}, ...(s.exists() ? s.data() : {}) };
}

function addStats(target, delta) {
  for (const [k, v] of Object.entries(delta)) {
    if (k === "etat") {
      target.etat = target.etat || {};
      for (const [e, n] of Object.entries(v)) target.etat[e] = (target.etat[e] || 0) + n;
    } else target[k] = (target[k] || 0) + v;
  }
}

function statsWrite(delta) {
  const out = { updatedAt: serverTimestamp() };
  for (const [k, v] of Object.entries(delta)) {
    if (k === "etat") {
      const e = {};
      for (const [key, n] of Object.entries(v)) if (n) e[key] = increment(n);
      if (Object.keys(e).length) out.etat = e;
    } else if (v) out[k] = increment(v);
  }
  return out;
}

function bdStatsDelta(bd, sign) {
  return {
    bdCount: sign,
    coteCents: sign * toCents(bd.cote),
    achatCents: sign * toCents(bd.prixAchat),
    etat: { [bd.etat || "nc"]: sign }
  };
}

// ---------------------------------------------------------------- BD : normalisation

const NUM_FIELDS = ["numero", "annee", "pages", "cote", "prixAchat"];
const TEXT_FIELDS = ["titre", "collectionName", "publisherName", "scenariste", "dessinateur", "coloriste", "auteurs", "couverture", "resume", "notes"];

/** Document BD complet : tous les champs triables existent toujours (sinon Firestore exclut le document du tri). */
export function finalizeBd(input) {
  const bd = {};
  for (const k of TEXT_FIELDS) bd[k] = String(input[k] ?? "").trim();
  for (const k of NUM_FIELDS) {
    const v = input[k];
    bd[k] = v === "" || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v);
  }
  bd.isbn = input.isbn ? normalizeIsbn(input.isbn) : "";
  bd.etat = ETAT_KEYS.includes(input.etat) ? input.etat : "nc";
  bd.dateAchat = input.dateAchat || null;
  bd.eo = !!input.eo;
  bd.collectionId = input.collectionId || null;
  bd.publisherId = input.publisherId || null;
  if (!bd.titre && bd.collectionName) bd.titre = bd.numero ? `${bd.collectionName}, tome ${bd.numero}` : bd.collectionName;
  bd.titleLower = normalize(bd.titre);
  bd.seriesSort = seriesSortKey(bd.collectionName, bd.numero, bd.titleLower);
  bd.keywords = buildKeywords(bd);
  return bd;
}

// ---------------------------------------------------------------- Recherche par nom (collections / éditeurs)

/** Retrouve des collections ou éditeurs par nom exact (insensible à la casse et aux accents). */
async function findByNames(uid, name, namesLower) {
  const map = new Map();
  const unique = [...new Set(namesLower.filter(Boolean))];
  for (const part of chunk(unique, 30)) {
    const snap = await getDocs(query(coll(uid, name), where("nameLower", "in", part)));
    snap.docs.forEach((d) => { if (!map.has(d.data().nameLower)) map.set(d.data().nameLower, { id: d.id, ...d.data() }); });
  }
  return map;
}

async function findOneByName(uid, name, label) {
  const lower = normalize(label);
  if (!lower) return null;
  return (await findByNames(uid, name, [lower])).get(lower) || null;
}

/** Suggestions pour les champs de saisie (autocomplétion). */
export async function suggest(uid, name, text, n = 8) {
  const tokens = searchTokens(text);
  if (!tokens.length) return [];
  const t = [...tokens].sort((a, b) => b.length - a.length)[0];
  const snap = await getDocs(query(coll(uid, name), where("keywords", "array-contains", t), orderBy("nameLower"), limit(n * 3)));
  return snapToList(snap).filter((c) => tokens.every((tk) => c.keywords?.includes(tk))).slice(0, n);
}

// ---------------------------------------------------------------- BD : lecture

export async function getBd(uid, id) {
  const s = await getDoc(ref(uid, "bds", id));
  return s.exists() ? { id: s.id, ...s.data() } : null;
}

/**
 * Page de BD. Un seul filtre part au serveur (le plus sélectif), les autres
 * sont appliqués ici ; on enchaîne quelques pages pour remplir l'écran.
 */
export async function listBds(uid, { q = "", collectionId = null, publisherId = null, etat = "", sort = "serie", dir = null, cursor = null, pageSize = PAGE_SIZE } = {}) {
  const s = BD_SORTS.find((x) => x.key === sort) || BD_SORTS[0];
  const d = dir || s.dir;
  const tokens = searchTokens(q, normalizeIsbn);
  const server = [];
  if (collectionId) server.push(where("collectionId", "==", collectionId));
  else if (tokens.length) server.push(where("keywords", "array-contains", [...tokens].sort((a, b) => b.length - a.length)[0]));
  else if (publisherId) server.push(where("publisherId", "==", publisherId));
  else if (etat) server.push(where("etat", "==", etat));

  const ok = (bd) =>
    (!collectionId || bd.collectionId === collectionId) &&
    (!publisherId || bd.publisherId === publisherId) &&
    (!etat || bd.etat === etat) &&
    tokens.every((t) => bd.keywords?.includes(t));

  const items = [];
  let last = cursor, done = false, rounds = 0;
  while (items.length < pageSize && !done && rounds < 6) {
    const cons = [...server, orderBy(s.field, d)];
    if (last) cons.push(startAfter(last));
    cons.push(limit(pageSize));
    const snap = await getDocs(query(coll(uid, "bds"), ...cons));
    for (const ds of snap.docs) {
      const bd = { id: ds.id, ...ds.data() };
      if (ok(bd)) items.push(bd);
    }
    if (snap.docs.length) last = snap.docs[snap.docs.length - 1];
    if (snap.docs.length < pageSize) done = true;
    rounds++;
  }
  return { items, cursor: last, done };
}

/** Tous les albums d'une collection, par numéro (une série dépasse rarement quelques centaines de tomes). */
export async function listBdsOfCollection(uid, collectionId, max = 1000) {
  const snap = await getDocs(query(coll(uid, "bds"), where("collectionId", "==", collectionId), orderBy("numero", "asc"), limit(max)));
  return snapToList(snap);
}

export async function findBdByIsbn(uid, isbn) {
  const n = normalizeIsbn(isbn);
  if (!n) return null;
  const snap = await getDocs(query(coll(uid, "bds"), where("keywords", "array-contains", n), limit(1)));
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

export async function latestPurchases(uid, n) {
  const snap = await getDocs(query(coll(uid, "bds"), where("dateAchat", ">", ""), orderBy("dateAchat", "desc"), limit(n)));
  return snapToList(snap);
}

export async function latestAdded(uid, n) {
  const snap = await getDocs(query(coll(uid, "bds"), orderBy("createdAt", "desc"), limit(n)));
  return snapToList(snap);
}

export async function collectionsToComplete(uid, n) {
  const snap = await getDocs(query(coll(uid, "collections"), orderBy("updatedAt", "desc"), limit(60)));
  return snapToList(snap).filter((c) => c.totalVolumes && c.ownedCount < c.totalVolumes).slice(0, n);
}

// ---------------------------------------------------------------- BD : écriture

/**
 * Crée ou modifie une BD. Crée au passage la collection et l'éditeur s'ils
 * n'existent pas, et tient les compteurs à jour dans le même lot d'écritures.
 */
export async function saveBd(uid, input, existing = null) {
  const now = serverTimestamp();
  const batch = writeBatch(db);
  const delta = {};
  const draft = finalizeBd(input);

  let col = draft.collectionName ? await findOneByName(uid, "collections", draft.collectionName) : null;
  if (col && !draft.publisherName && col.publisherName) draft.publisherName = col.publisherName;
  let pub = draft.publisherName ? await findOneByName(uid, "publishers", draft.publisherName) : null;

  const newCol = !!draft.collectionName && !col;
  let pubNewCollections = 0;

  // Éditeur
  if (draft.publisherName && !pub) {
    const r = doc(coll(uid, "publishers"));
    pub = { id: r.id, name: draft.publisherName, isNew: true };
    addStats(delta, { publisherCount: 1 });
  }

  // Collection
  if (newCol) {
    const r = doc(coll(uid, "collections"));
    col = { id: r.id, name: draft.collectionName, publisherId: pub?.id || null, publisherName: pub?.name || "" };
    batch.set(r, {
      name: draft.collectionName, nameLower: normalize(draft.collectionName),
      publisherId: col.publisherId, publisherName: col.publisherName,
      keywords: buildNameKeywords(draft.collectionName, col.publisherName),
      totalVolumes: null, ownedCount: 1, notes: "", createdAt: now, updatedAt: now
    });
    addStats(delta, { collectionCount: 1 });
    if (pub) pubNewCollections = 1;
  } else if (col) {
    const same = existing && existing.collectionId === col.id;
    batch.update(ref(uid, "collections", col.id), same ? { updatedAt: now } : { ownedCount: increment(1), updatedAt: now });
  }
  if (existing?.collectionId && existing.collectionId !== (col?.id || null)) {
    batch.update(ref(uid, "collections", existing.collectionId), { ownedCount: increment(-1), updatedAt: now });
  }

  if (pub?.isNew) {
    batch.set(ref(uid, "publishers", pub.id), {
      name: pub.name, nameLower: normalize(pub.name), keywords: buildNameKeywords(pub.name),
      collectionCount: pubNewCollections, createdAt: now, updatedAt: now
    });
  } else if (pub && pubNewCollections) {
    batch.update(ref(uid, "publishers", pub.id), { collectionCount: increment(pubNewCollections), updatedAt: now });
  }

  // Album (noms canoniques de la collection et de l'éditeur)
  const bd = finalizeBd({
    ...draft,
    collectionId: col?.id || null, collectionName: col?.name || "",
    publisherId: pub?.id || null, publisherName: pub?.name || draft.publisherName
  });
  const bdRef = existing ? ref(uid, "bds", existing.id) : doc(coll(uid, "bds"));
  batch.set(bdRef, { ...bd, createdAt: existing?.createdAt || now, updatedAt: now });

  if (existing) addStats(delta, bdStatsDelta(existing, -1));
  addStats(delta, bdStatsDelta(bd, 1));
  batch.set(statsRef(uid), statsWrite(delta), { merge: true });

  await commitSoon(batch);
  return bdRef.id;
}

export async function deleteBd(uid, bd) {
  const batch = writeBatch(db);
  batch.delete(ref(uid, "bds", bd.id));
  if (bd.collectionId) batch.update(ref(uid, "collections", bd.collectionId), { ownedCount: increment(-1), updatedAt: serverTimestamp() });
  batch.set(statsRef(uid), statsWrite(bdStatsDelta(bd, -1)), { merge: true });
  await commitSoon(batch);
}

/** Applique une modification à tous les documents d'une requête, par lots de 400. */
async function forEachPage(q, size, fn) {
  let last = null;
  for (;;) {
    const snap = await getDocs(last ? query(q, startAfter(last), limit(size)) : query(q, limit(size)));
    if (snap.empty) break;
    await fn(snap.docs);
    last = snap.docs[snap.docs.length - 1];
    if (snap.docs.length < size) break;
  }
}

// ---------------------------------------------------------------- Collections

export async function getCollectionDoc(uid, id) {
  const s = await getDoc(ref(uid, "collections", id));
  return s.exists() ? { id: s.id, ...s.data() } : null;
}

export async function listCollections(uid, { q = "", publisherId = null, sort = "nom", cursor = null, pageSize = PAGE_SIZE } = {}) {
  const s = COLLECTION_SORTS.find((x) => x.key === sort) || COLLECTION_SORTS[0];
  const tokens = searchTokens(q);
  const cons = [];
  let field = s.field, d = s.dir;
  if (tokens.length) {
    cons.push(where("keywords", "array-contains", [...tokens].sort((a, b) => b.length - a.length)[0]));
    field = "nameLower"; d = "asc";
  } else if (publisherId) cons.push(where("publisherId", "==", publisherId));
  const ok = (c) => (!publisherId || c.publisherId === publisherId) && tokens.every((t) => c.keywords?.includes(t));

  const items = [];
  let last = cursor, done = false, rounds = 0;
  while (items.length < pageSize && !done && rounds < 6) {
    const all = [...cons, orderBy(field, d)];
    if (last) all.push(startAfter(last));
    all.push(limit(pageSize));
    const snap = await getDocs(query(coll(uid, "collections"), ...all));
    snapToList(snap).filter(ok).forEach((c) => items.push(c));
    if (snap.docs.length) last = snap.docs[snap.docs.length - 1];
    if (snap.docs.length < pageSize) done = true;
    rounds++;
  }
  return { items, cursor: last, done };
}

export async function saveCollection(uid, input, existing = null) {
  const name = String(input.name || "").trim();
  if (!name) throw new Error("Le nom de la collection est obligatoire.");
  const same = await findOneByName(uid, "collections", name);
  if (same && same.id !== existing?.id) throw new Error(`La collection « ${same.name} » existe déjà.`);

  const now = serverTimestamp();
  const batch = writeBatch(db);
  const delta = {};
  const publisherName = String(input.publisherName || "").trim();
  let pub = publisherName ? await findOneByName(uid, "publishers", publisherName) : null;
  if (publisherName && !pub) {
    const r = doc(coll(uid, "publishers"));
    pub = { id: r.id, name: publisherName, isNew: true };
    addStats(delta, { publisherCount: 1 });
  }
  const pubChanged = (existing?.publisherId || null) !== (pub?.id || null);

  const data = {
    name, nameLower: normalize(name),
    publisherId: pub?.id || null, publisherName: pub?.name || "",
    keywords: buildNameKeywords(name, pub?.name),
    totalVolumes: input.totalVolumes ? Number(input.totalVolumes) : null,
    notes: String(input.notes || "").trim(),
    updatedAt: now
  };

  const colRef = existing ? ref(uid, "collections", existing.id) : doc(coll(uid, "collections"));
  if (existing) batch.update(colRef, data);
  else {
    batch.set(colRef, { ...data, ownedCount: 0, createdAt: now });
    addStats(delta, { collectionCount: 1 });
  }

  if (pub?.isNew) {
    batch.set(ref(uid, "publishers", pub.id), {
      name: pub.name, nameLower: normalize(pub.name), keywords: buildNameKeywords(pub.name),
      collectionCount: 1, createdAt: now, updatedAt: now
    });
  } else if (pub && (!existing || pubChanged)) {
    batch.update(ref(uid, "publishers", pub.id), { collectionCount: increment(1), updatedAt: now });
  }
  if (existing?.publisherId && pubChanged) {
    batch.update(ref(uid, "publishers", existing.publisherId), { collectionCount: increment(-1), updatedAt: now });
  }
  if (Object.keys(delta).length) batch.set(statsRef(uid), statsWrite(delta), { merge: true });
  await commitSoon(batch);

  // Renommage ou changement d'éditeur : on répercute sur les albums.
  if (existing && (existing.name !== name || pubChanged)) {
    await forEachPage(query(coll(uid, "bds"), where("collectionId", "==", existing.id), orderBy(documentId())), 400, async (docs) => {
      const b = writeBatch(db);
      for (const ds of docs) {
        const bd = finalizeBd({ ...ds.data(), collectionName: name, publisherId: pub?.id || null, publisherName: pub?.name || "" });
        b.update(ds.ref, { collectionName: bd.collectionName, publisherId: bd.publisherId, publisherName: bd.publisherName, seriesSort: bd.seriesSort, keywords: bd.keywords, titleLower: bd.titleLower, titre: bd.titre });
      }
      await b.commit();
    });
  }
  return colRef.id;
}

/** Supprime une collection et tous ses albums. */
export async function deleteCollection(uid, col, onProgress = () => {}) {
  let removed = 0;
  // On relit toujours la première page : les albums déjà supprimés n'y sont plus.
  for (;;) {
    const snap = await getDocs(query(coll(uid, "bds"), where("collectionId", "==", col.id), limit(400)));
    if (snap.empty) break;
    const b = writeBatch(db);
    const delta = {};
    snap.docs.forEach((ds) => { b.delete(ds.ref); addStats(delta, bdStatsDelta(ds.data(), -1)); });
    b.set(statsRef(uid), statsWrite(delta), { merge: true });
    await b.commit();
    removed += snap.size;
    onProgress(removed);
  }
  const b = writeBatch(db);
  b.delete(ref(uid, "collections", col.id));
  b.set(statsRef(uid), statsWrite({ collectionCount: -1 }), { merge: true });
  if (col.publisherId) b.update(ref(uid, "publishers", col.publisherId), { collectionCount: increment(-1) });
  await b.commit();
  return removed;
}

// ---------------------------------------------------------------- Éditeurs

export async function getPublisher(uid, id) {
  const s = await getDoc(ref(uid, "publishers", id));
  return s.exists() ? { id: s.id, ...s.data() } : null;
}

export async function listPublishers(uid, { q = "", sort = "nom", cursor = null, pageSize = PAGE_SIZE } = {}) {
  const s = PUBLISHER_SORTS.find((x) => x.key === sort) || PUBLISHER_SORTS[0];
  const tokens = searchTokens(q);
  const cons = [];
  let field = s.field, d = s.dir;
  if (tokens.length) {
    cons.push(where("keywords", "array-contains", [...tokens].sort((a, b) => b.length - a.length)[0]));
    field = "nameLower"; d = "asc";
  }
  const items = [];
  let last = cursor, done = false, rounds = 0;
  while (items.length < pageSize && !done && rounds < 6) {
    const all = [...cons, orderBy(field, d)];
    if (last) all.push(startAfter(last));
    all.push(limit(pageSize));
    const snap = await getDocs(query(coll(uid, "publishers"), ...all));
    snapToList(snap).filter((p) => tokens.every((t) => p.keywords?.includes(t))).forEach((p) => items.push(p));
    if (snap.docs.length) last = snap.docs[snap.docs.length - 1];
    if (snap.docs.length < pageSize) done = true;
    rounds++;
  }
  return { items, cursor: last, done };
}

export async function savePublisher(uid, input, existing = null) {
  const name = String(input.name || "").trim();
  if (!name) throw new Error("Le nom de l’éditeur est obligatoire.");
  const same = await findOneByName(uid, "publishers", name);
  if (same && same.id !== existing?.id) throw new Error(`L’éditeur « ${same.name} » existe déjà.`);
  const now = serverTimestamp();
  const data = { name, nameLower: normalize(name), keywords: buildNameKeywords(name), notes: String(input.notes || "").trim(), updatedAt: now };

  if (!existing) {
    const r = doc(coll(uid, "publishers"));
    const b = writeBatch(db);
    b.set(r, { ...data, collectionCount: 0, createdAt: now });
    b.set(statsRef(uid), statsWrite({ publisherCount: 1 }), { merge: true });
    await commitSoon(b);
    return r.id;
  }
  await updateDoc(ref(uid, "publishers", existing.id), data);
  if (existing.name !== name) {
    await forEachPage(query(coll(uid, "collections"), where("publisherId", "==", existing.id), orderBy(documentId())), 400, async (docs) => {
      const b = writeBatch(db);
      docs.forEach((ds) => b.update(ds.ref, { publisherName: name, keywords: buildNameKeywords(ds.data().name, name) }));
      await b.commit();
    });
    await forEachPage(query(coll(uid, "bds"), where("publisherId", "==", existing.id), orderBy(documentId())), 400, async (docs) => {
      const b = writeBatch(db);
      docs.forEach((ds) => {
        const bd = finalizeBd({ ...ds.data(), publisherName: name });
        b.update(ds.ref, { publisherName: name, keywords: bd.keywords });
      });
      await b.commit();
    });
  }
  return existing.id;
}

export async function deletePublisher(uid, pub) {
  const used = await getDocs(query(coll(uid, "bds"), where("publisherId", "==", pub.id), limit(1)));
  if ((pub.collectionCount || 0) > 0 || !used.empty) {
    throw new Error("Cet éditeur a encore des collections ou des albums. Supprimez-les ou changez leur éditeur d’abord.");
  }
  const b = writeBatch(db);
  b.delete(ref(uid, "publishers", pub.id));
  b.set(statsRef(uid), statsWrite({ publisherCount: -1 }), { merge: true });
  await commitSoon(b);
}

// ---------------------------------------------------------------- Import de masse

/** Identifiant stable : réimporter les mêmes lignes ne crée pas de doublon. */
export function importId(bd) {
  if (bd.isbn) return "isbn-" + bd.isbn;
  return "h-" + hashStr(normalize(bd.collectionName) + "|" + (bd.numero ?? "") + "|" + normalize(bd.titre));
}

async function existingIds(uid, ids) {
  const found = new Set();
  for (const part of chunk(ids, 30)) {
    const snap = await getDocs(query(coll(uid, "bds"), where(documentId(), "in", part)));
    snap.docs.forEach((d) => found.add(d.id));
  }
  return found;
}

export class CommitTimeout extends Error {}

/**
 * Importe un paquet de lignes (150 au plus, pour tenir dans un lot Firestore de 500 écritures).
 * entries : [{ line, bd, totalVolumes }]
 * Coût : 1 écriture par album + 1 par collection et éditeur touchés + 1 pour les compteurs.
 */
export async function importChunk(uid, entries, { timeoutMs = 90000 } = {}) {
  const res = { added: 0, skipped: [], writes: 0 };
  const seen = new Set();
  let list = [];
  for (const e of entries) {
    e.bd = finalizeBd(e.bd);
    e.id = importId(e.bd);
    if (seen.has(e.id)) { res.skipped.push({ line: e.line, reason: "doublon dans le fichier" }); continue; }
    seen.add(e.id);
    list.push(e);
  }
  const exist = await existingIds(uid, list.map((e) => e.id));
  list = list.filter((e) => {
    if (exist.has(e.id)) { res.skipped.push({ line: e.line, reason: "déjà dans la bédéthèque" }); return false; }
    return true;
  });
  if (!list.length) return res;

  const now = serverTimestamp();
  const batch = writeBatch(db);
  const delta = {};

  const colMap = await findByNames(uid, "collections", list.map((e) => normalize(e.bd.collectionName)));
  for (const e of list) {
    const c = colMap.get(normalize(e.bd.collectionName));
    if (c && !e.bd.publisherName && c.publisherName) e.bd.publisherName = c.publisherName;
  }
  const pubMap = await findByNames(uid, "publishers", list.map((e) => normalize(e.bd.publisherName)));

  const newPubs = new Map(); // lower → {id, name, collections}
  const pubFor = (name) => {
    const lower = normalize(name);
    if (!lower) return null;
    if (pubMap.has(lower)) return pubMap.get(lower);
    if (!newPubs.has(lower)) newPubs.set(lower, { id: doc(coll(uid, "publishers")).id, name: name.trim(), collectionCount: 0, isNew: true });
    return newPubs.get(lower);
  };

  const colTouch = new Map(); // lower → {col, count, totalVolumes, isNew}
  const pubColInc = new Map(); // id existant → +n collections
  for (const e of list) {
    const pub = pubFor(e.bd.publisherName);
    const lower = normalize(e.bd.collectionName);
    let col = null;
    if (lower) {
      if (!colTouch.has(lower)) {
        const found = colMap.get(lower);
        if (found) colTouch.set(lower, { col: found, count: 0, totalVolumes: null, isNew: false });
        else {
          const c = { id: doc(coll(uid, "collections")).id, name: e.bd.collectionName.trim(), publisherId: pub?.id || null, publisherName: pub?.name || "" };
          colTouch.set(lower, { col: c, count: 0, totalVolumes: null, isNew: true });
          if (pub?.isNew) pub.collectionCount++;
          else if (pub) pubColInc.set(pub.id, (pubColInc.get(pub.id) || 0) + 1);
        }
      }
      const t = colTouch.get(lower);
      t.count++;
      if (e.totalVolumes) t.totalVolumes = e.totalVolumes;
      col = t.col;
    }
    const bd = finalizeBd({
      ...e.bd,
      collectionId: col?.id || null, collectionName: col?.name || "",
      publisherId: pub?.id || null, publisherName: pub?.name || e.bd.publisherName
    });
    batch.set(ref(uid, "bds", e.id), { ...bd, createdAt: now, updatedAt: now });
    addStats(delta, bdStatsDelta(bd, 1));
    res.added++;
  }

  for (const t of colTouch.values()) {
    if (t.isNew) {
      batch.set(ref(uid, "collections", t.col.id), {
        name: t.col.name, nameLower: normalize(t.col.name),
        publisherId: t.col.publisherId, publisherName: t.col.publisherName,
        keywords: buildNameKeywords(t.col.name, t.col.publisherName),
        totalVolumes: t.totalVolumes, ownedCount: t.count, notes: "", createdAt: now, updatedAt: now
      });
      addStats(delta, { collectionCount: 1 });
    } else {
      const upd = { ownedCount: increment(t.count), updatedAt: now };
      if (t.totalVolumes) upd.totalVolumes = t.totalVolumes;
      batch.update(ref(uid, "collections", t.col.id), upd);
    }
  }
  for (const p of newPubs.values()) {
    batch.set(ref(uid, "publishers", p.id), {
      name: p.name, nameLower: normalize(p.name), keywords: buildNameKeywords(p.name),
      collectionCount: p.collectionCount, notes: "", createdAt: now, updatedAt: now
    });
    addStats(delta, { publisherCount: 1 });
  }
  for (const [id, n] of pubColInc) batch.update(ref(uid, "publishers", id), { collectionCount: increment(n), updatedAt: now });
  batch.set(statsRef(uid), statsWrite(delta), { merge: true });

  res.writes = res.added + colTouch.size + newPubs.size + pubColInc.size + 1;
  let timer;
  try {
    await Promise.race([
      batch.commit(),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new CommitTimeout("Firestore ne répond plus")), timeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
  }
  return res;
}

// ---------------------------------------------------------------- Recalcul des compteurs

/**
 * Recalcule tous les compteurs à partir des données, avec des requêtes d'agrégation
 * (1 lecture facturée par tranche de 1 000 documents comptés).
 */
export async function recomputeCounters(uid, onProgress = () => {}) {
  const bds = coll(uid, "bds");
  onProgress("Comptage des albums…");
  const [nb, nc, np, sums] = await Promise.all([
    getCountFromServer(bds),
    getCountFromServer(coll(uid, "collections")),
    getCountFromServer(coll(uid, "publishers")),
    getAggregateFromServer(bds, { cote: sum("cote"), achat: sum("prixAchat") })
  ]);
  const etat = {};
  for (const k of ETAT_KEYS) etat[k] = (await getCountFromServer(query(bds, where("etat", "==", k)))).data().count;
  await setDoc(statsRef(uid), {
    bdCount: nb.data().count, collectionCount: nc.data().count, publisherCount: np.data().count,
    coteCents: Math.round((sums.data().cote || 0) * 100), achatCents: Math.round((sums.data().achat || 0) * 100),
    etat, updatedAt: serverTimestamp()
  });

  let done = 0, fixed = 0;
  await forEachPage(query(coll(uid, "collections"), orderBy(documentId())), 200, async (docs) => {
    const counts = [];
    for (const part of chunk(docs, 10)) {
      counts.push(...(await Promise.all(part.map((ds) => getCountFromServer(query(bds, where("collectionId", "==", ds.id)))))));
    }
    const b = writeBatch(db);
    let n = 0;
    docs.forEach((ds, i) => {
      const c = counts[i].data().count;
      if (ds.data().ownedCount !== c) { b.update(ds.ref, { ownedCount: c }); n++; }
    });
    if (n) await b.commit();
    fixed += n;
    done += docs.length;
    onProgress(`Collections vérifiées : ${done}`);
  });

  await forEachPage(query(coll(uid, "publishers"), orderBy(documentId())), 200, async (docs) => {
    const counts = await Promise.all(docs.map((ds) => getCountFromServer(query(coll(uid, "collections"), where("publisherId", "==", ds.id)))));
    const b = writeBatch(db);
    let n = 0;
    docs.forEach((ds, i) => {
      const c = counts[i].data().count;
      if (ds.data().collectionCount !== c) { b.update(ds.ref, { collectionCount: c }); n++; }
    });
    if (n) await b.commit();
    fixed += n;
  });
  return { fixed };
}
