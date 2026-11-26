import { db } from "./firebase-config.js";
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, writeBatch, query, where, orderBy, limit,
  startAfter, increment, serverTimestamp, documentId, getCountFromServer, deleteDoc,
  arrayUnion, arrayRemove, deleteField
} from "./fs.js";
import {
  normalize, buildKeywords, buildNameKeywords, searchTokens, seriesSortKey, chunk, hashStr, sleep
} from "./utils.js";
import { normalizeIsbn } from "./isbn.js";
import { BD_SORTS, COLLECTION_SORTS, PUBLISHER_SORTS, ETAT_KEYS, DEFAULT_HOME } from "./constants.js";

/*
 * Modèle Firestore
 *   accounts/{clé}                   réglages du compte : navPosition, pseudo, lastLibrary
 *   libraries/{libId}                name, legacy, shared, memberKeys[], members { clé: { role, name, addedAt } }, home
 *   libraries/{libId}/meta/stats     compteurs globaux (BD, collections, éditeurs, par état, par cote)
 *   libraries/{libId}/bds/{id}       albums
 *   libraries/{libId}/collections/{id}  séries : nom, éditeur, nombre de tomes, nombre possédé
 *   libraries/{libId}/publishers/{id}   éditeurs : nom, nombre de collections
 *   libraries/{libId}/covers/{bdId}  photo de couverture en grand (prise avec le téléphone)
 *   shares/{libId}                   partage public en lecture seule : name, home
 *
 * « clé » = empreinte SHA-256 de l'adresse e-mail en minuscules : la même personne retrouve ses
 * bédéthèques qu'elle se connecte avec Google ou avec e-mail + mot de passe. L'adresse elle-même
 * n'est jamais enregistrée.
 *
 * Bédéthèques de l'ancienne version (une seule par compte) : leurs données restent sous users/{uid},
 * sans copie. Elles sont décrites par libraries/{uid} avec legacy = true. On les reconnaît à leur
 * identifiant : les nouvelles commencent toutes par « lib_ ».
 *
 * Toutes les fonctions de données prennent l'identifiant de la BÉDÉTHÈQUE.
 * Avec des dizaines de milliers d'albums, rien n'est jamais chargé en entier :
 * les listes sont paginées, les compteurs sont tenus à jour par incréments,
 * et la recherche passe par un tableau de mots-clés indexé (array-contains).
 */

const LIB_PREFIX = "lib_";
export const isLegacyLib = (libId) => !String(libId).startsWith(LIB_PREFIX);
const root = (libId) => (isLegacyLib(libId) ? ["users", libId] : ["libraries", libId]);
const coll = (libId, name) => collection(db, ...root(libId), name);
const ref = (libId, name, id) => doc(db, ...root(libId), name, id);
const statsRef = (libId) => doc(db, ...root(libId), "meta", "stats");
const libRef = (libId) => doc(db, "libraries", libId);
const shareRef = (libId) => doc(db, "shares", libId);
const accountRef = (key) => doc(db, "accounts", key);

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

export async function getStats(libId) {
  const s = await getDoc(statsRef(libId));
  return { bdCount: 0, collectionCount: 0, publisherCount: 0, etat: {}, cote: {}, ...(s.exists() ? s.data() : {}) };
}

const MAP_STATS = ["etat", "cote"];

function addStats(target, delta) {
  for (const [k, v] of Object.entries(delta)) {
    if (MAP_STATS.includes(k)) {
      target[k] = target[k] || {};
      for (const [e, n] of Object.entries(v)) target[k][e] = (target[k][e] || 0) + n;
    } else target[k] = (target[k] || 0) + v;
  }
}

function statsWrite(delta) {
  const out = { updatedAt: serverTimestamp() };
  for (const [k, v] of Object.entries(delta)) {
    if (MAP_STATS.includes(k)) {
      const e = {};
      for (const [key, n] of Object.entries(v)) if (n) e[key] = increment(n);
      if (Object.keys(e).length) out[k] = e;
    } else if (v) out[k] = increment(v);
  }
  return out;
}

function bdStatsDelta(bd, sign) {
  return {
    bdCount: sign,
    etat: { [bd.etat || "nc"]: sign },
    cote: { [String(normCote(bd.cote))]: sign }
  };
}

