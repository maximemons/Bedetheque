import {
  recomputeCounters, saveAccount, renameLibrary, saveLibraryHome, setLibraryShared, deleteLibrary,
  libraryMembers, addMember, removeMember, setMemberRole, renameMember, normEmail, ROLES, MAX_MEMBERS
} from "../db.js";
import { logout } from "../auth.js";
import {
  refreshLibraries, patchLibrary, rerender, myLibraries, createLibraryAndOpen, setAccountLocal, applyNavPosition
} from "../app.js";
import { HOME_WIDGETS, DEFAULT_HOME } from "../constants.js";
import { esc } from "../utils.js";
import { icon, toast, confirmDialog, promptDialog, errorHtml } from "../ui.js";

const appUrl = () => `${location.origin}${location.pathname}`;
const fmtDay = (ts) => (ts?.toDate ? ts.toDate().toLocaleDateString("fr-FR") : "");
const PROVIDERS = { "google.com": "Google", password: "e-mail et mot de passe", emailLink: "lien e-mail" };

/**
 * Compte (#/b/<bédéthèque>/compte), en deux parties :
 * - mon compte : connexion, nom par défaut, affichage (position de la barre), mes bédéthèques ;
 *   réglages liés à l'adresse e-mail, communs à toutes les bédéthèques ;
 * - la bédéthèque ouverte : nom, membres, page d'accueil, partage, données, suppression.
 */
