import { esc } from "./utils.js";

// Icônes en ligne (traits 2 px), pour ne dépendre d'aucune police d'icônes.
const P = {
  home: '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/>',
  books: '<rect x="2.5" y="4" width="5" height="16" rx="1"/><rect x="9" y="4" width="5" height="16" rx="1"/><path d="M15.2 5.4 19 4.4l3.4 14.4-3.8 1z"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  building: '<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.5 3-5.5 6.5-5.5s6.5 2 6.5 5.5"/><path d="M15.5 4.7a3.5 3.5 0 0 1 0 6.6M18 14.8c2.2.6 3.5 2.4 3.5 5.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  back: '<path d="M15 5 8 12l7 7"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M8 8v8M11 8v8M14 8v8M17 8v8"/>',
  grid: '<rect x="4" y="4" width="7" height="7"/><rect x="13" y="4" width="7" height="7"/><rect x="4" y="13" width="7" height="7"/><rect x="13" y="13" width="7" height="7"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h1M4 12h1M4 18h1"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  share: '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="m8.2 10.8 7.6-3.6M8.2 13.2l7.6 3.6"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5M4 20h16"/>',
  sort: '<path d="M7 4v16M4 17l3 3 3-3M17 20V4M14 7l3-3 3 3"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="1"/><circle cx="9" cy="9.5" r="1.8"/><path d="m21 16-5-5-9 9"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7L11.5 7"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  logout: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>',
  google: '<path d="M21 12.2c0-.7-.1-1.3-.2-1.9H12v3.6h5a4.3 4.3 0 0 1-1.9 2.8v2.3h3c1.8-1.6 2.9-4 2.9-6.8z" fill="#4285F4" stroke="none"/><path d="M12 21.5c2.5 0 4.7-.8 6.2-2.3l-3-2.3c-.8.6-1.9.9-3.2.9-2.4 0-4.5-1.6-5.2-3.9H3.7v2.4a9.5 9.5 0 0 0 8.3 5.2z" fill="#34A853" stroke="none"/><path d="M6.8 13.9a5.7 5.7 0 0 1 0-3.7V7.8H3.7a9.5 9.5 0 0 0 0 8.5z" fill="#FBBC05" stroke="none"/><path d="M12 6.4c1.4 0 2.6.5 3.6 1.4l2.7-2.7A9.3 9.3 0 0 0 12 2.5 9.5 9.5 0 0 0 3.7 7.8l3.1 2.4C7.5 7.9 9.6 6.4 12 6.4z" fill="#EA4335" stroke="none"/>'
};

export function icon(name, cls = "") {
  return `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ""}</svg>`;
}

let toastTimer;
export function toast(msg, type = "") {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.setAttribute("role", "status");
    document.body.append(el);
  }
  el.className = `toast show ${type}`;
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), type === "error" ? 6000 : 3000);
}

/** Boîte de confirmation. Résout true/false. */
export function confirmDialog(message, { title = "Confirmer", ok = "Confirmer", danger = false } = {}) {
  return new Promise((resolve) => {
    const d = document.createElement("dialog");
    d.className = "dialog";
    d.innerHTML = `<form method="dialog">
      <h2>${esc(title)}</h2>
      <p>${esc(message)}</p>
      <div class="dialog-actions">
        <button class="btn btn-ghost" value="cancel">Annuler</button>
        <button class="btn ${danger ? "btn-danger" : "btn-primary"}" value="ok">${esc(ok)}</button>
      </div></form>`;
    document.body.append(d);
    d.addEventListener("close", () => { resolve(d.returnValue === "ok"); d.remove(); });
    d.showModal();
  });
}

/** Saisie d'une valeur. Résout la chaîne saisie ou null. */
export function promptDialog(message, { title = "", value = "", type = "text", ok = "Valider", placeholder = "" } = {}) {
  return new Promise((resolve) => {
    const d = document.createElement("dialog");
    d.className = "dialog";
    d.innerHTML = `<form method="dialog">
      ${title ? `<h2>${esc(title)}</h2>` : ""}
      <label class="field"><span>${esc(message)}</span>
      <input name="v" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" required></label>
      <div class="dialog-actions">
        <button class="btn btn-ghost" value="cancel" formnovalidate>Annuler</button>
        <button class="btn btn-primary" value="ok">${esc(ok)}</button>
      </div></form>`;
    document.body.append(d);
    const input = d.querySelector("input");
    d.addEventListener("close", () => { resolve(d.returnValue === "ok" ? input.value.trim() : null); d.remove(); });
    d.showModal();
    input.focus();
  });
}

/** Message d'erreur Firestore lisible, avec le lien de création d'index s'il y en a un. */
export function errorHtml(err) {
  const msg = String(err?.message || err || "Erreur inconnue");
  const link = msg.match(/https:\/\/console\.firebase\.google\.com\S+/);
  if (err?.code === "failed-precondition" && link) {
    return `<div class="notice notice-warn"><p>Cette recherche a besoin d’un index Firestore qui n’existe pas encore.</p>
      <p><a href="${esc(link[0])}" target="_blank" rel="noopener">Créer l’index dans la console Firebase</a> (quelques minutes), ou déployez <code>firestore.indexes.json</code>.</p></div>`;
  }
  if (err?.code === "permission-denied") {
    return `<div class="notice notice-warn"><p>Accès refusé. Cette bédéthèque n’est pas partagée, ou les règles Firestore ne sont pas publiées.</p></div>`;
  }
  return `<div class="notice notice-warn"><p>${esc(msg)}</p></div>`;
}