/** 0 = pas coté … 3 = fortement coté */
function normCote(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 3 ? n : 0;
}

// ---------------------------------------------------------------- Identité (clé d'e-mail)

export const normEmail = (email) => String(email || "").trim().toLowerCase();
export const isEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normEmail(email));

/**
 * Empreinte SHA-256 (hexadécimal, minuscules) de l'adresse e-mail en minuscules.
 * Les règles Firestore calculent la même à partir du jeton de connexion.
 */
export async function emailKey(email) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normEmail(email)));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------- Réglages du compte

export const NAV_POSITIONS = ["left", "right"];
const ACCOUNT_DEFAULTS = { navPosition: "left", pseudo: "", lastLibrary: "" };

/** Réglages communs à toutes les façons de se connecter avec la même adresse. */
export async function getAccount(key) {
  const s = await getDoc(accountRef(key));
  return { ...ACCOUNT_DEFAULTS, ...(s.exists() ? s.data() : {}) };
}

export async function saveAccount(key, data) {
  const clean = {};
  if ("navPosition" in data) clean.navPosition = NAV_POSITIONS.includes(data.navPosition) ? data.navPosition : "left";
  if ("pseudo" in data) clean.pseudo = String(data.pseudo || "").trim().slice(0, 40);
  if ("lastLibrary" in data) clean.lastLibrary = String(data.lastLibrary || "").slice(0, 64);
  await setDoc(accountRef(key), { ...clean, updatedAt: serverTimestamp() }, { merge: true });
}

// ---------------------------------------------------------------- Bédéthèques

export const MAX_MEMBERS = 20;
export const ROLES = { owner: "Propriétaire", editor: "Co-propriétaire" };
const cleanName = (n, fallback = "") => String(n || "").trim().slice(0, 40) || fallback;

function newLibId() {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return LIB_PREFIX + Array.from(bytes, (b) => abc[b % abc.length]).join("");
}

const byName = (a, b) => String(a.name).localeCompare(String(b.name), "fr", { sensitivity: "base" });

/** Toutes les bédéthèques dont cette adresse est membre (propriétaire ou co-propriétaire). */
export async function listMyLibraries(key) {
  const snap = await getDocs(query(collection(db, "libraries"), where("memberKeys", "array-contains", key)));
  return snapToList(snap).sort(byName);
}

/** null si elle n'existe pas ou si l'on n'en est pas membre. */
export async function getLibrary(libId) {
  try {
    const s = await getDoc(libRef(libId));
    return s.exists() ? { id: s.id, ...s.data() } : null;
  } catch (e) {
    if (e?.code === "permission-denied") return null;
    throw e;
  }
}

/**
 * Crée une bédéthèque dont on est le seul membre, propriétaire.
 * legacy : reprise d'une bédéthèque de l'ancienne version (id = uid du compte d'origine).
 */
export async function createLibrary(key, { name, memberName, legacy = false, id = null, home = DEFAULT_HOME, shared = false } = {}) {
  const libId = legacy ? id : newLibId();
  const data = {
    name: cleanName(name, "Ma bédéthèque"),
    legacy: !!legacy,
    shared: !!shared,
    memberKeys: [key],
    members: { [key]: { role: "owner", name: cleanName(memberName, "Propriétaire"), addedAt: serverTimestamp() } },
    home: home || DEFAULT_HOME,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };
  await setDoc(libRef(libId), data);
  return { id: libId, ...data };
}

export async function renameLibrary(lib, name) {
  const n = cleanName(name);
  if (!n) throw new Error("Donnez un nom à la bédéthèque.");
  await updateDoc(libRef(lib.id), { name: n, updatedAt: serverTimestamp() });
  if (lib.shared) await setDoc(shareRef(lib.id), { name: n, updatedAt: serverTimestamp() }, { merge: true });
  return n;
}

export async function saveLibraryHome(lib, home) {
  await updateDoc(libRef(lib.id), { home, updatedAt: serverTimestamp() });
  if (lib.shared) await setDoc(shareRef(lib.id), { home, updatedAt: serverTimestamp() }, { merge: true });
}

