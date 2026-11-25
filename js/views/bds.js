import { listBds, getBd, deleteBd, getCollectionDoc, getPublisher, findBdByIsbn, getCoverPhoto } from "../db.js";
import { bdTile, bdRow, coverHtml, etatBadge, coteMeter, emptyState, createPager, spinner } from "../components.js";
import { BD_SORTS, ETATS, COTES, etatLabel, coteLabel } from "../constants.js";
import { esc, debounce, fmtDate, fmtInt } from "../utils.js";
import { icon, confirmDialog, toast, errorHtml } from "../ui.js";
import { formatIsbn } from "../isbn.js";
import { scanIsbn } from "../scanner.js";

const VIEW_KEY = "bdt:libraryView";

export async function renderList(ctx) {
  ctx.setTitle(ctx.readOnly ? "BD" : "Mes BD");
  if (!ctx.readOnly) ctx.setFab({ label: "Ajouter", href: "bd/new" });

  const q = ctx.query;
  const st = {
    q: q.get("q") || "",
    sort: q.get("sort") || "serie",
    dir: q.get("dir") || "",
    etat: q.get("etat") || "",
    cote: q.get("cote") || "",
    col: q.get("col") || "",
    pub: q.get("pub") || "",
    view: localStorage.getItem(VIEW_KEY) || "grid"
  };

  ctx.render(`
    <div class="toolbar">
      <form class="search" role="search">
        ${icon("search")}
        <input type="search" name="q" value="${esc(st.q)}" placeholder="Titre, série, auteur, éditeur, ISBN…" aria-label="Rechercher une BD" autocomplete="off">
        <button class="icon-btn" type="button" data-scan aria-label="Scanner un ISBN">${icon("scan")}</button>
      </form>
      <div class="filters">
        <label class="select"><span class="sr-only">Trier par</span>
          <select name="sort">${BD_SORTS.map((s) => `<option value="${s.key}" ${s.key === st.sort ? "selected" : ""}>${esc(s.label)}</option>`).join("")}</select></label>
        <button class="icon-btn" type="button" data-dir aria-label="Inverser l’ordre">${icon("sort")}</button>
        <label class="select"><span class="sr-only">État</span>
          <select name="etat"><option value="">Tous états</option>${ETATS.map((e) => `<option value="${e.key}" ${e.key === st.etat ? "selected" : ""}>${esc(e.label)}</option>`).join("")}</select></label>
        <label class="select"><span class="sr-only">Cote</span>
          <select name="cote"><option value="">Toutes cotes</option>${COTES.map((c) => `<option value="${c.key}" ${String(c.key) === st.cote ? "selected" : ""}>${esc(c.label)}</option>`).join("")}</select></label>
        <button class="icon-btn" type="button" data-view aria-label="Changer l’affichage">${icon(st.view === "grid" ? "list" : "grid")}</button>
      </div>
      <div class="chips" data-chips></div>
      <p class="result-count muted" data-count></p>
    </div>
    <div class="${st.view === "grid" ? "grid" : "list"}" data-list></div>`);

  const list = ctx.el.querySelector("[data-list]");
  const countEl = ctx.el.querySelector("[data-count]");
  let pager = null;

  // Filtres « collection » et « éditeur » venus d'un lien
  const chips = ctx.el.querySelector("[data-chips]");
  const renderChips = async () => {
    const parts = [];
    if (st.col) {
      const c = await getCollectionDoc(ctx.uid, st.col).catch(() => null);
      parts.push(`<button class="chip" type="button" data-clear="col">Collection : ${esc(c?.name || "?")} ${icon("close")}</button>`);
    }
    if (st.pub) {
      const p = await getPublisher(ctx.uid, st.pub).catch(() => null);
      parts.push(`<button class="chip" type="button" data-clear="pub">Éditeur : ${esc(p?.name || "?")} ${icon("close")}</button>`);
    }
    if (!ctx.alive()) return;
    chips.innerHTML = parts.join("");
    chips.querySelectorAll("[data-clear]").forEach((b) => (b.onclick = () => { st[b.dataset.clear] = ""; renderChips(); reload(); }));
  };
  if (st.col || st.pub) renderChips();

  function syncHash() {
    const p = new URLSearchParams();
    for (const k of ["q", "sort", "dir", "etat", "cote", "col", "pub"]) if (st[k] !== "") p.set(k, st[k]);
    const s = p.toString();
    history.replaceState(null, "", ctx.link("bds") + (s ? "?" + s : ""));
  }

  function reload() {
    pager?.destroy();
    list.innerHTML = "";
    countEl.textContent = "";
    syncHash();
    const render = st.view === "grid" ? (bd) => bdTile(bd, ctx.link(`bd/${bd.id}`)) : (bd) => bdRow(bd, ctx.link(`bd/${bd.id}`));
    pager = createPager({
      list,
      fetchPage: (cursor) => listBds(ctx.uid, { q: st.q, sort: st.sort, dir: st.dir || null, etat: st.etat, cote: st.cote, collectionId: st.col || null, publisherId: st.pub || null, cursor }),
      render,
      onCount: (n, done) => { countEl.textContent = st.q || st.etat || st.cote || st.col || st.pub ? `${fmtInt(n)}${done ? "" : "+"} résultat${n > 1 ? "s" : ""}` : ""; },
      empty: () => (st.q || st.etat || st.cote || st.col || st.pub)
        ? emptyState("Aucune BD ne correspond", "Vérifiez l’orthographe ou retirez un filtre.", !ctx.readOnly && /^\d{13}$/.test(st.q) ? `<a class="btn btn-primary" href="${ctx.link(`bd/new?isbn=${st.q}`)}">Ajouter l’ISBN ${esc(st.q)}</a>` : "")
        : emptyState("Pas encore de BD", ctx.readOnly ? "" : "Ajoutez votre premier album.", ctx.readOnly ? "" : `<a class="btn btn-primary" href="${ctx.link("bd/new?scan=1")}">Scanner un album</a>`)
    });
  }
  ctx.onCleanup(() => pager?.destroy());

  const form = ctx.el.querySelector(".search");
  const input = form.elements.q;
  const onSearch = debounce(() => { st.q = input.value.trim(); reload(); }, 350);
  input.addEventListener("input", onSearch);
  form.onsubmit = (e) => { e.preventDefault(); input.blur(); st.q = input.value.trim(); reload(); };

  form.querySelector("[data-scan]").onclick = async () => {
    const isbn = await scanIsbn();
    if (!isbn || !ctx.alive()) return;
    const bd = await findBdByIsbn(ctx.uid, isbn).catch(() => null);
    if (bd) return ctx.go(`bd/${bd.id}`);
    input.value = isbn;
    st.q = isbn;
    reload();
    if (!ctx.readOnly && (await confirmDialog(`L’ISBN ${isbn} n’est pas dans votre bédéthèque. L’ajouter ?`, { title: "Album introuvable", ok: "Ajouter" }))) {
      ctx.go(`bd/new?isbn=${isbn}`);
    }
  };

  const sortSel = ctx.el.querySelector("[name=sort]");
  sortSel.onchange = () => { st.sort = sortSel.value; st.dir = ""; reload(); };
  ctx.el.querySelector("[data-dir]").onclick = () => {
    const def = (BD_SORTS.find((s) => s.key === st.sort) || BD_SORTS[0]).dir;
    const cur = st.dir || def;
    st.dir = cur === "asc" ? "desc" : "asc";
    reload();
  };
  const etatSel = ctx.el.querySelector("[name=etat]");
  etatSel.onchange = () => { st.etat = etatSel.value; reload(); };
  const coteSel = ctx.el.querySelector("[name=cote]");
  coteSel.onchange = () => { st.cote = coteSel.value; reload(); };
  ctx.el.querySelector("[data-view]").onclick = (e) => {
    st.view = st.view === "grid" ? "list" : "grid";
    localStorage.setItem(VIEW_KEY, st.view);
    e.currentTarget.innerHTML = icon(st.view === "grid" ? "list" : "grid");
    list.className = st.view === "grid" ? "grid" : "list";
    reload();
  };

  reload();
}

