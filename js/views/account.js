import {
  updateUserDoc, getUserDoc, recomputeCounters,
  listMembers, removeMember, renameMember, createInvite, listInvites, deleteInvite, myLibraries
} from "../db.js";
import { logout } from "../auth.js";
import { refreshOwnerDoc, forgetLibrary } from "../app.js";
import { HOME_WIDGETS, DEFAULT_HOME } from "../constants.js";
import { esc } from "../utils.js";
import { icon, toast, confirmDialog, promptDialog, errorHtml } from "../ui.js";
import { spinner } from "../components.js";

const appUrl = () => `${location.origin}${location.pathname}`;
const inviteUrl = (ownerUid, code) => `${appUrl()}#/rejoindre/${ownerUid}/${code}`;
const fmtDay = (ts) => ts?.toDate ? ts.toDate().toLocaleDateString("fr-FR") : "";

/**
 * Mon compte.
 * - Propriétaire (#/compte) : connexion, bédéthèques, nom affiché, co-propriétaires (inviter, retirer),
 *   page d'accueil, partage en lecture seule, données.
 * - Co-propriétaire (#/b/<uid>/compte) : connexion, bédéthèques, co-propriétaires (voir, quitter), données.
 */
export async function render(ctx) {
  const isOwner = ctx.role === "owner";
  ctx.setTitle(isOwner ? "Mon compte" : "Compte");
  ctx.render(spinner());
  const profile = isOwner
    ? (await getUserDoc(ctx.uid).catch(() => null)) || ctx.profile || {}
    : ctx.profile || {};
  if (!ctx.alive()) return;

  const home = { ...DEFAULT_HOME, ...(profile.home || {}) };
  // Ajoute les blocs apparus depuis le dernier réglage
  const widgets = [...home.widgets.filter((w) => HOME_WIDGETS.some((h) => h.id === w.id))];
  for (const h of HOME_WIDGETS) if (!widgets.some((w) => w.id === h.id)) widgets.push({ id: h.id, on: false });

  const shareUrl = `${appUrl()}#/p/${ctx.uid}`;
  const u = ctx.user;
  const provider = u.providerData?.[0]?.providerId === "google.com" ? "Google" : "e-mail";

  ctx.render(`
    <section class="panel">
      <h2>Connexion</h2>
      <p>${esc(u.displayName || u.email || "")}${u.displayName && u.email ? `<br><span class="muted">${esc(u.email)}</span>` : ""}</p>
      <p class="muted">Connecté avec ${provider}. Ces informations ne sont visibles que par vous.</p>
      <button class="btn btn-ghost" type="button" data-logout>${icon("logout")}Se déconnecter</button>
    </section>

    <section class="panel hidden" data-libraries-panel>
      <h2>Mes bédéthèques</h2>
      <ul class="member-list" data-libraries></ul>
    </section>

    ${isOwner ? `
    <section class="panel">
      <h2>Nom affiché</h2>
      <label class="field"><span>Votre nom, montré aux co-propriétaires et aux visiteurs du partage</span>
        <input name="shareName" value="${esc(profile.shareName)}" maxlength="40" placeholder="Ex. Camille"></label>
      <p class="hint">Obligatoire pour inviter des co-propriétaires. Votre e-mail n’est jamais montré.</p>
      <button class="btn btn-primary" type="button" data-save-name>Enregistrer le nom</button>
    </section>` : ""}

    <section class="panel">
      <h2>${icon("users")} Co-propriétaires</h2>
      <p class="hint">${isOwner
        ? "Les co-propriétaires ont accès à toute la bédéthèque : ils ajoutent, modifient et suppriment albums, collections et éditeurs, et peuvent importer. Vous seul réglez le partage public, l’accueil et cette liste."
        : `Vous avez accès à toute cette bédéthèque. Seul le propriétaire règle le partage public, la page d’accueil et la liste des co-propriétaires.`}</p>
      <ul class="member-list" data-members>${spinner()}</ul>
      ${isOwner ? `
        <button class="btn btn-primary" type="button" data-invite>${icon("plus")}Inviter un co-propriétaire</button>
        <div class="share-link hidden" data-invite-box>
          <input readonly aria-label="Lien d’invitation">
          <button class="btn btn-ghost" type="button" data-copy-invite>${icon("link")}Copier</button>
          ${navigator.share ? `<button class="btn btn-ghost" type="button" data-share-invite>${icon("share")}Envoyer</button>` : ""}
        </div>
        <p class="hint">Chaque lien d’invitation ne sert qu’à une seule personne et expire au bout de 7 jours. La personne doit se connecter (ou créer un compte) pour l’accepter.</p>
        <div data-invites></div>` : ""}
    </section>

    ${isOwner ? `
    <section class="panel">
      <h2>Page d’accueil</h2>
      <p class="hint">Choisissez les blocs affichés et leur ordre. Le réglage vaut aussi pour vos co-propriétaires et les visiteurs.</p>
      <ul class="widget-list" data-widgets></ul>
      <label class="field inline"><span>Albums dans « Derniers achats » et « Derniers ajouts »</span>
        <select name="recentCount">${[4, 6, 8, 12, 16].map((n) => `<option ${n === home.recentCount ? "selected" : ""}>${n}</option>`).join("")}</select></label>
      <button class="btn btn-primary" type="button" data-save-home>Enregistrer l’accueil</button>
    </section>

    <section class="panel">
      <h2>Partage en lecture seule</h2>
      <label class="check"><input type="checkbox" name="shareEnabled" ${profile.shareEnabled ? "checked" : ""}><span>Partager ma bédéthèque avec un lien</span></label>
      <p class="hint">Toute personne qui a le lien voit vos albums, collections et éditeurs, y compris l’état, la cote, les photos et les notes. Elle ne peut rien modifier. Pour donner le droit de modifier, invitez plutôt un co-propriétaire.</p>
      <div class="share-link ${profile.shareEnabled ? "" : "hidden"}" data-share-link>
        <input readonly value="${esc(shareUrl)}" aria-label="Lien de partage">
        <button class="btn btn-ghost" type="button" data-copy>${icon("link")}Copier</button>
        ${navigator.share ? `<button class="btn btn-ghost" type="button" data-native-share>${icon("share")}Partager</button>` : ""}
        <a class="btn btn-ghost" href="#/p/${esc(ctx.uid)}">${icon("eye")}Voir comme un visiteur</a>
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
    </section>`);

  const $in = (sel) => ctx.el.querySelector(sel);

  // ---- Mes bédéthèques (la mienne + celles dont je suis co-propriétaire)
  myLibraries(u.uid).then((libs) => {
    if (!ctx.alive()) return;
    if (!libs.length && isOwner) return; // rien à choisir
    const current = isOwner ? u.uid : ctx.uid;
    const row = (href, uid, name, role, sub) => `
      <li class="${uid === current ? "current" : ""}">
        <a class="who" href="${href}"><strong>${esc(name)}</strong>${sub ? `<small>${esc(sub)}</small>` : ""}</a>
        <span class="role role-${role}">${role === "owner" ? "Propriétaire" : "Co-propriétaire"}</span>
      </li>`;
    $in("[data-libraries]").innerHTML =
      row("#/", u.uid, "Ma bédéthèque", "owner", "") +
      libs.map((l) => row(`#/b/${l.ownerUid}/`, l.ownerUid, l.ownerName ? `Bédéthèque de ${l.ownerName}` : "Bédéthèque partagée", "coowner", l.myName ? `Vous y apparaissez comme « ${l.myName} »` : "")).join("");
    $in("[data-libraries-panel]").classList.remove("hidden");
  }).catch((e) => console.warn("Bédéthèques partagées", e));

  // ---- Co-propriétaires
  const membersUl = $in("[data-members]");
  const drawMembers = async () => {
    let members;
    try { members = await listMembers(ctx.uid); }
    catch (e) { if (ctx.alive()) membersUl.innerHTML = `<li>${errorHtml(e)}</li>`; return; }
    if (!ctx.alive()) return;
    const ownerName = (isOwner ? $in("[name=shareName]")?.value.trim() : profile.shareName) || "";
    const ownerRow = `<li>
      <span class="who"><strong>${esc(ownerName || (isOwner ? "Vous" : "Propriétaire"))}</strong>${isOwner ? "<small>Vous</small>" : ""}</span>
      <span class="role role-owner">Propriétaire</span></li>`;
    membersUl.innerHTML = ownerRow + members.map((m) => {
      const me = m.uid === u.uid;
      const action = isOwner
        ? `<button class="icon-btn" type="button" data-remove="${esc(m.uid)}" data-name="${esc(m.name)}" aria-label="Retirer ${esc(m.name)}">${icon("trash")}</button>`
        : me ? `<button class="icon-btn" type="button" data-rename data-name="${esc(m.name)}" aria-label="Modifier mon nom">${icon("edit")}</button>` : "";
      return `<li>
        <span class="who"><strong>${esc(m.name)}</strong><small>${me ? "Vous · " : ""}depuis le ${esc(fmtDay(m.joinedAt))}</small></span>
        <span class="role role-coowner">Co-propriétaire</span>${action}</li>`;
    }).join("") + (!isOwner ? `<li><button class="btn btn-danger-ghost" type="button" data-leave>Quitter cette bédéthèque</button></li>` : "");
    if (isOwner && !members.length) membersUl.insertAdjacentHTML("beforeend", `<li class="muted">Aucun co-propriétaire pour l’instant.</li>`);
  };
  drawMembers();

  membersUl.addEventListener("click", async (e) => {
    const rm = e.target.closest("[data-remove]");
    if (rm) {
      if (!(await confirmDialog(`${rm.dataset.name} n’aura plus accès à votre bédéthèque. Ce qu’il ou elle a ajouté reste en place.`, { title: "Retirer ce co-propriétaire ?", ok: "Retirer", danger: true }))) return;
      try { await removeMember(ctx.uid, rm.dataset.remove); toast("Co-propriétaire retiré"); drawMembers(); }
      catch (err) { toast(err.message, "error"); }
      return;
    }
    const rn = e.target.closest("[data-rename]");
    if (rn) {
      const name = await promptDialog("Le nom que voient le propriétaire et les autres co-propriétaires.", { title: "Votre nom affiché", value: rn.dataset.name, placeholder: "Ex. Camille" });
      if (!name?.trim()) return;
      try { await renameMember(ctx.uid, u.uid, name); forgetLibrary(ctx.uid); toast("Nom modifié"); drawMembers(); }
      catch (err) { toast(err.message, "error"); }
      return;
    }
    if (e.target.closest("[data-leave]")) {
      if (!(await confirmDialog("Vous n’aurez plus accès à cette bédéthèque, sauf nouvelle invitation du propriétaire.", { title: "Quitter cette bédéthèque ?", ok: "Quitter", danger: true }))) return;
      try { await removeMember(ctx.uid, u.uid); forgetLibrary(ctx.uid); toast("Vous avez quitté la bédéthèque"); location.hash = "#/"; }
      catch (err) { toast(err.message, "error"); }
    }
  });

  if (isOwner) {
    // ---- Invitations en attente
    const invitesBox = $in("[data-invites]");
    const drawInvites = async () => {
      const list = await listInvites(ctx.uid).catch(() => []);
      if (!ctx.alive()) return;
      invitesBox.innerHTML = list.length ? `
        <p class="muted">Invitation${list.length > 1 ? "s" : ""} en attente</p>
        <ul class="member-list">${list.map((i) => `<li>
          <span class="who"><strong>Lien d’invitation</strong><small>valable jusqu’au ${esc(fmtDay(i.expiresAt))}</small></span>
          <button class="icon-btn" type="button" data-copy-code="${esc(i.id)}" aria-label="Copier le lien">${icon("link")}</button>
          <button class="icon-btn" type="button" data-cancel-code="${esc(i.id)}" aria-label="Annuler l’invitation">${icon("close")}</button>
        </li>`).join("")}</ul>` : "";
    };
    drawInvites();
    invitesBox.addEventListener("click", async (e) => {
      const cp = e.target.closest("[data-copy-code]");
      if (cp) {
        try { await navigator.clipboard.writeText(inviteUrl(ctx.uid, cp.dataset.copyCode)); toast("Lien copié"); }
        catch { toast("Copie impossible", "error"); }
      }
      const cancel = e.target.closest("[data-cancel-code]");
      if (cancel) {
        try { await deleteInvite(ctx.uid, cancel.dataset.cancelCode); toast("Invitation annulée"); drawInvites(); $in("[data-invite-box]").classList.add("hidden"); }
        catch (err) { toast(err.message, "error"); }
      }
    });

    const inviteBox = $in("[data-invite-box]");
    const inviteInput = inviteBox.querySelector("input");
    $in("[data-invite]").onclick = async (e) => {
      const ownerName = profile.shareName?.trim();
      if (!ownerName) {
        toast("Indiquez et enregistrez d’abord votre nom affiché.", "error");
        $in("[name=shareName]").focus();
        return;
      }
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const inv = await createInvite(ctx.uid, ownerName);
        inviteInput.value = inviteUrl(ctx.uid, inv.id);
        inviteBox.classList.remove("hidden");
        inviteInput.select();
        drawInvites();
      } catch (err) { toast(err.message, "error"); }
      finally { btn.disabled = false; }
    };
    $in("[data-copy-invite]").onclick = async () => {
      try { await navigator.clipboard.writeText(inviteInput.value); toast("Lien copié"); }
      catch { inviteInput.select(); }
    };
    $in("[data-share-invite]")?.addEventListener("click", () => {
      navigator.share({ title: "Rejoins ma bédéthèque", text: "Deviens co-propriétaire de ma bédéthèque :", url: inviteInput.value }).catch(() => {});
    });

    // ---- Nom affiché
    $in("[data-save-name]").onclick = async () => {
      const data = { shareName: $in("[name=shareName]").value.trim() };
      try { await updateUserDoc(ctx.uid, data); refreshOwnerDoc(data); profile.shareName = data.shareName; toast("Nom enregistré"); drawMembers(); }
      catch (e) { toast(e.message, "error"); }
    };

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
      const data = { home: { widgets, recentCount: +$in("[name=recentCount]").value } };
      try { await updateUserDoc(ctx.uid, data); refreshOwnerDoc(data); toast("Accueil enregistré"); }
      catch (e) { toast(e.message, "error"); }
    };

    // ---- Partage en lecture seule
    const shareBox = $in("[data-share-link]");
    const shareCheck = $in("[name=shareEnabled]");
    $in("[data-save-share]").onclick = async () => {
      const data = { shareEnabled: shareCheck.checked };
      try {
        await updateUserDoc(ctx.uid, data);
        refreshOwnerDoc(data);
        shareBox.classList.toggle("hidden", !data.shareEnabled);
        toast(data.shareEnabled ? "Partage activé" : "Partage désactivé");
      } catch (e) { toast(e.message, "error"); }
    };
    $in("[data-copy]").onclick = async () => {
      try { await navigator.clipboard.writeText(shareUrl); toast("Lien copié"); }
      catch { shareBox.querySelector("input").select(); }
    };
    $in("[data-native-share]")?.addEventListener("click", () => {
      navigator.share({ title: "Ma bédéthèque", url: shareUrl }).catch(() => {});
    });
  }

  // ---- Données
  $in("[data-recompute]").onclick = async (e) => {
    const btn = e.currentTarget;
    if (!(await confirmDialog("Le recalcul compte tous les albums côté serveur. Il coûte peu de lectures (environ 1 par tranche de 1 000 albums, plus 1 par collection).", { title: "Recalculer les compteurs ?", ok: "Recalculer" }))) return;
    const msg = $in("[data-recompute-msg]");
    btn.disabled = true;
    try {
      const r = await recomputeCounters(ctx.uid, (t) => { msg.textContent = t; });
      msg.textContent = r.fixed ? `Terminé : ${r.fixed} compteur${r.fixed > 1 ? "s" : ""} corrigé${r.fixed > 1 ? "s" : ""}.` : "Terminé : tout était juste.";
    } catch (err) {
      msg.innerHTML = errorHtml(err);
    } finally {
      btn.disabled = false;
    }
  };

  $in("[data-logout]").onclick = async () => {
    if (await confirmDialog("Vous devrez vous reconnecter pour voir votre bédéthèque.", { title: "Se déconnecter ?", ok: "Se déconnecter" })) {
      await logout();
      location.hash = "#/";
    }
  };
}