/** Partage public en lecture seule. Le document shares/{id} ne contient que le nom et l'accueil. */
export async function setLibraryShared(lib, enabled) {
  if (enabled) {
    await setDoc(shareRef(lib.id), { name: lib.name, home: lib.home || DEFAULT_HOME, updatedAt: serverTimestamp() });
  } else {
    await deleteDoc(shareRef(lib.id));
  }
  await updateDoc(libRef(lib.id), { shared: !!enabled, updatedAt: serverTimestamp() });
}

/** Ce que voit un visiteur du partage public (null si la bédéthèque n'est pas partagée). */
export async function getShare(libId) {
  const s = await getDoc(shareRef(libId));
  return s.exists() ? { id: s.id, ...s.data() } : null;
}

/** Membres triés : propriétaires d'abord, puis par nom. [{ key, role, name, addedAt }] */
export function libraryMembers(lib) {
  return Object.entries(lib?.members || {})
    .map(([key, m]) => ({ key, ...m }))
    .sort((a, b) => (a.role === b.role ? byName(a, b) : a.role === "owner" ? -1 : 1));
}

/**
 * Ajoute un membre par son adresse e-mail. Seule l'empreinte de l'adresse est enregistrée :
 * la personne verra la bédéthèque dès qu'elle se connectera avec cette adresse, quel que soit
 * le moyen de connexion.
 */
export async function addMember(lib, email, name, role = "editor") {
  if (!isEmail(email)) throw new Error("Cette adresse e-mail n’est pas valide.");
  const key = await emailKey(email);
  if (lib.memberKeys?.includes(key)) throw new Error("Cette adresse est déjà membre de la bédéthèque.");
  if ((lib.memberKeys?.length || 0) >= MAX_MEMBERS) throw new Error(`Une bédéthèque compte ${MAX_MEMBERS} membres au plus.`);
  const member = { role: role === "owner" ? "owner" : "editor", name: cleanName(name, "Invité"), addedAt: serverTimestamp() };
  await updateDoc(libRef(lib.id), { memberKeys: arrayUnion(key), [`members.${key}`]: member, updatedAt: serverTimestamp() });
  return key;
}

/** Retire un membre (propriétaire) ou quitte la bédéthèque (sa propre clé). */
export async function removeMember(libId, key) {
  await updateDoc(libRef(libId), { memberKeys: arrayRemove(key), [`members.${key}`]: deleteField(), updatedAt: serverTimestamp() });
}

export async function setMemberRole(libId, key, role) {
  await updateDoc(libRef(libId), { [`members.${key}.role`]: role === "owner" ? "owner" : "editor", updatedAt: serverTimestamp() });
}

export async function renameMember(libId, key, name) {
  const n = cleanName(name);
  if (!n) throw new Error("Indiquez un nom.");
  await updateDoc(libRef(libId), { [`members.${key}.name`]: n, updatedAt: serverTimestamp() });
}

/**
 * Supprime une bédéthèque et toutes ses données (albums, collections, éditeurs, photos, compteurs),
 * par lots de 400. Coût : 1 lecture et 1 écriture par document.
 */
export async function deleteLibrary(lib, onProgress = () => {}) {
  let removed = 0;
  for (const name of ["covers", "bds", "collections", "publishers", "meta"]) {
    for (;;) {
      const snap = await getDocs(query(coll(lib.id, name), limit(400)));
      if (snap.empty) break;
      const b = writeBatch(db);
      snap.docs.forEach((d) => b.delete(d.ref));
      await b.commit();
      removed += snap.size;
      onProgress(removed);
    }
  }
  if (lib.shared) await deleteDoc(shareRef(lib.id)).catch(() => {});
  if (lib.legacy) await deleteDoc(doc(db, "users", lib.id)).catch(() => {});
  await deleteDoc(libRef(lib.id));
  return removed;
}

// ---------------------------------------------------------------- Reprise de l'ancienne version

/**
 * Bédéthèque créée avec l'ancienne version par ce compte (users/{uid}), ou null.
 * Renvoie l'ancien profil (shareEnabled, shareName, home) et ses compteurs.
 */
export async function findLegacyLibrary(uid) {
  const s = await getDoc(doc(db, "users", uid));
  if (!s.exists()) return null;
  const stats = await getStats(uid).catch(() => null);
  const n = (stats?.bdCount || 0) + (stats?.collectionCount || 0) + (stats?.publisherCount || 0);
  return { profile: s.data(), stats, hasData: n > 0 };
}

