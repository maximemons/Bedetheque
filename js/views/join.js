import { getInvite, getMembership, joinLibrary } from "../db.js";
import { forgetLibrary } from "../app.js";
import { esc, fmtDate } from "../utils.js";
import { icon, toast, errorHtml } from "../ui.js";
import { emptyState, spinner } from "../components.js";

/** #/rejoindre/<uid du propriétaire>/<code> : accepter une invitation à devenir co-propriétaire. */
export async function render(ctx) {
  const [ownerUid, code] = ctx.params;
  ctx.setTitle("Invitation", { back: "" });

  if (ownerUid === ctx.user.uid) {
    return ctx.render(emptyState(
      "C’est votre propre invitation",
      "Envoyez ce lien à la personne que vous voulez ajouter comme co-propriétaire. Il ne sert qu’une fois.",
      `<a class="btn btn-primary" href="#/compte">Retour à Mon compte</a>`));
  }

  ctx.render(spinner());
  const already = await getMembership(ownerUid, ctx.user.uid).catch(() => null);
  if (!ctx.alive()) return;
  if (already) {
    location.replace(`#/b/${ownerUid}/`);
    return;
  }

  let invite = null;
  try { invite = await getInvite(ownerUid, code); } catch (e) { if (e?.code !== "permission-denied") return ctx.render(errorHtml(e)); }
  if (!ctx.alive()) return;
  if (!invite) {
    return ctx.render(emptyState(
      "Invitation invalide ou expirée",
      "Un lien d’invitation ne sert qu’une fois et expire au bout de 7 jours. Demandez-en un nouveau au propriétaire.",
      `<a class="btn btn-primary" href="#/">Ouvrir ma bédéthèque</a>`));
  }

  const exp = invite.expiresAt.toDate();
  const expIso = `${exp.getFullYear()}-${String(exp.getMonth() + 1).padStart(2, "0")}-${String(exp.getDate()).padStart(2, "0")}`;
  ctx.render(`
    <section class="panel">
      <h2>${icon("users")} Devenir co-propriétaire</h2>
      <p><strong>${esc(invite.ownerName)}</strong> vous invite à partager sa bédéthèque.</p>
      <p>En tant que co-propriétaire, vous pourrez consulter et modifier toute la bédéthèque : ajouter, modifier et supprimer des albums, des collections et des éditeurs, prendre des photos de couverture, importer un fichier CSV.</p>
      <p class="hint">${esc(invite.ownerName)} reste propriétaire : lui seul règle le partage public, la page d’accueil et la liste des co-propriétaires, et peut vous retirer à tout moment. Votre propre bédéthèque reste séparée. Invitation valable jusqu’au ${esc(fmtDate(expIso))}.</p>
      <label class="field"><span>Votre nom affiché</span><input name="name" maxlength="40" required placeholder="Ex. Camille" autocomplete="off"></label>
      <p class="hint">Visible par le propriétaire et les autres co-propriétaires. Votre e-mail n’est jamais enregistré ni montré.</p>
      <div class="row-actions">
        <button class="btn btn-primary" type="button" data-join>Rejoindre la bédéthèque</button>
        <a class="btn btn-ghost" href="#/">Refuser</a>
      </div>
    </section>`);

  const input = ctx.el.querySelector("[name=name]");
  ctx.el.querySelector("[data-join]").onclick = async (e) => {
    const name = input.value.trim();
    if (!name) { toast("Indiquez le nom affiché aux autres.", "error"); input.focus(); return; }
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await joinLibrary(ownerUid, code, ctx.user.uid, name);
      forgetLibrary(ownerUid);
      toast(`Vous êtes co-propriétaire de la bédéthèque de ${invite.ownerName}`);
      location.hash = `#/b/${ownerUid}/`;
    } catch (err) {
      btn.disabled = false;
      toast(err?.code === "permission-denied" ? "Cette invitation a déjà servi ou a expiré." : (err.message || "Échec"), "error");
    }
  };
}
