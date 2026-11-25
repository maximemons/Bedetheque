import { updateUserDoc, getUserDoc, recomputeCounters } from "../db.js";
import { logout } from "../auth.js";
import { refreshOwnerDoc } from "../app.js";
import { HOME_WIDGETS, DEFAULT_HOME } from "../constants.js";
import { esc } from "../utils.js";
import { icon, toast, confirmDialog, errorHtml } from "../ui.js";
import { spinner } from "../components.js";

export async function render(ctx) {
  ctx.setTitle("Mon compte");
  ctx.render(spinner());
  const profile = (await getUserDoc(ctx.uid).catch(() => null)) || ctx.profile || {};
  if (!ctx.alive()) return;

  const home = { ...DEFAULT_HOME, ...(profile.home || {}) };
  // Ajoute les blocs apparus depuis le dernier réglage
  const widgets = [...home.widgets.filter((w) => HOME_WIDGETS.some((h) => h.id === w.id))];
  for (const h of HOME_WIDGETS) if (!widgets.some((w) => w.id === h.id)) widgets.push({ id: h.id, on: false });

  const shareUrl = `${location.origin}${location.pathname}#/p/${ctx.uid}`;
  const u = ctx.user;
  const provider = u.providerData?.[0]?.providerId === "google.com" ? "Google" : "e-mail";

  ctx.render(`
    <section class="panel">
      <h2>Connexion</h2>
      <p>${esc(u.displayName || u.email || "")}${u.displayName && u.email ? `<br><span class="muted">${esc(u.email)}</span>` : ""}</p>
      <p class="muted">Connecté avec ${provider}.</p>
      <button class="btn btn-ghost" type="button" data-logout>${icon("logout")}Se déconnecter</button>
    </section>

    <section class="panel">
      <h2>Page d’accueil</h2>
      <p class="hint">Choisissez les blocs affichés et leur ordre.</p>
      <ul class="widget-list" data-widgets></ul>
      <label class="field inline"><span>Albums dans « Derniers achats » et « Derniers ajouts »</span>
        <select name="recentCount">${[4, 6, 8, 12, 16].map((n) => `<option ${n === home.recentCount ? "selected" : ""}>${n}</option>`).join("")}</select></label>
      <button class="btn btn-primary" type="button" data-save-home>Enregistrer l’accueil</button>
    </section>

    <section class="panel">
      <h2>Partage en lecture seule</h2>
      <label class="check"><input type="checkbox" name="shareEnabled" ${profile.shareEnabled ? "checked" : ""}><span>Partager ma bédéthèque avec un lien</span></label>
      <label class="field"><span>Nom affiché aux visiteurs (facultatif)</span><input name="shareName" value="${esc(profile.shareName)}" maxlength="40" placeholder="Ex. Camille"></label>
      <p class="hint">Toute personne qui a le lien voit vos albums, collections et éditeurs, y compris l’état, la cote, les photos et les notes. Elle ne peut rien modifier. Votre e-mail n’est jamais montré.</p>
      <div class="share-link ${profile.shareEnabled ? "" : "hidden"}" data-share-link>
        <input readonly value="${esc(shareUrl)}" aria-label="Lien de partage">
        <button class="btn btn-ghost" type="button" data-copy>${icon("link")}Copier</button>
        ${navigator.share ? `<button class="btn btn-ghost" type="button" data-native-share>${icon("share")}Partager</button>` : ""}
        <a class="btn btn-ghost" href="#/p/${esc(ctx.uid)}">${icon("eye")}Voir comme un visiteur</a>
      </div>
      <button class="btn btn-primary" type="button" data-save-share>Enregistrer le partage</button>
    </section>

    <section class="panel">
      <h2>Données</h2>
      <div class="row-actions">
        <a class="btn btn-ghost" href="#/import">${icon("upload")}Importer un fichier CSV</a>
        <button class="btn btn-ghost" type="button" data-recompute>${icon("refresh")}Recalculer les compteurs</button>
      </div>
      <p class="hint">Les compteurs (nombre de BD, albums par collection…) se tiennent à jour tout seuls. Recalculez-les après un import interrompu ou si un chiffre vous semble faux.</p>
      <p class="muted" data-recompute-msg aria-live="polite"></p>
    </section>`);

  // ---- Blocs de l'accueil
  const ul = ctx.el.querySelector("[data-widgets]");
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

  ctx.el.querySelector("[data-save-home]").onclick = async () => {
    const data = { home: { widgets, recentCount: +ctx.el.querySelector("[name=recentCount]").value } };
    try { await updateUserDoc(ctx.uid, data); refreshOwnerDoc(data); toast("Accueil enregistré"); }
    catch (e) { toast(e.message, "error"); }
  };

  // ---- Partage
  const shareBox = ctx.el.querySelector("[data-share-link]");
  const shareCheck = ctx.el.querySelector("[name=shareEnabled]");
  ctx.el.querySelector("[data-save-share]").onclick = async () => {
    const data = { shareEnabled: shareCheck.checked, shareName: ctx.el.querySelector("[name=shareName]").value.trim() };
    try {
      await updateUserDoc(ctx.uid, data);
      refreshOwnerDoc(data);
      shareBox.classList.toggle("hidden", !data.shareEnabled);
      toast(data.shareEnabled ? "Partage activé" : "Partage désactivé");
    } catch (e) { toast(e.message, "error"); }
  };
  ctx.el.querySelector("[data-copy]").onclick = async () => {
    try { await navigator.clipboard.writeText(shareUrl); toast("Lien copié"); }
    catch { shareBox.querySelector("input").select(); }
  };
  ctx.el.querySelector("[data-native-share]")?.addEventListener("click", () => {
    navigator.share({ title: "Ma bédéthèque", url: shareUrl }).catch(() => {});
  });

  // ---- Données
  ctx.el.querySelector("[data-recompute]").onclick = async (e) => {
    const btn = e.currentTarget;
    if (!(await confirmDialog("Le recalcul compte tous vos albums côté serveur. Il coûte peu de lectures (environ 1 par tranche de 1 000 albums, plus 1 par collection).", { title: "Recalculer les compteurs ?", ok: "Recalculer" }))) return;
    const msg = ctx.el.querySelector("[data-recompute-msg]");
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

  ctx.el.querySelector("[data-logout]").onclick = async () => {
    if (await confirmDialog("Vous devrez vous reconnecter pour voir votre bédéthèque.", { title: "Se déconnecter ?", ok: "Se déconnecter" })) {
      await logout();
      location.hash = "#/";
    }
  };
}