/**
 * Rattache l'ancienne bédéthèque (users/{uid}) au nouveau modèle, sans rien copier :
 * crée libraries/{uid} avec legacy = true et le compte comme propriétaire,
 * puis recrée le partage public s'il était actif (mêmes liens #/p/{uid}).
 */
export async function adoptLegacyLibrary(uid, key, legacy, memberName) {
  const p = legacy.profile || {};
  const lib = await createLibrary(key, {
    id: uid, legacy: true,
    name: "Ma bédéthèque",
    memberName: p.shareName || memberName,
    home: p.home || DEFAULT_HOME
  });
  if (p.shareEnabled) {
    try { await setLibraryShared(lib, true); lib.shared = true; } catch (e) { console.warn("Partage non repris", e); }
  }
  return lib;
}
// ---------------------------------------------------------------- BD : normalisation

const NUM_FIELDS = ["numero", "annee", "pages"];
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
  bd.cote = normCote(input.cote);
  bd.dateAchat = input.dateAchat || null;
  bd.eo = !!input.eo;
  bd.hasCoverPhoto = !!input.hasCoverPhoto && bd.couverture.startsWith("data:image/");
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
async function findByNames(libId, name, namesLower) {
  const map = new Map();
  const unique = [...new Set(namesLower.filter(Boolean))];
  for (const part of chunk(unique, 30)) {
    const snap = await getDocs(query(coll(libId, name), where("nameLower", "in", part)));
    snap.docs.forEach((d) => { if (!map.has(d.data().nameLower)) map.set(d.data().nameLower, { id: d.id, ...d.data() }); });
  }
  return map;
}

async function findOneByName(libId, name, label) {
  const lower = normalize(label);
  if (!lower) return null;
  return (await findByNames(libId, name, [lower])).get(lower) || null;
}

/** Suggestions pour les champs de saisie (autocomplétion). */
export async function suggest(libId, name, text, n = 8) {
  const tokens = searchTokens(text);
  if (!tokens.length) return [];
  const t = [...tokens].sort((a, b) => b.length - a.length)[0];
  const snap = await getDocs(query(coll(libId, name), where("keywords", "array-contains", t), orderBy("nameLower"), limit(n * 3)));
  return snapToList(snap).filter((c) => tokens.every((tk) => c.keywords?.includes(tk))).slice(0, n);
}

// ---------------------------------------------------------------- BD : lecture

export async function getBd(libId, id) {
  const s = await getDoc(ref(libId, "bds", id));
  return s.exists() ? { id: s.id, ...s.data() } : null;
}

/**
 * Page de BD. Un seul filtre part au serveur (le plus sélectif), les autres
 * sont appliqués ici ; on enchaîne quelques pages pour remplir l'écran.
 */
