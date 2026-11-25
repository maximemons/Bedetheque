import { getBd, saveBd, suggest, findBdByIsbn, getCollectionDoc } from "../db.js";
import { coverHtml, spinner, emptyState } from "../components.js";
import { ETATS } from "../constants.js";
import { esc, debounce, todayIso, parseNumber } from "../utils.js";
import { icon, toast, errorHtml } from "../ui.js";
import { lookupIsbn, normalizeIsbn, isValidIsbn } from "../isbn.js";
import { scanIsbn } from "../scanner.js";

const v = (x) => esc(x ?? "");

export async function render(ctx) {
  const id = ctx.params[0] || null;
  ctx.setTitle(id ? "Modifier l’album" : "Ajouter une BD", { back: id ? `bd/${id}` : "bds" });
  ctx.render(spinner());

  let bd = null;
  if (id) {
    bd = await getBd(ctx.uid, id);
    if (!ctx.alive()) return;
    if (!bd) return ctx.render(emptyState("Cet album n’existe plus"));
  }
  const pre = { etat: "nc", ...(bd || {}) };
  if (!bd) {
    const q = ctx.query;
    if (q.get("isbn")) pre.isbn = q.get("isbn");
    if (q.get("num")) pre.numero = parseInt(q.get("num"), 10);
    if (q.get("col")) {
      const c = await getCollectionDoc(ctx.uid, q.get("col")).catch(() => null);
      if (c) { pre.collectionName = c.name; pre.publisherName = c.publisherName; }
    }
    if (!ctx.alive()) return;
  }

  ctx.render(`
    <form class="form" novalidate>
      <section class="isbn-box">
        <label class="field"><span>ISBN</span>
          <div class="input-group">
            <input name="isbn" inputmode="numeric" autocomplete="off" value="${v(pre.isbn)}" placeholder="978…">
            <button class="icon-btn" type="button" data-scan aria-label="Scanner le code-barres">${icon("scan")}</button>
          </div>
        </label>
        <button class="btn btn-ghost" type="button" data-lookup>${icon("sparkle")}Remplir depuis l’ISBN</button>
        <p class="hint" data-isbn-msg aria-live="polite"></p>
      </section>

      <div class="form-cover">
        <div data-cover>${coverHtml(pre, "cover-md")}</div>
        <label class="field"><span>Couverture (adresse de l’image)</span>
          <input name="couverture" type="url" value="${v(pre.couverture)}" placeholder="https://…"></label>
      </div>

      <label class="field"><span>Titre de l’album</span>
        <input name="titre" value="${v(pre.titre)}" autocomplete="off"></label>

      <div class="cols-2">
        <label class="field col-wide"><span>Collection (série)</span>
          <input name="collectionName" list="dl-collections" value="${v(pre.collectionName)}" autocomplete="off" placeholder="Ex. Blake et Mortimer">
          <datalist id="dl-collections"></datalist></label>
        <label class="field"><span>Tome</span>
          <input name="numero" type="number" inputmode="numeric" min="0" value="${v(pre.numero)}"></label>
      </div>

      <label class="field"><span>Éditeur</span>
        <input name="publisherName" list="dl-publishers" value="${v(pre.publisherName)}" autocomplete="off">
        <datalist id="dl-publishers"></datalist></label>

      <div class="cols-2">
        <label class="field"><span>Scénario</span><input name="scenariste" value="${v(pre.scenariste)}"></label>
        <label class="field"><span>Dessin</span><input name="dessinateur" value="${v(pre.dessinateur)}"></label>
        <label class="field"><span>Couleurs</span><input name="coloriste" value="${v(pre.coloriste)}"></label>
        <label class="field"><span>Autres auteurs</span><input name="auteurs" value="${v(pre.auteurs)}"></label>
        <label class="field"><span>Année de parution</span><input name="annee" type="number" inputmode="numeric" min="1800" max="2100" value="${v(pre.annee)}"></label>
        <label class="field"><span>Pages</span><input name="pages" type="number" inputmode="numeric" min="0" value="${v(pre.pages)}"></label>
      </div>

      <fieldset class="field">
        <legend>État</legend>
        <div class="seg">${ETATS.map((e) => `<label><input type="radio" name="etat" value="${e.key}" ${pre.etat === e.key ? "checked" : ""}><span>${esc(e.short === "—" ? "?" : e.short)}</span></label>`).join("")}</div>
      </fieldset>

      <div class="cols-2">
        <label class="field"><span>Cote (€)</span><input name="cote" inputmode="decimal" value="${v(pre.cote)}"></label>
        <label class="field"><span>Prix d’achat (€)</span><input name="prixAchat" inputmode="decimal" value="${v(pre.prixAchat)}"></label>
        <label class="field"><span>Date d’achat</span><input name="dateAchat" type="date" value="${v(pre.dateAchat || (bd ? "" : todayIso()))}"></label>
        <label class="check"><input type="checkbox" name="eo" ${pre.eo ? "checked" : ""}><span>Édition originale</span></label>
      </div>

      <label class="field"><span>Notes</span><textarea name="notes" rows="3">${v(pre.notes)}</textarea></label>
      <input type="hidden" name="resume" value="${v(pre.resume)}">

      <div data-error></div>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit" name="go" value="detail">${bd ? "Enregistrer" : "Ajouter"}</button>
        ${bd ? "" : `<button class="btn btn-ghost" type="submit" name="go" value="next">Ajouter et scanner le suivant</button>`}
      </div>
    </form>`);

  const form = ctx.el.querySelector("form");
  const f = form.elements;
  const msg = ctx.el.querySelector("[data-isbn-msg]");
  const coverBox = ctx.el.querySelector("[data-cover]");
  const refreshCover = () => { coverBox.innerHTML = coverHtml({ couverture: f.couverture.value, titre: f.titre.value, collectionName: f.collectionName.value }, "cover-md"); };
  f.couverture.addEventListener("change", refreshCover);

  // Autocomplétion : quelques documents lus à la fois, jamais la liste entière.
  const fillList = (input, listId, kind) => {
    const dl = ctx.el.querySelector(`#${listId}`);
    let cache = [];
    input.addEventListener("input", debounce(async () => {
      const items = await suggest(ctx.uid, kind, input.value).catch(() => []);
      cache = items;
      dl.innerHTML = items.map((i) => `<option value="${esc(i.name)}">`).join("");
    }, 300));
    return () => cache;
  };
  const colCache = fillList(f.collectionName, "dl-collections", "collections");
  fillList(f.publisherName, "dl-publishers", "publishers");
  f.collectionName.addEventListener("change", () => {
    const c = colCache().find((x) => x.name === f.collectionName.value);
    if (c?.publisherName && !f.publisherName.value) f.publisherName.value = c.publisherName;
  });

  async function checkDuplicate(isbn) {
    if (bd || !isValidIsbn(isbn)) return;
    const dup = await findBdByIsbn(ctx.uid, isbn).catch(() => null);
    if (dup && ctx.alive()) {
      msg.innerHTML = `Vous avez déjà cet album : <a href="${ctx.link(`bd/${dup.id}`)}">${esc(dup.titre)}</a>. Vous pouvez tout de même l’ajouter (deuxième exemplaire).`;
    }
  }

  async function lookup() {
    const isbn = normalizeIsbn(f.isbn.value);
    if (!isValidIsbn(isbn)) { msg.textContent = "Cet ISBN n’est pas valide."; return; }
    f.isbn.value = isbn;
    msg.textContent = "Recherche dans Google Books et Open Library…";
    const info = await lookupIsbn(isbn);
    if (!ctx.alive()) return;
    if (!info) { msg.textContent = "Aucune info trouvée pour cet ISBN. Complétez à la main."; checkDuplicate(isbn); return; }
    const keys = ["titre", "collectionName", "numero", "publisherName", "scenariste", "dessinateur", "auteurs", "annee", "pages", "couverture", "resume"];
    let n = 0;
    for (const k of keys) {
      if (info[k] && !String(f[k].value).trim()) { f[k].value = info[k]; n++; }
    }
    refreshCover();
    msg.textContent = n ? `${n} champ${n > 1 ? "s" : ""} rempli${n > 1 ? "s" : ""} depuis ${info.sources.join(" et ") || "Open Library"}. Vérifiez la série et le tome.` : "Les champs étaient déjà remplis.";
    checkDuplicate(isbn);
  }

  ctx.el.querySelector("[data-lookup]").onclick = lookup;
  ctx.el.querySelector("[data-scan]").onclick = async () => {
    const isbn = await scanIsbn();
    if (isbn && ctx.alive()) { f.isbn.value = isbn; lookup(); }
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const go = e.submitter?.value || "detail";
    const errBox = ctx.el.querySelector("[data-error]");
    errBox.innerHTML = "";
    const data = {
      isbn: f.isbn.value, titre: f.titre.value, collectionName: f.collectionName.value, numero: f.numero.value,
      publisherName: f.publisherName.value, scenariste: f.scenariste.value, dessinateur: f.dessinateur.value,
      coloriste: f.coloriste.value, auteurs: f.auteurs.value, annee: f.annee.value, pages: f.pages.value,
      couverture: f.couverture.value, resume: f.resume.value, etat: form.querySelector("[name=etat]:checked")?.value || "nc",
      cote: parseNumber(f.cote.value), prixAchat: parseNumber(f.prixAchat.value), dateAchat: f.dateAchat.value || null,
      eo: f.eo.checked, notes: f.notes.value
    };
    if (!data.titre.trim() && !data.collectionName.trim()) {
      errBox.innerHTML = `<p class="form-error">Indiquez au moins un titre ou une collection.</p>`;
      return;
    }
    if (data.isbn && !isValidIsbn(data.isbn)) {
      errBox.innerHTML = `<p class="form-error">L’ISBN n’est pas valide. Corrigez-le ou videz le champ.</p>`;
      return;
    }
    form.querySelectorAll("button[type=submit]").forEach((b) => (b.disabled = true));
    try {
      const newId = await saveBd(ctx.uid, data, bd);
      toast(bd ? "Album enregistré" : "Album ajouté");
      if (go === "next") {
        const qs = new URLSearchParams({ scan: "1" });
        if (data.collectionName) {
          // Enchaîner les tomes d'une même série
          const saved = await getBd(ctx.uid, newId).catch(() => null);
          if (saved?.collectionId) qs.set("col", saved.collectionId);
          if (saved?.numero != null) qs.set("num", saved.numero + 1);
        }
        const target = ctx.link(`bd/new?${qs}`);
        if (location.hash === target) window.dispatchEvent(new HashChangeEvent("hashchange"));
        else location.hash = target;
      } else {
        ctx.go(`bd/${newId}`);
      }
    } catch (err) {
      errBox.innerHTML = errorHtml(err);
      form.querySelectorAll("button[type=submit]").forEach((b) => (b.disabled = false));
    }
  };

  if (!bd && pre.isbn) lookup();
  else if (!bd && ctx.query.get("scan") === "1") {
    const isbn = await scanIsbn();
    if (isbn && ctx.alive()) { f.isbn.value = isbn; lookup(); }
  }
}
