export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
}

/** Minuscules, sans accents ni ponctuation : sert aux tris et à la recherche. */
export function normalize(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function slug(s) {
  return normalize(s).replace(/ /g, "-").slice(0, 80);
}

/** Petit hachage stable (FNV-1a), en base 36. */
export function hashStr(s) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822507);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

const STOP = new Set(["le", "la", "les", "de", "des", "du", "un", "une", "et", "en", "au", "aux", "the", "of", "and", "a", "l", "d"]);
const KW_MAX = 15; // longueur maximale d'un préfixe indexé

function addPrefixes(set, text) {
  for (const w of normalize(text).split(" ")) {
    if (w.length < 2 || STOP.has(w)) continue;
    const max = Math.min(w.length, KW_MAX);
    for (let i = 2; i <= max; i++) set.add(w.slice(0, i));
  }
}

/**
 * Mots-clés d'une BD : préfixes (2 à 15 lettres) des mots du titre, de la série,
 * de l'éditeur et des auteurs, plus l'ISBN et l'année. Permet une recherche
 * « commence par » sur tous ces champs avec une seule requête array-contains.
 */
export function buildKeywords(bd) {
  const set = new Set();
  addPrefixes(set, [bd.titre, bd.collectionName, bd.publisherName, bd.scenariste, bd.dessinateur, bd.coloriste, bd.auteurs].filter(Boolean).join(" "));
  if (bd.isbn) set.add(bd.isbn);
  if (bd.annee) set.add(String(bd.annee));
  return [...set].slice(0, 400);
}

export function buildNameKeywords(...texts) {
  const set = new Set();
  addPrefixes(set, texts.filter(Boolean).join(" "));
  return [...set].slice(0, 200);
}

/** Découpe une recherche en jetons comparables aux mots-clés. */
export function searchTokens(q, isbnNormalizer) {
  const raw = String(q ?? "").trim();
  if (!raw) return [];
  const compact = raw.replace(/[\s-]/g, "");
  if (/^(\d{9}[\dXx]|\d{13})$/.test(compact) && isbnNormalizer) return [isbnNormalizer(compact)];
  return normalize(raw)
    .split(" ")
    .filter((w) => w.length >= 2 && !STOP.has(w))
    .map((w) => (/^\d{13}$/.test(w) ? w : w.slice(0, KW_MAX)));
}

export function seriesSortKey(collectionName, numero, titleLower) {
  if (!collectionName) return "~|" + (titleLower || "");
  const n = Number.isFinite(numero) ? String(numero).padStart(5, "0") : "99999";
  return normalize(collectionName) + "|" + n + "|" + (titleLower || "");
}

export function parseIntSafe(v) {
  if (v === null || v === undefined || v === "") return null;
  const m = String(v).match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

export function parseYear(v) {
  const m = String(v ?? "").match(/(1[89]\d\d|20\d\d)/);
  return m ? parseInt(m[1], 10) : null;
}

/** Niveau de cote depuis un texte libre : « fortement coté », « moyenne », « 2 »… → 0 à 3. */
export function parseCote(v) {
  const n = normalize(v);
  if (!n) return 0;
  if (/^[0-3]$/.test(n)) return +n;
  if (/^(pas|non|aucun|aucune|nc|sans)/.test(n) || n.includes("pas cote")) return 0;
  if (/fort|eleve|haut|rare|tres/.test(n)) return 3;
  if (/moyen|moderee|modere/.test(n)) return 2;
  if (/faibl|peu|basse|bas\b|legere/.test(n)) return 1;
  return 0;
}

/** Accepte JJ/MM/AAAA, AAAA-MM-JJ, MM/AAAA, AAAA → "AAAA-MM-JJ" (triable). */
export function parseDate(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? (parseInt(m[3], 10) > 50 ? "19" : "20") + m[3] : m[3];
    return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  m = s.match(/^(\d{1,2})[/.-](\d{4})$/);
  if (m) return `${m[2]}-${m[1].padStart(2, "0")}-01`;
  m = s.match(/^(\d{4})$/);
  if (m) return `${m[1]}-01-01`;
  return null;
}

export function parseBool(v) {
  return /^(oui|o|yes|y|1|x|vrai|true|eo)$/i.test(String(v ?? "").trim());
}

const intFmt = new Intl.NumberFormat("fr-FR");
export const fmtInt = (n) => intFmt.format(n || 0);
export function fmtDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return d && m ? `${d}/${m}/${y}` : iso;
}
export const todayIso = () => new Date().toISOString().slice(0, 10);

export function plural(n, one, many) {
  return `${fmtInt(n)} ${n > 1 ? many : one}`;
}

export function debounce(fn, ms = 300) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

const PH_COLORS = ["var(--blue)", "var(--red)", "var(--yellow)", "var(--green)", "var(--violet)"];
export function hashColor(s) {
  let h = 0;
  for (const c of String(s || "")) h = (h * 31 + c.charCodeAt(0)) | 0;
  return PH_COLORS[Math.abs(h) % PH_COLORS.length];
}

/** "1, 2, 3, 5, 7, 8" → "1–3, 5, 7–8" */
export function compressRanges(nums) {
  const out = [];
  let start = null, prev = null;
  for (const n of nums) {
    if (start === null) { start = prev = n; continue; }
    if (n === prev + 1) { prev = n; continue; }
    out.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = prev = n;
  }
  if (start !== null) out.push(start === prev ? `${start}` : `${start}–${prev}`);
  return out.join(", ");
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
