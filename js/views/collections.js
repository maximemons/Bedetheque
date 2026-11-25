import { listCollections, getCollectionDoc, listBdsOfCollection, saveCollection, deleteCollection, suggest, getPublisher } from "../db.js";
import { collectionRow, bdRow, casesBoard, missingText, emptyState, createPager, spinner, miniCases } from "../components.js";
import { COLLECTION_SORTS } from "../constants.js";
import { esc, debounce, fmtInt, fmtEuro } from "../utils.js";
import { icon, confirmDialog, toast, errorHtml } from "../ui.js";

export async function renderList(ctx) {
  ctx.setTitle("Collections");
  if (!ctx.readOnly) ctx.setFab({ label: "Nouvelle collection", href: "collection/new" });
  const st = { q: ctx.query.get("q") || "", sort: ctx.query.get("sort") || "nom", pub: ctx.query.get("pub") || "" };

  ctx.render(`
    <div class="toolbar">
      <form class="search" role="search">
        ${icon("search")}
        <input type="search" name="q" value="${esc(st.q)}" placeholder="Nom de la série ou de l’éditeur" aria-label="Rechercher une collection" autocomplete="off">
      </form>
      <div class="filters">
        <label class="select"><span class="sr-only">Trier par</span>
          <select name="sort">${COLLECTION_SORTS.map((s) => `<option value="${s.key}" ${s.key === st.sort ? "selected" : ""}>${esc(s.label)}</option>`).join("")}</select></label>
      </div>
      <div class="chips" data-chips></div>
    </div>
    <div class="list" data-list></div>`);

  const list = ctx.el.querySelector("[data-list]");
  let pager;
  const chips = ctx.el.querySelector("[data-chips]");
  if (st.pub) {
    getPublisher(ctx.uid, st.pub).then((p) => {
      if (!ctx.alive()) return;
      chips.innerHTML = `<button class="chip" type="button">Éditeur : ${esc(p?.name || "?")} ${icon("close")}</button>`;
      chips.firstElementChild.onclick = () => { st.pub = ""; chips.innerHTML = ""; reload(); };
    }).catch(() => {});
  }

  function reload() {
    pager?.destroy();
    list.innerHTML = "";
    const p = new URLSearchParams();
    for (const k of ["q", "sort", "pub"]) if (st[k]) p.set(k, st[k]);
    history.replaceState(null, "", ctx.link("collections") + (p.toString() ? "?" + p : ""));
    pager = createPager({
      list,
      fetchPage: (cursor) => listCollections(ctx.uid, { q: st.q, sort: st.sort, publisherId: st.pub || null, cursor }),
      render: (c) => collectionRow(c, ctx.link(`collection/${c.id}`)),
      empty: () => st.q || st.pub
        ? emptyState("Aucune collection ne correspond", "Essayez avec le début d’un autre mot du nom.")
        : emptyState("Pas encore de collection", ctx.readOnly ? "" : "Une collection se crée toute seule quand vous ajoutez un album d’une série.")
    });
  }
  ctx.onCleanup(() => pager?.destroy());

  const form = ctx.el.querySelector(".search");
  const input = form.elements.q;
  input.addEventListener("input", debounce(() => { st.q = input.value.trim(); reload(); }, 350));
  form.onsubmit = (e) => { e.preventDefault(); input.blur(); };
  const sortSel = ctx.el.querySelector("[name=sort]");
  sortSel.onchange = () => { st.sort = sortSel.value; reload(); };
  reload();
}

