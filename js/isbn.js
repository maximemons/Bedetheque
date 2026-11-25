import { parseYear } from "./utils.js";

export function cleanIsbn(s) {
  return String(s ?? "").toUpperCase().replace(/[^0-9X]/g, "");
}

export function isValidIsbn13(s) {
  if (!/^\d{13}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += +s[i] * (i % 2 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === +s[12];
}

export function isValidIsbn10(s) {
  if (!/^\d{9}[\dX]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (s[i] === "X" ? 10 : +s[i]) * (10 - i);
  return sum % 11 === 0;
}

function isbn10to13(s) {
  const core = "978" + s.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += +core[i] * (i % 2 ? 3 : 1);
  return core + ((10 - (sum % 10)) % 10);
}

/** Toujours stocké en ISBN-13 (sans tirets). Un ISBN-10 valide est converti. */
export function normalizeIsbn(s) {
  const c = cleanIsbn(s);
  if (c.length === 10 && isValidIsbn10(c)) return isbn10to13(c);
  return c;
}

export function isValidIsbn(s) {
  const c = cleanIsbn(s);
  return isValidIsbn13(c) || isValidIsbn10(c);
}

/** Un code-barres scanné est-il un ISBN de livre ? (EAN-13 en 978/979) */
export function isBookEan(s) {
  return /^97[89]\d{10}$/.test(s) && isValidIsbn13(s);
}

export function formatIsbn(s) {
  return /^\d{13}$/.test(s) ? `${s.slice(0, 3)}-${s.slice(3, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12)}` : s;
}

/**
 * Repère série et tome dans un titre du type
 * « Astérix - Tome 12 - Astérix aux jeux olympiques » ou « Les Schtroumpfs T3 ».
 */
export function parseSeriesTitle(t) {
  if (!t) return {};
  const m = String(t).match(/^(.+?)[\s,:–—-]*(?:\btome\b|\bt\.?|\bvol(?:ume)?\.?|n°|\bno\.|#)\s*(\d{1,4})\b\s*\)?\s*(?:[-–—:.,]\s*(.+))?$/i);
  if (!m) return {};
  return {
    serie: m[1].trim().replace(/[\s(,:–—-]+$/, ""),
    numero: parseInt(m[2], 10),
    titre: (m[3] || "").trim()
  };
}

async function fetchJson(url, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function fromGoogleBooks(isbn) {
  const d = await fetchJson(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}&maxResults=1`);
  const v = d?.items?.[0]?.volumeInfo;
  if (!v) return null;
  let cover = v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail || "";
  cover = cover.replace(/^http:/, "https:").replace("&edge=curl", "");
  return {
    source: "Google Books",
    titre: v.title || "",
    sousTitre: v.subtitle || "",
    auteurs: v.authors || [],
    editeur: v.publisher || "",
    annee: parseYear(v.publishedDate),
    pages: v.pageCount || null,
    couverture: cover,
    resume: v.description || ""
  };
}

async function fromOpenLibrary(isbn) {
  const d = await fetchJson(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
  const b = d?.[`ISBN:${isbn}`];
  if (!b) return null;
  return {
    source: "Open Library",
    titre: b.title || "",
    sousTitre: b.subtitle || "",
    auteurs: (b.authors || []).map((a) => a.name),
    editeur: b.publishers?.[0]?.name || "",
    annee: parseYear(b.publish_date),
    pages: b.number_of_pages || null,
    couverture: b.cover?.large || b.cover?.medium || "",
    resume: typeof b.notes === "string" ? b.notes : ""
  };
}

function probeImage(url, ms = 6000) {
  return new Promise((resolve) => {
    const img = new Image();
    const t = setTimeout(() => resolve(false), ms);
    img.onload = () => { clearTimeout(t); resolve(img.naturalWidth > 10); };
    img.onerror = () => { clearTimeout(t); resolve(false); };
    img.referrerPolicy = "no-referrer";
    img.src = url;
  });
}

/**
 * Cherche les infos d'un album en sources ouvertes (Google Books, Open Library).
 * Retourne null si rien n'est trouvé.
 */
export async function lookupIsbn(raw, { coverProbe = true } = {}) {
  const isbn = normalizeIsbn(raw);
  if (!isValidIsbn13(isbn)) return null;
  const [g, o] = await Promise.all([fromGoogleBooks(isbn), fromOpenLibrary(isbn)]);
  const srcs = [g, o].filter(Boolean);
  const pick = (k) => srcs.map((s) => s[k]).find((v) => (Array.isArray(v) ? v.length : v)) ?? null;

  let couverture = o?.couverture || g?.couverture || "";
  if (!couverture && coverProbe) {
    const ol = `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`;
    if (await probeImage(ol)) couverture = ol;
  }
  if (!srcs.length && !couverture) return null;

  const titreBrut = pick("titre") || "";
  const sous = pick("sousTitre") || "";
  const parsed = parseSeriesTitle(titreBrut) ;
  let titre = parsed.titre || (parsed.serie ? "" : titreBrut);
  if (!titre && sous) titre = sous;
  if (!titre) titre = titreBrut;

  const auteurs = pick("auteurs") || [];
  return {
    isbn,
    sources: srcs.map((s) => s.source),
    titre,
    collectionName: parsed.serie || "",
    numero: parsed.numero ?? null,
    publisherName: pick("editeur") || "",
    scenariste: auteurs[0] || "",
    dessinateur: auteurs[1] || "",
    auteurs: auteurs.slice(2).join(", "),
    annee: pick("annee"),
    pages: pick("pages"),
    couverture,
    resume: pick("resume") || ""
  };
}
