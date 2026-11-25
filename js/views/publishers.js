import { listPublishers, getPublisher, savePublisher, deletePublisher, listCollections } from "../db.js";
import { publisherRow, collectionRow, emptyState, createPager, spinner } from "../components.js";
import { PUBLISHER_SORTS } from "../constants.js";
import { esc, debounce, fmtInt } from "../utils.js";
import { icon, confirmDialog, toast, errorHtml } from "../ui.js";

export async function renderList(ctx) {
  ctx.setTitle("Éditeurs");
  if (!ctx.readOnly) ctx.setFab({ label: "Nouvel éditeur", href: "editeur/new" });
  const st = { q: ctx.query.get("q") || "", sort: ctx.query.get("sort") || "nom" };
  ctx.render(`
    <div class="toolbar">
      <form class="search" role="search">${icon("search")}
        <input type="search" name="q" value="${esc(st.q)}" placeholder="Nom de l’éditeur" aria-label="Rechercher un éditeur" autocomplete="off"></form>
      <div class="filters">
        <label class="select"><span class="sr-only">Trier par</span>
          <select name="sort">${PUBLISHER_SORTS.map((s) => `<option value="${s.key}" ${s.key === st.sort ? "selected" : ""}>${esc(s.label)}</option>`).join("")}</select></label>
      </div>
    </div>
    <div class="list" data-list></div>`);
  const list = ctx.el.querySelector("[data-list]");
  let pager;
  function reload() {
    pager?.destroy();
    list.innerHTML = "";
    const p = new URLSearchParams();
    if (st.q) p.set("q", st.q);
    if (st.sort !== "nom") p.set("sort", st.sort);
    history.replaceState(null, "", ctx.link("editeurs") + (p.toString() ? "?" + p : ""));
    pager = createPager({
      list,
      fetchPage: (cursor) => listPublishers(ctx.uid, { q: st.q, sort: st.sort, cursor }),
      render: (p) => publisherRow(p, ctx.link(`editeur/${p.id}`)),
      empty: () => st.q ? emptyState("Aucun éditeur ne correspond") : emptyState("Pas encore d’éditeur", ctx.readOnly ? "" : "Ils se créent tout seuls quand vous ajoutez des albums.")
    });
  }
  ctx.onCleanup(() => pager?.destroy());
  const form = ctx.el.querySelector(".search");
  const input = form.elements.q;
  input.addEventListener("input", debounce(() => { st.q = input.value.trim(); reload(); }, 350));
  form.onsubmit = (e) => { e.preventDefault(); input.blur(); };
  ctx.el.querySelector("[name=sort]").onchange = (e) => { st.sort = e.target.value; reload(); };
  reload();
}

export async function renderDetail(ctx) {
  const [id] = ctx.params;
  ctx.setTitle("Éditeur", { back: "editeurs" });
  ctx.render(spinner());
  const pub = await getPublisher(ctx.uid, id);
  if (!ctx.alive()) return;
  if (!pub) return ctx.render(emptyState("Cet éditeur n’existe plus", "", `<a class="btn btn-primary" href="${ctx.link("editeurs")}">Voir les éditeurs</a>`));
  ctx.setTitle(pub.name, { back: "editeurs" });
  if (!ctx.readOnly) ctx.setActions(`<a class="icon-btn" href="${ctx.link(`editeur/${id}/edit`)}" aria-label="Modifier l’éditeur">${icon("edit")}</a>`);
  const n = pub.collectionCount || 0;
  ctx.render(`
    <div class="col-head">
      <p class="big-line"><strong>${fmtInt(n)}</strong> collection${n > 1 ? "s" : ""} chez cet éditeur</p>
      <a class="btn btn-ghost" href="${ctx.link(`bds?pub=${id}`)}">${icon("books")}Voir tous ses albums</a>
    </div>
    ${pub.notes ? `<p class="prose">${esc(pub.notes)}</p>` : ""}
    <h2 class="block-title">Collections</h2>
    <div class="list" data-list></div>
    <div data-after></div>`);
  const pager = createPager({
    list: ctx.el.querySelector("[data-list]"),
    fetchPage: (cursor) => listCollections(ctx.uid, { publisherId: id, cursor }),
    render: (c) => collectionRow(c, ctx.link(`collection/${c.id}`)),
    empty: () => emptyState("Aucune collection chez cet éditeur")
  });
  ctx.onCleanup(() => pager.destroy());

  if (!ctx.readOnly) {
    const after = ctx.el.querySelector("[data-after]");
    after.innerHTML = `<div class="row-actions danger-zone"><button class="btn btn-danger-ghost" type="button">${icon("trash")}Supprimer l’éditeur</button></div>`;
    after.querySelector("button").onclick = async () => {
      if (!(await confirmDialog(`L’éditeur « ${pub.name} » sera supprimé.`, { title: "Supprimer l’éditeur ?", ok: "Supprimer", danger: true }))) return;
      try {
        await deletePublisher(ctx.uid, pub);
        toast("Éditeur supprimé");
        ctx.go("editeurs");
      } catch (e) {
        after.insertAdjacentHTML("afterbegin", errorHtml(e));
      }
    };
  }
}

export async function renderForm(ctx) {
  const id = ctx.params[0] || null;
  ctx.setTitle(id ? "Modifier l’éditeur" : "Nouvel éditeur", { back: id ? `editeur/${id}` : "editeurs" });
  let pub = null;
  if (id) {
    ctx.render(spinner());
    pub = await getPublisher(ctx.uid, id);
    if (!ctx.alive()) return;
    if (!pub) return ctx.render(emptyState("Cet éditeur n’existe plus"));
  }
  ctx.render(`<form class="form">
    <label class="field"><span>Nom</span><input name="name" required value="${esc(pub?.name)}" autocomplete="off"></label>
    <label class="field"><span>Notes</span><textarea name="notes" rows="3">${esc(pub?.notes)}</textarea></label>
    ${pub ? `<p class="hint">Un changement de nom est reporté sur ses collections et ses albums.</p>` : ""}
    <div data-error></div>
    <div class="form-actions"><button class="btn btn-primary" type="submit">${pub ? "Enregistrer" : "Créer l’éditeur"}</button></div>
  </form>`);
  const form = ctx.el.querySelector("form");
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector("[type=submit]");
    btn.disabled = true;
    try {
      const newId = await savePublisher(ctx.uid, { name: form.elements.name.value, notes: form.elements.notes.value }, pub);
      toast(pub ? "Éditeur enregistré" : "Éditeur créé");
      ctx.go(`editeur/${newId}`);
    } catch (err) {
      ctx.el.querySelector("[data-error]").innerHTML = errorHtml(err);
      btn.disabled = false;
    }
  };
}