export async function listBds(libId, { q = "", collectionId = null, publisherId = null, etat = "", cote = null, sort = "serie", dir = null, cursor = null, pageSize = PAGE_SIZE } = {}) {
  let s = BD_SORTS.find((x) => x.key === sort) || BD_SORTS[0];
  const d = dir || s.dir;
  const coteF = cote === null || cote === "" ? null : normCote(cote);
  const tokens = searchTokens(q, normalizeIsbn);
  const server = [];
  if (collectionId) server.push(where("collectionId", "==", collectionId));
  else if (tokens.length) server.push(where("keywords", "array-contains", [...tokens].sort((a, b) => b.length - a.length)[0]));
  else if (publisherId) server.push(where("publisherId", "==", publisherId));
  else if (etat) server.push(where("etat", "==", etat));
  else if (coteF !== null) {
    server.push(where("cote", "==", coteF));
    if (s.field === "cote") s = BD_SORTS[0]; // trier sur le champ filtré n'a pas de sens
  }

  const ok = (bd) =>
    (!collectionId || bd.collectionId === collectionId) &&
    (!publisherId || bd.publisherId === publisherId) &&
    (!etat || bd.etat === etat) &&
    (coteF === null || bd.cote === coteF) &&
    tokens.every((t) => bd.keywords?.includes(t));

  const items = [];
  let last = cursor, done = false, rounds = 0;
  while (items.length < pageSize && !done && rounds < 6) {
    const cons = [...server, orderBy(s.field, d)];
    if (last) cons.push(startAfter(last));
    cons.push(limit(pageSize));
    const snap = await getDocs(query(coll(libId, "bds"), ...cons));
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
export async function listBdsOfCollection(libId, collectionId, max = 1000) {
  const snap = await getDocs(query(coll(libId, "bds"), where("collectionId", "==", collectionId), orderBy("numero", "asc"), limit(max)));
  return snapToList(snap);
}

export async function findBdByIsbn(libId, isbn) {
  const n = normalizeIsbn(isbn);
  if (!n) return null;
  const snap = await getDocs(query(coll(libId, "bds"), where("keywords", "array-contains", n), limit(1)));
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

export async function latestPurchases(libId, n) {
  const snap = await getDocs(query(coll(libId, "bds"), where("dateAchat", ">", ""), orderBy("dateAchat", "desc"), limit(n)));
  return snapToList(snap);
}

export async function latestAdded(libId, n) {
  const snap = await getDocs(query(coll(libId, "bds"), orderBy("createdAt", "desc"), limit(n)));
  return snapToList(snap);
}

export async function collectionsToComplete(libId, n) {
  const snap = await getDocs(query(coll(libId, "collections"), orderBy("updatedAt", "desc"), limit(60)));
  return snapToList(snap).filter((c) => c.totalVolumes && c.ownedCount < c.totalVolumes).slice(0, n);
}

// ---------------------------------------------------------------- BD : écriture

/** Version grande de la photo de couverture (null si l'album n'en a pas). */
export async function getCoverPhoto(libId, bdId) {
  const s = await getDoc(ref(libId, "covers", bdId));
  return s.exists() ? s.data().data : null;
}

/**
 * Crée ou modifie une BD. Crée au passage la collection et l'éditeur s'ils
 * n'existent pas, et tient les compteurs à jour dans le même lot d'écritures.
 * photo : { thumb, full } pour une nouvelle photo, "remove" pour la retirer, null pour ne rien changer.
 */
export async function saveBd(libId, input, existing = null, { photo = null } = {}) {
  const now = serverTimestamp();
  const batch = writeBatch(db);
  const delta = {};
  const draft = finalizeBd(input);

  let col = draft.collectionName ? await findOneByName(libId, "collections", draft.collectionName) : null;
  if (col && !draft.publisherName && col.publisherName) draft.publisherName = col.publisherName;
  let pub = draft.publisherName ? await findOneByName(libId, "publishers", draft.publisherName) : null;

  const newCol = !!draft.collectionName && !col;
  let pubNewCollections = 0;

  // Éditeur
  if (draft.publisherName && !pub) {
    const r = doc(coll(libId, "publishers"));
    pub = { id: r.id, name: draft.publisherName, isNew: true };
    addStats(delta, { publisherCount: 1 });
  }

  // Collection
  if (newCol) {
    const r = doc(coll(libId, "collections"));
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
    batch.update(ref(libId, "collections", col.id), same ? { updatedAt: now } : { ownedCount: increment(1), updatedAt: now });
  }
  if (existing?.collectionId && existing.collectionId !== (col?.id || null)) {
    batch.update(ref(libId, "collections", existing.collectionId), { ownedCount: increment(-1), updatedAt: now });
  }

  if (pub?.isNew) {
    batch.set(ref(libId, "publishers", pub.id), {
      name: pub.name, nameLower: normalize(pub.name), keywords: buildNameKeywords(pub.name),
      collectionCount: pubNewCollections, createdAt: now, updatedAt: now
    });
  } else if (pub && pubNewCollections) {
    batch.update(ref(libId, "publishers", pub.id), { collectionCount: increment(pubNewCollections), updatedAt: now });
  }

  // Album (noms canoniques de la collection et de l'éditeur)
  const bd = finalizeBd({
    ...draft,
    collectionId: col?.id || null, collectionName: col?.name || "",
    publisherId: pub?.id || null, publisherName: pub?.name || draft.publisherName
  });
  const bdRef = existing ? ref(libId, "bds", existing.id) : doc(coll(libId, "bds"));
  if (photo && photo !== "remove") {
    bd.couverture = photo.thumb;
    bd.hasCoverPhoto = true;
    batch.set(ref(libId, "covers", bdRef.id), { data: photo.full, updatedAt: now });
  } else if (existing?.hasCoverPhoto && (photo === "remove" || !bd.hasCoverPhoto)) {
    batch.delete(ref(libId, "covers", bdRef.id));
    if (!bd.couverture.startsWith("data:image/")) bd.hasCoverPhoto = false;
    else { bd.couverture = ""; bd.hasCoverPhoto = false; }
  }
  batch.set(bdRef, { ...bd, createdAt: existing?.createdAt || now, updatedAt: now });

  if (existing) addStats(delta, bdStatsDelta(existing, -1));
  addStats(delta, bdStatsDelta(bd, 1));
  batch.set(statsRef(libId), statsWrite(delta), { merge: true });

  await commitSoon(batch);
  return bdRef.id;
}

export async function deleteBd(libId, bd) {
  const batch = writeBatch(db);
  batch.delete(ref(libId, "bds", bd.id));
  if (bd.hasCoverPhoto) batch.delete(ref(libId, "covers", bd.id));
  if (bd.collectionId) batch.update(ref(libId, "collections", bd.collectionId), { ownedCount: increment(-1), updatedAt: serverTimestamp() });
  batch.set(statsRef(libId), statsWrite(bdStatsDelta(bd, -1)), { merge: true });
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

export async function getCollectionDoc(libId, id) {
  const s = await getDoc(ref(libId, "collections", id));
  return s.exists() ? { id: s.id, ...s.data() } : null;
}

export async function listCollections(libId, { q = "", publisherId = null, sort = "nom", cursor = null, pageSize = PAGE_SIZE } = {}) {
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
    const snap = await getDocs(query(coll(libId, "collections"), ...all));
    snapToList(snap).filter(ok).forEach((c) => items.push(c));
    if (snap.docs.length) last = snap.docs[snap.docs.length - 1];
    if (snap.docs.length < pageSize) done = true;
    rounds++;
  }
  return { items, cursor: last, done };
}

export async function saveCollection(libId, input, existing = null) {
  const name = String(input.name || "").trim();
  if (!name) throw new Error("Le nom de la collection est obligatoire.");
  const same = await findOneByName(libId, "collections", name);
  if (same && same.id !== existing?.id) throw new Error(`La collection « ${same.name} » existe déjà.`);

  const now = serverTimestamp();
  const batch = writeBatch(db);
  const delta = {};
  const publisherName = String(input.publisherName || "").trim();
  let pub = publisherName ? await findOneByName(libId, "publishers", publisherName) : null;
  if (publisherName && !pub) {
    const r = doc(coll(libId, "publishers"));
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

  const colRef = existing ? ref(libId, "collections", existing.id) : doc(coll(libId, "collections"));
  if (existing) batch.update(colRef, data);
  else {
    batch.set(colRef, { ...data, ownedCount: 0, createdAt: now });
    addStats(delta, { collectionCount: 1 });
  }

  if (pub?.isNew) {
    batch.set(ref(libId, "publishers", pub.id), {
      name: pub.name, nameLower: normalize(pub.name), keywords: buildNameKeywords(pub.name),
      collectionCount: 1, createdAt: now, updatedAt: now
    });
  } else if (pub && (!existing || pubChanged)) {
    batch.update(ref(libId, "publishers", pub.id), { collectionCount: increment(1), updatedAt: now });
  }
  if (existing?.publisherId && pubChanged) {
    batch.update(ref(libId, "publishers", existing.publisherId), { collectionCount: increment(-1), updatedAt: now });
  }
  if (Object.keys(delta).length) batch.set(statsRef(libId), statsWrite(delta), { merge: true });
  await commitSoon(batch);

  // Renommage ou changement d'éditeur : on répercute sur les albums.
  if (existing && (existing.name !== name || pubChanged)) {
    await forEachPage(query(coll(libId, "bds"), where("collectionId", "==", existing.id), orderBy(documentId())), 400, async (docs) => {
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
export async function deleteCollection(libId, col, onProgress = () => {}) {
  let removed = 0;
  // On relit toujours la première page : les albums déjà supprimés n'y sont plus.
  for (;;) {
    const snap = await getDocs(query(coll(libId, "bds"), where("collectionId", "==", col.id), limit(240)));
    if (snap.empty) break;
    const b = writeBatch(db);
    const delta = {};
    snap.docs.forEach((ds) => {
      b.delete(ds.ref);
      if (ds.data().hasCoverPhoto) b.delete(ref(libId, "covers", ds.id));
      addStats(delta, bdStatsDelta(ds.data(), -1));
    });
    b.set(statsRef(libId), statsWrite(delta), { merge: true });
    await b.commit();
    removed += snap.size;
    onProgress(removed);
  }
  const b = writeBatch(db);
  b.delete(ref(libId, "collections", col.id));
  b.set(statsRef(libId), statsWrite({ collectionCount: -1 }), { merge: true });
  if (col.publisherId) b.update(ref(libId, "publishers", col.publisherId), { collectionCount: increment(-1) });
  await b.commit();
  return removed;
}

// ---------------------------------------------------------------- Éditeurs

export async function getPublisher(libId, id) {
  const s = await getDoc(ref(libId, "publishers", id));
  return s.exists() ? { id: s.id, ...s.data() } : null;
}

export async function listPublishers(libId, { q = "", sort = "nom", cursor = null, pageSize = PAGE_SIZE } = {}) {
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
    const snap = await getDocs(query(coll(libId, "publishers"), ...all));
    snapToList(snap).filter((p) => tokens.every((t) => p.keywords?.includes(t))).forEach((p) => items.push(p));
    if (snap.docs.length) last = snap.docs[snap.docs.length - 1];
    if (snap.docs.length < pageSize) done = true;
    rounds++;
  }
  return { items, cursor: last, done };
}

export async function savePublisher(libId, input, existing = null) {
  const name = String(input.name || "").trim();
  if (!name) throw new Error("Le nom de l’éditeur est obligatoire.");
  const same = await findOneByName(libId, "publishers", name);
  if (same && same.id !== existing?.id) throw new Error(`L’éditeur « ${same.name} » existe déjà.`);
  const now = serverTimestamp();
  const data = { name, nameLower: normalize(name), keywords: buildNameKeywords(name), notes: String(input.notes || "").trim(), updatedAt: now };

  if (!existing) {
    const r = doc(coll(libId, "publishers"));
    const b = writeBatch(db);
    b.set(r, { ...data, collectionCount: 0, createdAt: now });
    b.set(statsRef(libId), statsWrite({ publisherCount: 1 }), { merge: true });
    await commitSoon(b);
    return r.id;
  }
  await updateDoc(ref(libId, "publishers", existing.id), data);
  if (existing.name !== name) {
    await forEachPage(query(coll(libId, "collections"), where("publisherId", "==", existing.id), orderBy(documentId())), 400, async (docs) => {
      const b = writeBatch(db);
      docs.forEach((ds) => b.update(ds.ref, { publisherName: name, keywords: buildNameKeywords(ds.data().name, name) }));
      await b.commit();
    });
    await forEachPage(query(coll(libId, "bds"), where("publisherId", "==", existing.id), orderBy(documentId())), 400, async (docs) => {
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

export async function deletePublisher(libId, pub) {
  const used = await getDocs(query(coll(libId, "bds"), where("publisherId", "==", pub.id), limit(1)));
  if ((pub.collectionCount || 0) > 0 || !used.empty) {
    throw new Error("Cet éditeur a encore des collections ou des albums. Supprimez-les ou changez leur éditeur d’abord.");
  }
  const b = writeBatch(db);
  b.delete(ref(libId, "publishers", pub.id));
  b.set(statsRef(libId), statsWrite({ publisherCount: -1 }), { merge: true });
  await commitSoon(b);
}

// ---------------------------------------------------------------- Import de masse

/** Identifiant stable : réimporter les mêmes lignes ne crée pas de doublon. */
export function importId(bd) {
  if (bd.isbn) return "isbn-" + bd.isbn;
  return "h-" + hashStr(normalize(bd.collectionName) + "|" + (bd.numero ?? "") + "|" + normalize(bd.titre));
}

async function existingIds(libId, ids) {
  const found = new Set();
  for (const part of chunk(ids, 30)) {
    const snap = await getDocs(query(coll(libId, "bds"), where(documentId(), "in", part)));
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
export async function importChunk(libId, entries, { timeoutMs = 90000 } = {}) {
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
  const exist = await existingIds(libId, list.map((e) => e.id));
  list = list.filter((e) => {
    if (exist.has(e.id)) { res.skipped.push({ line: e.line, reason: "déjà dans la bédéthèque" }); return false; }
    return true;
  });
  if (!list.length) return res;

  const now = serverTimestamp();
  const batch = writeBatch(db);
  const delta = {};

  const colMap = await findByNames(libId, "collections", list.map((e) => normalize(e.bd.collectionName)));
  for (const e of list) {
    const c = colMap.get(normalize(e.bd.collectionName));
    if (c && !e.bd.publisherName && c.publisherName) e.bd.publisherName = c.publisherName;
  }
  const pubMap = await findByNames(libId, "publishers", list.map((e) => normalize(e.bd.publisherName)));

  const newPubs = new Map(); // lower → {id, name, collections}
  const pubFor = (name) => {
    const lower = normalize(name);
    if (!lower) return null;
    if (pubMap.has(lower)) return pubMap.get(lower);
    if (!newPubs.has(lower)) newPubs.set(lower, { id: doc(coll(libId, "publishers")).id, name: name.trim(), collectionCount: 0, isNew: true });
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
          const c = { id: doc(coll(libId, "collections")).id, name: e.bd.collectionName.trim(), publisherId: pub?.id || null, publisherName: pub?.name || "" };
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
    batch.set(ref(libId, "bds", e.id), { ...bd, createdAt: now, updatedAt: now });
    addStats(delta, bdStatsDelta(bd, 1));
    res.added++;
  }

  for (const t of colTouch.values()) {
    if (t.isNew) {
      batch.set(ref(libId, "collections", t.col.id), {
        name: t.col.name, nameLower: normalize(t.col.name),
        publisherId: t.col.publisherId, publisherName: t.col.publisherName,
        keywords: buildNameKeywords(t.col.name, t.col.publisherName),
        totalVolumes: t.totalVolumes, ownedCount: t.count, notes: "", createdAt: now, updatedAt: now
      });
      addStats(delta, { collectionCount: 1 });
    } else {
      const upd = { ownedCount: increment(t.count), updatedAt: now };
      if (t.totalVolumes) upd.totalVolumes = t.totalVolumes;
      batch.update(ref(libId, "collections", t.col.id), upd);
    }
  }
  for (const p of newPubs.values()) {
    batch.set(ref(libId, "publishers", p.id), {
      name: p.name, nameLower: normalize(p.name), keywords: buildNameKeywords(p.name),
      collectionCount: p.collectionCount, notes: "", createdAt: now, updatedAt: now
    });
    addStats(delta, { publisherCount: 1 });
  }
  for (const [id, n] of pubColInc) batch.update(ref(libId, "publishers", id), { collectionCount: increment(n), updatedAt: now });
  batch.set(statsRef(libId), statsWrite(delta), { merge: true });

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
export async function recomputeCounters(libId, onProgress = () => {}) {
  const bds = coll(libId, "bds");
  onProgress("Comptage des albums…");
  const [nb, nc, np] = await Promise.all([
    getCountFromServer(bds),
    getCountFromServer(coll(libId, "collections")),
    getCountFromServer(coll(libId, "publishers"))
  ]);
  const etat = {};
  for (const k of ETAT_KEYS) etat[k] = (await getCountFromServer(query(bds, where("etat", "==", k)))).data().count;
  const cote = {};
  for (const k of [0, 1, 2, 3]) cote[k] = (await getCountFromServer(query(bds, where("cote", "==", k)))).data().count;
  await setDoc(statsRef(libId), {
    bdCount: nb.data().count, collectionCount: nc.data().count, publisherCount: np.data().count,
    etat, cote, updatedAt: serverTimestamp()
  });

  let done = 0, fixed = 0;
  await forEachPage(query(coll(libId, "collections"), orderBy(documentId())), 200, async (docs) => {
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

  await forEachPage(query(coll(libId, "publishers"), orderBy(documentId())), 200, async (docs) => {
    const counts = await Promise.all(docs.map((ds) => getCountFromServer(query(coll(libId, "collections"), where("publisherId", "==", ds.id)))));
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