export async function renderDetail(ctx) {
  const [id] = ctx.params;
  ctx.setTitle("Album", { back: "bds" });
  ctx.render(spinner());
  const bd = await getBd(ctx.uid, id);
  if (!ctx.alive()) return;
  if (!bd) return ctx.render(emptyState("Cet album n’existe plus", "Il a peut-être été supprimé.", `<a class="btn btn-primary" href="${ctx.link("bds")}">Voir les BD</a>`));

  ctx.setTitle(bd.titre, { back: "bds", kicker: bd.collectionName ? `${bd.collectionName}${bd.numero != null ? `, tome ${bd.numero}` : ""}` : "" });
  if (!ctx.readOnly) {
    ctx.setActions(`<a class="icon-btn" href="${ctx.link(`bd/${bd.id}/edit`)}" aria-label="Modifier">${icon("edit")}</a>`);
  }

  const authors = [
    ["Scénario", bd.scenariste], ["Dessin", bd.dessinateur], ["Couleurs", bd.coloriste], ["Auteurs", bd.auteurs]
  ].filter(([, v]) => v);
  const facts = [
    ["Collection", bd.collectionId ? `<a href="${ctx.link(`collection/${bd.collectionId}`)}">${esc(bd.collectionName)}</a>` : ""],
    ["Tome", bd.numero != null ? esc(bd.numero) : ""],
    ["Éditeur", bd.publisherId ? `<a href="${ctx.link(`editeur/${bd.publisherId}`)}">${esc(bd.publisherName)}</a>` : esc(bd.publisherName)],
    ...authors.map(([k, v]) => [k, esc(v)]),
    ["Parution", bd.annee ? esc(bd.annee) : ""],
    ["Pages", bd.pages ? esc(bd.pages) : ""],
    ["ISBN", bd.isbn ? `<span class="mono-num">${esc(formatIsbn(bd.isbn))}</span>` : ""],
    ["Édition", bd.eo ? "Édition originale" : ""]
  ].filter(([, v]) => v);

  ctx.render(`
    <article class="bd-detail">
      <div class="bd-hero">
        ${coverHtml(bd, "cover-lg")}
        <div class="bd-hero-side">
          <div class="badges">
            <div><span class="k">Cote</span><strong>${coteMeter(bd.cote)} ${esc(coteLabel(bd.cote))}</strong></div>
            <div><span class="k">État</span><strong class="etat-line">${bd.etat && bd.etat !== "nc" ? etatBadge(bd.etat) + esc(etatLabel(bd.etat)) : `<span class="muted">Non renseigné</span>`}</strong></div>
          </div>
          ${bd.dateAchat ? `<p class="muted">Acheté le ${fmtDate(bd.dateAchat)}</p>` : ""}
        </div>
      </div>
      <dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>
      ${bd.notes ? `<section class="prose"><h2>Notes</h2><p>${esc(bd.notes).replace(/\n/g, "<br>")}</p></section>` : ""}
      ${bd.resume ? `<section class="prose"><h2>Résumé</h2><p>${esc(bd.resume)}</p></section>` : ""}
      ${ctx.readOnly ? "" : `<div class="row-actions">
        <a class="btn btn-primary" href="${ctx.link(`bd/${bd.id}/edit`)}">${icon("edit")}Modifier</a>
        <button class="btn btn-danger-ghost" type="button" data-del>${icon("trash")}Supprimer</button>
      </div>`}
    </article>`);

  // Photo prise au téléphone : la vignette s'affiche tout de suite, la version nette arrive ensuite.
  if (bd.hasCoverPhoto) {
    getCoverPhoto(ctx.uid, bd.id).then((full) => {
      const img = ctx.el.querySelector(".cover-lg img");
      if (full && img && ctx.alive()) img.src = full;
    }).catch(() => {});
  }

  ctx.el.querySelector("[data-del]")?.addEventListener("click", async () => {
    if (!(await confirmDialog(`« ${bd.titre} » sera retiré de votre bédéthèque.`, { title: "Supprimer cet album ?", ok: "Supprimer", danger: true }))) return;
    try {
      await deleteBd(ctx.uid, bd);
      toast("Album supprimé");
      ctx.go(bd.collectionId ? `collection/${bd.collectionId}` : "bds");
    } catch (e) {
      ctx.el.insertAdjacentHTML("afterbegin", errorHtml(e));
    }
  });
}
