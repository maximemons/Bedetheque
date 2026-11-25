import { esc, hashColor, fmtInt, compressRanges } from "./utils.js";
import { etatShort, etatLabel } from "./constants.js";
import { icon, errorHtml } from "./ui.js";

function initials(s) {
  return String(s || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}

export function coverHtml(bd, cls = "") {
  const ph = `<div class="cover-ph" style="--ph:${hashColor(bd.collectionName || bd.titre)}"><span>${esc(initials(bd.collectionName || bd.titre))}</span></div>`;
  const img = bd.couverture
    ? `<img src="${esc(bd.couverture)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">`
    : "";
  return `<div class="cover ${cls}">${ph}${img}</div>`;
}

export function tomeLabel(bd) {
  return bd.numero !== null && bd.numero !== undefined ? `T${bd.numero}` : "";
}

export function etatBadge(key) {
  if (!key || key === "nc") return "";
  return `<span class="etat etat-${esc(key)}" title="${esc(etatLabel(key))}">${esc(etatShort(key))}</span>`;
}

export function bdTile(bd, href) {
  return `<a class="tile" href="${href}">
    ${coverHtml(bd)}
    ${tomeLabel(bd) ? `<span class="tile-num">${esc(tomeLabel(bd))}</span>` : ""}
    <span class="tile-title">${esc(bd.titre)}</span>
    ${bd.collectionName ? `<span class="tile-sub">${esc(bd.collectionName)}</span>` : ""}
  </a>`;
}

export function bdRow(bd, href) {
  const sub = [bd.collectionName && `${bd.collectionName}${bd.numero != null ? `, tome ${bd.numero}` : ""}`, bd.publisherName, bd.annee]
    .filter(Boolean).map(esc).join(" / ");
  return `<a class="row" href="${href}">
    ${coverHtml(bd, "cover-sm")}
    <span class="row-body">
      <span class="row-title">${esc(bd.titre)}</span>
      <span class="row-sub">${sub}</span>
    </span>
    ${etatBadge(bd.etat)}
  </a>`;
}

/** Barre de progression faite de cases, comme une planche : une case par tome. */
export function miniCases(owned, total) {
  if (!total) return `<span class="count-pill">${fmtInt(owned)} album${owned > 1 ? "s" : ""}</span>`;
  const pct = Math.min(100, Math.round((owned / total) * 100));
  const bar = total <= 30
    ? `<span class="mini-cases" aria-hidden="true">${Array.from({ length: total }, (_, i) => `<i class="${i < owned ? "on" : ""}"></i>`).join("")}</span>`
    : `<span class="meter" aria-hidden="true"><span style="width:${pct}%"></span></span>`;
  return `<span class="progress">${bar}<span class="progress-txt">${fmtInt(owned)} / ${fmtInt(total)}</span></span>`;
}

export function collectionRow(c, href) {
  const complete = c.totalVolumes && c.ownedCount >= c.totalVolumes;
  return `<a class="row row-col ${complete ? "is-complete" : ""}" href="${href}">
    <span class="row-body">
      <span class="row-title">${esc(c.name)}${complete ? ` <span class="tag tag-ok">Complète</span>` : ""}</span>
      ${c.publisherName ? `<span class="row-sub">${esc(c.publisherName)}</span>` : ""}
      ${miniCases(c.ownedCount || 0, c.totalVolumes)}
    </span>
  </a>`;
}

export function publisherRow(p, href) {
  const n = p.collectionCount || 0;
  return `<a class="row" href="${href}">
    <span class="row-body">
      <span class="row-title">${esc(p.name)}</span>
      <span class="row-sub">${n ? `${fmtInt(n)} collection${n > 1 ? "s" : ""}` : "Aucune collection"}</span>
    </span>
    <span class="row-count">${fmtInt(n)}</span>
  </a>`;
}

/**
 * Planche des tomes d'une collection : une case par numéro, pleine si on l'a.
 * bdsByNum : Map numéro → album ; linkFor(bd) → href ; addFor(n) → href (ou null)
 */
export function casesBoard(total, bdsByNum, linkFor, addFor) {
  const maxNum = Math.max(total || 0, ...bdsByNum.keys(), 0);
  if (!maxNum) return "";
  if (maxNum > 400) return "";
  const cells = [];
  for (let n = 1; n <= maxNum; n++) {
    const bd = bdsByNum.get(n);
    if (bd) cells.push(`<a class="case on" href="${linkFor(bd)}" title="${esc(bd.titre)}">${n}</a>`);
    else {
      const href = addFor ? addFor(n) : null;
      cells.push(href ? `<a class="case" href="${href}" title="Ajouter le tome ${n}">${n}</a>` : `<span class="case">${n}</span>`);
    }
  }
  return `<div class="cases" role="list">${cells.join("")}</div>`;
}

export function missingText(total, bdsByNum) {
  if (!total) return "";
  const missing = [];
  for (let n = 1; n <= total; n++) if (!bdsByNum.has(n)) missing.push(n);
  if (!missing.length) return `<p class="ok-line">Collection complète.</p>`;
  return `<p class="missing"><strong>Manquants (${missing.length}) :</strong> ${compressRanges(missing)}</p>`;
}

/** État vide, dans une bulle de BD. */
export function emptyState(title, text = "", action = "") {
  return `<div class="empty">
    <div class="bubble"><p class="bubble-title">${esc(title)}</p>${text ? `<p>${esc(text)}</p>` : ""}</div>
    ${action}
  </div>`;
}

export function spinner() {
  return `<div class="spinner" role="status" aria-label="Chargement"><span></span><span></span><span></span></div>`;
}

/**
 * Liste paginée avec chargement à l'approche du bas de l'écran.
 * fetchPage(cursor) → { items, cursor, done }
 */
export function createPager({ list, fetchPage, render, empty, onCount }) {
  const sentinel = document.createElement("div");
  sentinel.className = "pager-sentinel";
  list.after(sentinel);
  let cursor = null, done = false, loading = false, count = 0, alive = true;

  async function more() {
    if (loading || done || !alive) return;
    loading = true;
    sentinel.innerHTML = spinner();
    try {
      const res = await fetchPage(cursor);
      if (!alive) return;
      cursor = res.cursor;
      done = res.done;
      count += res.items.length;
      list.insertAdjacentHTML("beforeend", res.items.map(render).join(""));
      onCount?.(count, done);
      sentinel.innerHTML = "";
      if (done && count === 0) sentinel.innerHTML = empty();
      else if (!done) {
        // Si la page ne remplit pas l'écran, on continue.
        const r = sentinel.getBoundingClientRect();
        if (r.top < window.innerHeight + 400) setTimeout(more, 0);
      }
    } catch (err) {
      console.error(err);
      sentinel.innerHTML = errorHtml(err) + `<button class="btn btn-ghost" type="button" data-retry>${icon("refresh")}Réessayer</button>`;
      sentinel.querySelector("[data-retry]").onclick = () => { sentinel.innerHTML = ""; more(); };
    } finally {
      loading = false;
    }
  }

  const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && more(), { rootMargin: "600px 0px" });
  io.observe(sentinel);
  more();
  return {
    destroy() { alive = false; io.disconnect(); sentinel.remove(); }
  };
}
