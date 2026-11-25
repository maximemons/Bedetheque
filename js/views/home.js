import { getStats, latestPurchases, latestAdded, collectionsToComplete } from "../db.js";
import { bdTile, collectionRow, emptyState, spinner } from "../components.js";
import { DEFAULT_HOME, ETATS, COTES } from "../constants.js";
import { esc, fmtInt, fmtDate } from "../utils.js";
import { errorHtml } from "../ui.js";

export async function render(ctx) {
  ctx.setTitle(ctx.readOnly ? "Bédéthèque partagée" : "Ma bédéthèque");
  if (!ctx.readOnly) ctx.setFab({ label: "Ajouter une BD", href: "bd/new" });

  const home = { ...DEFAULT_HOME, ...(ctx.profile?.home || {}) };
  const widgets = (home.widgets || DEFAULT_HOME.widgets).filter((w) => w.on).map((w) => w.id);
  const n = home.recentCount || 8;

  ctx.render(`<div class="home">${widgets.map((w) => `<section class="block" data-w="${w}">${spinner()}</section>`).join("")}</div>
    ${widgets.length ? "" : emptyState("L’accueil est vide", "Choisissez les blocs à afficher dans Mon compte.", ctx.readOnly ? "" : `<a class="btn btn-primary" href="${ctx.link("compte")}">Régler l’accueil</a>`)}`);

  let stats = null;
  const needStats = widgets.some((w) => ["counts", "cotes", "states"].includes(w));
  if (needStats) {
    try { stats = await getStats(ctx.uid); } catch (e) { stats = { error: e }; }
  }
  if (!ctx.alive()) return;

  const fill = (id, html) => {
    const el = ctx.el.querySelector(`[data-w="${id}"]`);
    if (el && ctx.alive()) el.innerHTML = html;
  };

  for (const w of widgets) {
    const run = WIDGETS[w];
    if (!run) continue;
    run(ctx, stats, n).then((html) => fill(w, html)).catch((e) => fill(w, errorHtml(e)));
  }
}

const WIDGETS = {
  async counts(ctx, s) {
    if (s.error) throw s.error;
    if (!s.bdCount && !ctx.readOnly) {
      return emptyState("Votre bédéthèque est vide", "Scannez le code-barres d’un album pour l’ajouter.",
        `<a class="btn btn-primary" href="${ctx.link("bd/new?scan=1")}">Scanner un album</a>`);
    }
    return `<div class="counts">
      <a class="count" href="${ctx.link("bds")}"><strong>${fmtInt(s.bdCount)}</strong><span>BD</span></a>
      <a class="count" href="${ctx.link("collections")}"><strong>${fmtInt(s.collectionCount)}</strong><span>collection${s.collectionCount > 1 ? "s" : ""}</span></a>
      <a class="count" href="${ctx.link("editeurs")}"><strong>${fmtInt(s.publisherCount)}</strong><span>éditeur${s.publisherCount > 1 ? "s" : ""}</span></a>
    </div>`;
  },

  async cotes(ctx, s) {
    if (s.error) throw s.error;
    const parts = COTES.map((c) => ({ ...c, n: Math.max(0, s.cote?.[c.key] || 0) })).filter((c) => c.n);
    if (!parts.length) return `<h2 class="block-title">Par cote</h2><p class="muted">Aucun album pour l’instant.</p>`;
    return `<h2 class="block-title">Par cote</h2>
      <div class="stack-bar">${parts.map((c) => `<span class="cote-bg-${c.key}" style="flex:${c.n}" title="${esc(c.label)} : ${fmtInt(c.n)}"></span>`).join("")}</div>
      <ul class="legend">${[...parts].reverse().map((c) => `<li><i class="cote-bg-${c.key}"></i><a href="${ctx.link(`bds?cote=${c.key}`)}">${esc(c.label)}</a><span>${fmtInt(c.n)}</span></li>`).join("")}</ul>`;
  },

  async states(ctx, s) {
    if (s.error) throw s.error;
    const total = ETATS.reduce((a, e) => a + Math.max(0, s.etat?.[e.key] || 0), 0);
    if (!total) return `<h2 class="block-title">Par état</h2><p class="muted">Aucun album pour l’instant.</p>`;
    const parts = ETATS.map((e) => ({ ...e, n: Math.max(0, s.etat?.[e.key] || 0) })).filter((e) => e.n);
    return `<h2 class="block-title">Par état</h2>
      <div class="stack-bar">${parts.map((e) => `<span class="etat-bg-${e.key}" style="flex:${e.n}" title="${esc(e.label)} : ${fmtInt(e.n)}"></span>`).join("")}</div>
      <ul class="legend">${parts.map((e) => `<li><i class="etat-bg-${e.key}"></i>${esc(e.label)}<span>${fmtInt(e.n)}</span></li>`).join("")}</ul>`;
  },

  async lastPurchases(ctx, s, n) {
    const items = await latestPurchases(ctx.uid, n);
    if (!items.length) return `<h2 class="block-title">Derniers achats</h2><p class="muted">Renseignez la date d’achat de vos albums pour les voir ici.</p>`;
    return `<h2 class="block-title">Derniers achats</h2>
      <div class="shelf">${items.map((bd) => `<div class="shelf-item">${bdTile(bd, ctx.link(`bd/${bd.id}`))}<span class="shelf-date">${fmtDate(bd.dateAchat)}</span></div>`).join("")}</div>`;
  },

  async lastAdded(ctx, s, n) {
    const items = await latestAdded(ctx.uid, n);
    if (!items.length) return `<h2 class="block-title">Derniers ajouts</h2><p class="muted">Aucun album pour l’instant.</p>`;
    return `<h2 class="block-title">Derniers ajouts</h2>
      <div class="shelf">${items.map((bd) => `<div class="shelf-item">${bdTile(bd, ctx.link(`bd/${bd.id}`))}</div>`).join("")}</div>`;
  },

  async inProgress(ctx, s, n) {
    const items = await collectionsToComplete(ctx.uid, Math.min(n, 6));
    if (!items.length) return `<h2 class="block-title">Collections à compléter</h2><p class="muted">Indiquez le nombre de tomes de vos séries pour suivre ce qu’il vous manque.</p>`;
    return `<h2 class="block-title">Collections à compléter</h2>
      <div class="list">${items.map((c) => collectionRow(c, ctx.link(`collection/${c.id}`))).join("")}</div>`;
  }
};