export async function renderDetail(ctx) {
  const [id] = ctx.params;
  ctx.setTitle("Collection", { back: "collections" });
  ctx.render(spinner());
  const col = await getCollectionDoc(ctx.uid, id);
  if (!ctx.alive()) return;
  if (!col) return ctx.render(emptyState("Cette collection n’existe plus", "", `<a class="btn btn-primary" href="${ctx.link("collections")}">Voir les collections</a>`));

  ctx.setTitle(col.name, { back: "collections", kicker: col.publisherName || "" });
  if (!ctx.readOnly) ctx.setActions(`<a class="icon-btn" href="${ctx.link(`collection/${id}/edit`)}" aria-label="Modifier la collection">${icon("edit")}</a>`);
  if (!ctx.readOnly) ctx.setFab({ label: "Ajouter un tome", href: `bd/new?col=${id}` });

  ctx.render(`<div class="col-head">
      ${col.publisherId ? `<p>Éditeur : <a href="${ctx.link(`editeur/${col.publisherId}`)}">${esc(col.publisherName)}</a></p>` : ""}
      ${miniCases(col.ownedCount || 0, col.totalVolumes)}
      ${col.totalVolumes ? "" : `<p class="hint">Nombre de tomes de la série non renseigné${ctx.readOnly ? "" : ` : <a href="${ctx.link(`collection/${id}/edit`)}">l’indiquer</a> pour voir les manquants`}.</p>`}
    </div>
    <div data-body>${spinner()}</div>`);

  const bds = await listBdsOfCollection(ctx.uid, id);
  if (!ctx.alive()) return;
  const byNum = new Map();
  const others = [];
  for (const bd of bds) {
    if (Number.isInteger(bd.numero) && bd.numero > 0 && !byNum.has(bd.numero)) byNum.set(bd.numero, bd);
    else others.push(bd);
  }
  const cote = bds.reduce((a, b) => a + (b.cote || 0), 0);
  const nextMissing = (() => { for (let n = 1; n <= (col.totalVolumes || 0); n++) if (!byNum.has(n)) return n; return null; })();
  if (!ctx.readOnly && nextMissing) ctx.setFab({ label: `Ajouter le tome ${nextMissing}`, href: `bd/new?col=${id}&num=${nextMissing}` });

  const body = ctx.el.querySelector("[data-body]");
  body.innerHTML = `
    ${casesBoard(col.totalVolumes, byNum, (bd) => ctx.link(`bd/${bd.id}`), ctx.readOnly ? null : (n) => ctx.link(`bd/new?col=${id}&num=${n}`))}
    ${missingText(col.totalVolumes, byNum)}
    ${cote ? `<p class="muted">Cote de la collection : ${fmtEuro(cote)}</p>` : ""}
    ${col.notes ? `<p class="prose">${esc(col.notes)}</p>` : ""}
    <h2 class="block-title">${fmtInt(bds.length)} album${bds.length > 1 ? "s" : ""}</h2>
    <div class="list">${bds.map((bd) => bdRow(bd, ctx.link(`bd/${bd.id}`))).join("")}</div>
    ${bds.length ? "" : emptyState("Aucun album dans cette collection", ctx.readOnly ? "" : "Ajoutez le premier tome.")}
    ${ctx.readOnly ? "" : `<div class="row-actions danger-zone">
      <a class="btn btn-ghost" href="${ctx.link(`collection/${id}/edit`)}">${icon("edit")}Modifier</a>
      <button class="btn btn-danger-ghost" type="button" data-del>${icon("trash")}Supprimer la collection</button></div>`}`;

  body.querySelector("[data-del]")?.addEventListener("click", async () => {
    const n = col.ownedCount || bds.length;
    const ok = await confirmDialog(
      n ? `La collection « ${col.name} » et ses ${n} album${n > 1 ? "s" : ""} seront supprimés.` : `La collection « ${col.name} » sera supprimée.`,
      { title: "Supprimer la collection ?", ok: "Tout supprimer", danger: true });
    if (!ok) return;
    try {
      await deleteCollection(ctx.uid, col, (k) => toast(`${k} album${k > 1 ? "s" : ""} supprimé${k > 1 ? "s" : ""}…`));
      toast("Collection supprimée");
      ctx.go("collections");
    } catch (e) {
      body.insertAdjacentHTML("afterbegin", errorHtml(e));
    }
  });
}

export async function renderForm(ctx) {
  const id = ctx.params[0] || null;
  ctx.setTitle(id ? "Modifier la collection" : "Nouvelle collection", { back: id ? `collection/${id}` : "collections" });
  let col = null;
  if (id) {
    ctx.render(spinner());
    col = await getCollectionDoc(ctx.uid, id);
    if (!ctx.alive()) return;
    if (!col) return ctx.render(emptyState("Cette collection n’existe plus"));
  }
  ctx.render(`<form class="form">
      <label class="field"><span>Nom de la série</span><input name="name" required value="${esc(col?.name)}" autocomplete="off"></label>
      <label class="field"><span>Éditeur</span><input name="publisherName" list="dl-pub" value="${esc(col?.publisherName)}" autocomplete="off"><datalist id="dl-pub"></datalist></label>
      <label class="field"><span>Nombre de tomes de la série</span><input name="totalVolumes" type="number" inputmode="numeric" min="0" value="${esc(col?.totalVolumes)}">
        <small class="hint">Pour savoir combien il vous en manque. Laissez vide si vous ne savez pas.</small></label>
      <label class="field"><span>Notes</span><textarea name="notes" rows="3">${esc(col?.notes)}</textarea></label>
      ${col && col.ownedCount > 0 ? `<p class="hint">Un changement de nom ou d’éditeur est reporté sur les ${fmtInt(col.ownedCount)} albums de la collection.</p>` : ""}
      <div data-error></div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">${col ? "Enregistrer" : "Créer la collection"}</button></div>
    </form>`);
  const form = ctx.el.querySelector("form");
  const pubInput = form.elements.publisherName;
  pubInput.addEventListener("input", debounce(async () => {
    const items = await suggest(ctx.uid, "publishers", pubInput.value).catch(() => []);
    ctx.el.querySelector("#dl-pub").innerHTML = items.map((p) => `<option value="${esc(p.name)}">`).join("");
  }, 300));
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector("[type=submit]");
    btn.disabled = true;
    try {
      const newId = await saveCollection(ctx.uid, {
        name: form.elements.name.value, publisherName: pubInput.value,
        totalVolumes: form.elements.totalVolumes.value, notes: form.elements.notes.value
      }, col);
      toast(col ? "Collection enregistrée" : "Collection créée");
      ctx.go(`collection/${newId}`);
    } catch (err) {
      ctx.el.querySelector("[data-error]").innerHTML = errorHtml(err);
      btn.disabled = false;
    }
  };
}