export async function render(ctx) {
  const u = ctx.user;
  const lib = ctx.lib;
  const isOwner = ctx.role === "owner";
  const account = ctx.account || {};
  const members = libraryMembers(lib);
  const owners = members.filter((m) => m.role === "owner");
  const libs = myLibraries();

  ctx.setTitle("Compte", { kicker: lib.name });

  const home = { ...DEFAULT_HOME, ...(lib.home || {}) };
  const widgets = [...home.widgets.filter((w) => HOME_WIDGETS.some((h) => h.id === w.id))];
  for (const h of HOME_WIDGETS) if (!widgets.some((w) => w.id === h.id)) widgets.push({ id: h.id, on: false });

  const shareUrl = `${appUrl()}#/p/${lib.id}`;
  const providers = [...new Set((u.providerData || []).map((p) => PROVIDERS[p.providerId] || p.providerId))];
  const nav = account.navPosition === "right" ? "right" : "left";

  const libRow = (l) => {
    const role = l.members?.[ctx.key]?.role === "owner" ? "owner" : "editor";
    const n = l.memberKeys?.length || 1;
    return `<li class="${l.id === lib.id ? "current" : ""}">
      <a class="who" href="#/b/${esc(l.id)}/"><strong>${esc(l.name)}</strong>
        <small>${n > 1 ? `${n} membres` : "Vous seul"}${l.shared ? " · partagée par lien" : ""}</small></a>
      <span class="role role-${role === "owner" ? "owner" : "coowner"}">${ROLES[role]}</span></li>`;
  };

  const memberRow = (m) => {
    const me = m.key === ctx.key;
    let actions = "";
    if (isOwner && !me) {
      actions = `
        <select class="role-select" data-role="${esc(m.key)}" aria-label="Rôle de ${esc(m.name)}">
          ${Object.entries(ROLES).map(([k, v]) => `<option value="${k}" ${k === m.role ? "selected" : ""}>${v}</option>`).join("")}
        </select>
        <button class="icon-btn" type="button" data-remove="${esc(m.key)}" data-name="${esc(m.name)}" aria-label="Retirer ${esc(m.name)}">${icon("trash")}</button>`;
    } else {
      actions = `<span class="role role-${m.role === "owner" ? "owner" : "coowner"}">${ROLES[m.role] || ROLES.editor}</span>`;
    }
    if (me) actions += `<button class="icon-btn" type="button" data-rename="${esc(m.name)}" aria-label="Modifier mon nom affiché">${icon("edit")}</button>`;
    return `<li>
      <span class="who"><strong>${esc(m.name)}</strong><small>${me ? "Vous · " : ""}${m.addedAt ? `depuis le ${esc(fmtDay(m.addedAt))}` : ""}</small></span>
      ${actions}
    </li>`;
  };
  const me = members.find((m) => m.key === ctx.key);
  const canLeave = !!me && (me.role !== "owner" || owners.length > 1);

  ctx.render(`
    <h2 class="section-title">${icon("user")} Mon compte</h2>

    <section class="panel">
      <h2>Connexion</h2>
      <p>${esc(u.displayName || u.email || "")}${u.displayName && u.email ? `<br><span class="muted">${esc(u.email)}</span>` : ""}</p>
      <p class="muted">Connecté avec ${esc(providers.join(", ") || "e-mail")}. Vos bédéthèques sont rattachées à votre adresse e-mail : que vous vous connectiez avec Google ou avec e-mail et mot de passe, vous retrouvez les mêmes dès lors que l’adresse est la même.</p>
      <label class="field"><span>Nom affiché par défaut</span>
        <input name="pseudo" value="${esc(account.pseudo)}" maxlength="40" placeholder="Ex. Camille"></label>
      <p class="hint">Utilisé quand vous créez une bédéthèque. Votre adresse e-mail n’est jamais montrée aux autres membres.</p>
      <div class="row-actions">
        <button class="btn btn-primary" type="button" data-save-pseudo>Enregistrer le nom</button>
        <button class="btn btn-ghost" type="button" data-logout>${icon("logout")}Se déconnecter</button>
      </div>
    </section>

    <section class="panel">
      <h2>${icon("sidebar")} Affichage</h2>
      <fieldset class="field"><legend>Barre de navigation sur ordinateur et tablette</legend>
        <div class="seg" role="radiogroup">
          <label><input type="radio" name="navPosition" value="left" ${nav === "left" ? "checked" : ""}><span>À gauche</span></label>
          <label><input type="radio" name="navPosition" value="right" ${nav === "right" ? "checked" : ""}><span>À droite</span></label>
        </div>
      </fieldset>
      <p class="hint">Réglage de votre compte, valable pour toutes vos bédéthèques et sur tous vos appareils. Sur téléphone, la barre reste toujours en bas de l’écran.</p>
    </section>

    <section class="panel">
      <h2>${icon("shelf")} Mes bédéthèques</h2>
      <ul class="member-list">${libs.map(libRow).join("")}</ul>
      <button class="btn btn-primary" type="button" data-new-lib>${icon("plus")}Nouvelle bédéthèque</button>
      <p class="hint">Vous pouvez en avoir autant que vous voulez : une personnelle, une partagée avec votre conjoint… Le bouton en haut de l’écran permet de passer de l’une à l’autre.</p>
    </section>

    <h2 class="section-title">${icon("books")} ${esc(lib.name)}</h2>

    <section class="panel">
      <h2>Nom de la bédéthèque</h2>
      ${isOwner ? `
        <label class="field"><span>Nom, visible par tous les membres${lib.shared ? " et par les visiteurs du lien de partage" : ""}</span>
          <input name="libName" value="${esc(lib.name)}" maxlength="40" required></label>
        <button class="btn btn-primary" type="button" data-rename-lib>Renommer</button>`
      : `<p><strong>${esc(lib.name)}</strong></p><p class="hint">Seul un propriétaire peut la renommer.</p>`}
    </section>

    <section class="panel">
      <h2>${icon("users")} Membres</h2>
      <p class="hint">${isOwner
        ? "Les co-propriétaires ont accès à toute la bédéthèque : ils ajoutent, modifient et suppriment albums, collections et éditeurs, et peuvent importer. Les propriétaires règlent en plus le nom, les membres, l’accueil et le partage."
        : "Vous avez accès à toute cette bédéthèque. Seuls les propriétaires règlent son nom, ses membres, l’accueil et le partage."}</p>
      <ul class="member-list" data-members>${members.map(memberRow).join("")}</ul>
      ${canLeave ? `<button class="btn btn-danger-ghost" type="button" data-leave>Quitter cette bédéthèque</button>` : ""}
      ${isOwner ? `
        <form class="form add-member" data-add-member novalidate>
          <h3>Ajouter un membre</h3>
          <div class="cols-2">
            <label class="field col-wide"><span>Adresse e-mail</span><input name="email" type="email" autocomplete="off" required placeholder="prenom@exemple.fr"></label>
            <label class="field"><span>Rôle</span><select name="role">
              <option value="editor">${ROLES.editor}</option><option value="owner">${ROLES.owner}</option></select></label>
          </div>
          <label class="field"><span>Nom affiché aux membres</span><input name="name" maxlength="40" required placeholder="Ex. Julie"></label>
          <button class="btn btn-primary" type="submit" ${members.length >= MAX_MEMBERS ? "disabled" : ""}>${icon("plus")}Ajouter</button>
          <p class="hint">La personne verra cette bédéthèque dès qu’elle se connectera avec cette adresse (Google, e-mail et mot de passe, ou lien de connexion). L’adresse n’est pas enregistrée en clair : seule son empreinte l’est, ce qui permet de la reconnaître sans la conserver. ${MAX_MEMBERS} membres au plus.</p>
          <div class="notice hidden" data-added></div>
        </form>` : ""}
    </section>

    ${isOwner ? `
    <section class="panel">
      <h2>Page d’accueil</h2>
      <p class="hint">Choisissez les blocs affichés et leur ordre. Le réglage vaut pour tous les membres de cette bédéthèque et pour les visiteurs.</p>
      <ul class="widget-list" data-widgets></ul>
      <label class="field inline"><span>Albums dans « Derniers achats » et « Derniers ajouts »</span>
        <select name="recentCount">${[4, 6, 8, 12, 16].map((n) => `<option ${n === home.recentCount ? "selected" : ""}>${n}</option>`).join("")}</select></label>
      <button class="btn btn-primary" type="button" data-save-home>Enregistrer l’accueil</button>
    </section>

    <section class="panel">
      <h2>Partage en lecture seule</h2>
      <label class="check"><input type="checkbox" name="shareEnabled" ${lib.shared ? "checked" : ""}><span>Partager cette bédéthèque avec un lien</span></label>
      <p class="hint">Toute personne qui a le lien voit ses albums, collections et éditeurs, y compris l’état, la cote, les photos et les notes, sans pouvoir rien modifier. Le nom des membres n’est pas montré. Pour donner le droit de modifier, ajoutez plutôt un membre.</p>
      <div class="share-link ${lib.shared ? "" : "hidden"}" data-share-link>
        <input readonly value="${esc(shareUrl)}" aria-label="Lien de partage">
        <button class="btn btn-ghost" type="button" data-copy>${icon("link")}Copier</button>
        ${navigator.share ? `<button class="btn btn-ghost" type="button" data-native-share>${icon("share")}Partager</button>` : ""}
        <a class="btn btn-ghost" href="#/p/${esc(lib.id)}">${icon("eye")}Voir comme un visiteur</a>
      </div>
      <button class="btn btn-primary" type="button" data-save-share>Enregistrer le partage</button>
    </section>` : ""}

    <section class="panel">
      <h2>Données</h2>
      <div class="row-actions">
        <a class="btn btn-ghost" href="${ctx.link("import")}">${icon("upload")}Importer un fichier CSV</a>
        <button class="btn btn-ghost" type="button" data-recompute>${icon("refresh")}Recalculer les compteurs</button>
      </div>
      <p class="hint">Les compteurs (nombre de BD, albums par collection…) se tiennent à jour tout seuls. Recalculez-les après un import interrompu ou si un chiffre vous semble faux.</p>
      <p class="muted" data-recompute-msg aria-live="polite"></p>
    </section>

    ${isOwner ? `
    <section class="panel danger-panel">
      <h2>Supprimer la bédéthèque</h2>
      <p class="hint">Supprime « ${esc(lib.name)} » pour tous ses membres, avec tous ses albums, collections, éditeurs et photos. C’est définitif. Coût : environ 1 écriture par album.</p>
      <button class="btn btn-danger-ghost" type="button" data-delete-lib>${icon("trash")}Supprimer « ${esc(lib.name)} »</button>
      <p class="muted" data-delete-msg aria-live="polite"></p>
    </section>` : ""}`);

  const $in = (sel) => ctx.el.querySelector(sel);
  const after = async (msg) => {
    if (msg) toast(msg);
    await refreshLibraries().catch(() => {});
    rerender();
  };

  // ---- Mon compte
  $in("[data-save-pseudo]").onclick = async () => {
    const pseudo = $in("[name=pseudo]").value.trim();
    try { await saveAccount(ctx.key, { pseudo }); setAccountLocal({ pseudo }); toast("Nom enregistré"); }
    catch (e) { toast(e.message, "error"); }
  };
  $in("[data-logout]").onclick = async () => {
    if (await confirmDialog("Vous devrez vous reconnecter pour voir vos bédéthèques.", { title: "Se déconnecter ?", ok: "Se déconnecter" })) {
      await logout();
      location.hash = "#/";
    }
  };

  // ---- Affichage : position de la barre, appliquée tout de suite
  ctx.el.querySelectorAll("[name=navPosition]").forEach((r) => r.addEventListener("change", async () => {
    const navPosition = r.value === "right" ? "right" : "left";
    applyNavPosition(navPosition);
    setAccountLocal({ navPosition });
    try { await saveAccount(ctx.key, { navPosition }); toast(navPosition === "right" ? "Barre à droite" : "Barre à gauche"); }
    catch (e) { toast(e.message, "error"); }
  }));

  // ---- Mes bédéthèques
  $in("[data-new-lib]").onclick = () => createLibraryAndOpen();

  // ---- Nom de la bédéthèque
  $in("[data-rename-lib]")?.addEventListener("click", async () => {
    const input = $in("[name=libName]");
    try {
      const name = await renameLibrary(lib, input.value);
      patchLibrary(lib.id, { name });
      after("Bédéthèque renommée");
    } catch (e) { toast(e.message, "error"); input.focus(); }
  });

  // ---- Membres
  $in("[data-members]").addEventListener("click", async (e) => {
    const rm = e.target.closest("[data-remove]");
    if (rm) {
      if (!(await confirmDialog(`${rm.dataset.name} n’aura plus accès à « ${lib.name} ». Ce qu’il ou elle a ajouté reste en place.`, { title: "Retirer ce membre ?", ok: "Retirer", danger: true }))) return;
      try { await removeMember(lib.id, rm.dataset.remove); after("Membre retiré"); }
      catch (err) { toast(err.message, "error"); }
      return;
    }
    const rn = e.target.closest("[data-rename]");
    if (rn) {
      const name = await promptDialog("Le nom que voient les autres membres de cette bédéthèque.", { title: "Votre nom affiché", value: rn.dataset.rename, placeholder: "Ex. Camille" });
      if (!name?.trim()) return;
      try { await renameMember(lib.id, ctx.key, name); after("Nom modifié"); }
      catch (err) { toast(err.message, "error"); }
    }
  });
  $in("[data-members]").addEventListener("change", async (e) => {
    const sel = e.target.closest("[data-role]");
    if (!sel) return;
    try { await setMemberRole(lib.id, sel.dataset.role, sel.value); after("Rôle modifié"); }
    catch (err) { toast(err.message, "error"); }
  });
  $in("[data-leave]")?.addEventListener("click", async () => {
    if (!(await confirmDialog(`Vous n’aurez plus accès à « ${lib.name} », sauf si un propriétaire vous ajoute de nouveau.`, { title: "Quitter cette bédéthèque ?", ok: "Quitter", danger: true }))) return;
    try {
      await removeMember(lib.id, ctx.key);
      await refreshLibraries().catch(() => {});
      toast("Vous avez quitté la bédéthèque");
      location.hash = "#/";
    } catch (err) { toast(err.message, "error"); }
  });

  const addForm = $in("[data-add-member]");
  addForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = normEmail(addForm.elements.email.value);
    const name = addForm.elements.name.value.trim();
    if (!email || !name) { toast("Indiquez l’adresse e-mail et le nom affiché.", "error"); return; }
    const btn = addForm.querySelector("[type=submit]");
    btn.disabled = true;
    try {
      await addMember(lib, email, name, addForm.elements.role.value);
      await refreshLibraries().catch(() => {});
      // L'adresse ne reste que dans cette page, le temps de prévenir la personne.
      const subject = encodeURIComponent(`Bédéthèque « ${lib.name} »`);
      const body = encodeURIComponent(`Bonjour,\n\nJe t’ai ajouté(e) à la bédéthèque « ${lib.name} ».\nConnecte-toi avec cette adresse e-mail pour la retrouver :\n${appUrl()}\n`);
      const box = $in("[data-added]");
      box.innerHTML = `<p><strong>${esc(name)}</strong> est maintenant membre.</p>
        <a class="btn btn-ghost" href="mailto:${esc(email)}?subject=${subject}&body=${body}">${icon("mail")}Prévenir par e-mail</a>`;
      box.classList.remove("hidden");
      addForm.elements.email.value = "";
      addForm.elements.name.value = "";
      $in("[data-members]").innerHTML = libraryMembers(myLibraries().find((l) => l.id === lib.id) || lib).map(memberRow).join("");
      toast("Membre ajouté");
    } catch (err) { toast(err.message, "error"); }
    finally { btn.disabled = false; }
  });

  if (isOwner) {
    // ---- Blocs de l'accueil
    const ul = $in("[data-widgets]");
    const drawWidgets = () => {
      ul.innerHTML = widgets.map((w, i) => {
        const label = HOME_WIDGETS.find((h) => h.id === w.id)?.label || w.id;
        return `<li>
          <label class="check"><input type="checkbox" data-i="${i}" ${w.on ? "checked" : ""}><span>${esc(label)}</span></label>
          <span class="order">
            <button class="icon-btn" type="button" data-up="${i}" ${i === 0 ? "disabled" : ""} aria-label="Monter">${icon("up")}</button>
            <button class="icon-btn" type="button" data-down="${i}" ${i === widgets.length - 1 ? "disabled" : ""} aria-label="Descendre">${icon("down")}</button>
          </span></li>`;
      }).join("");
    };
    drawWidgets();
    ul.addEventListener("click", (e) => {
      const up = e.target.closest("[data-up]"), down = e.target.closest("[data-down]");
      if (up) { const i = +up.dataset.up; [widgets[i - 1], widgets[i]] = [widgets[i], widgets[i - 1]]; drawWidgets(); }
      if (down) { const i = +down.dataset.down; [widgets[i + 1], widgets[i]] = [widgets[i], widgets[i + 1]]; drawWidgets(); }
    });
    ul.addEventListener("change", (e) => { if (e.target.dataset.i) widgets[+e.target.dataset.i].on = e.target.checked; });

    $in("[data-save-home]").onclick = async () => {
      const homeData = { widgets, recentCount: +$in("[name=recentCount]").value };
      try { await saveLibraryHome(lib, homeData); patchLibrary(lib.id, { home: homeData }); toast("Accueil enregistré"); }
      catch (e) { toast(e.message, "error"); }
    };

    // ---- Partage en lecture seule
    const shareBox = $in("[data-share-link]");
    const shareCheck = $in("[name=shareEnabled]");
    $in("[data-save-share]").onclick = async () => {
      const enabled = shareCheck.checked;
      try {
        await setLibraryShared(lib, enabled);
        patchLibrary(lib.id, { shared: enabled });
        lib.shared = enabled;
        shareBox.classList.toggle("hidden", !enabled);
        toast(enabled ? "Partage activé" : "Partage désactivé");
      } catch (e) { toast(e.message, "error"); }
    };
    $in("[data-copy]").onclick = async () => {
      try { await navigator.clipboard.writeText(shareUrl); toast("Lien copié"); }
      catch { shareBox.querySelector("input").select(); }
    };
    $in("[data-native-share]")?.addEventListener("click", () => {
      navigator.share({ title: lib.name, url: shareUrl }).catch(() => {});
    });

    // ---- Suppression
    $in("[data-delete-lib]").onclick = async (e) => {
      const typed = await promptDialog(`Pour confirmer, tapez le nom de la bédéthèque : ${lib.name}`, { title: "Supprimer la bédéthèque ?", ok: "Supprimer définitivement" });
      if (typed === null) return;
      if (typed.trim() !== lib.name.trim()) { toast("Le nom ne correspond pas : rien n’a été supprimé.", "error"); return; }
      const btn = e.currentTarget;
      const msg = $in("[data-delete-msg]");
      btn.disabled = true;
      try {
        await deleteLibrary(lib, (n) => { msg.textContent = `${n} document${n > 1 ? "s" : ""} supprimé${n > 1 ? "s" : ""}…`; });
        await refreshLibraries().catch(() => {});
        toast(`« ${lib.name} » supprimée`);
        if (!myLibraries().length) location.reload(); // une nouvelle bédéthèque sera créée
        else location.hash = "#/";
      } catch (err) {
        msg.innerHTML = errorHtml(err);
        btn.disabled = false;
      }
    };
  }

  // ---- Données
  $in("[data-recompute]").onclick = async (e) => {
    const btn = e.currentTarget;
    if (!(await confirmDialog("Le recalcul compte tous les albums côté serveur. Il coûte peu de lectures (environ 1 par tranche de 1 000 albums, plus 1 par collection).", { title: "Recalculer les compteurs ?", ok: "Recalculer" }))) return;
    const msg = $in("[data-recompute-msg]");
    btn.disabled = true;
    try {
      const r = await recomputeCounters(ctx.libId, (t) => { msg.textContent = t; });
      msg.textContent = r.fixed ? `Terminé : ${r.fixed} compteur${r.fixed > 1 ? "s" : ""} corrigé${r.fixed > 1 ? "s" : ""}.` : "Terminé : tout était juste.";
    } catch (err) {
      msg.innerHTML = errorHtml(err);
    } finally {
      btn.disabled = false;
    }
  };
}
