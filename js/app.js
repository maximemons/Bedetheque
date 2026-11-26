import { $, $$, esc } from "./utils.js";
import { icon, errorHtml, toast, promptDialog } from "./ui.js";
import { onUser, completePendingSignIn, bindLoginScreen } from "./auth.js";
import {
  emailKey, getAccount, saveAccount, listMyLibraries, getLibrary, createLibrary, getShare,
  findLegacyLibrary, adoptLegacyLibrary, ROLES
} from "./db.js";
import { DEFAULT_HOME } from "./constants.js";
import { emptyState } from "./components.js";

import * as home from "./views/home.js";
import * as bds from "./views/bds.js";
import * as bdForm from "./views/bd-form.js";
import * as collections from "./views/collections.js";
import * as publishers from "./views/publishers.js";
import * as account from "./views/account.js";
import * as importer from "./views/import.js";

/*
 * Adresses :
 *   #/b/<bédéthèque>/…   une de mes bédéthèques (propriétaire ou co-propriétaire)
 *   #/p/<bédéthèque>/…   partage public en lecture seule (sans compte)
 *   #/…                  raccourci : la dernière bédéthèque ouverte (anciens liens compris)
 */

// [motif, vue, modifie] : les vues qui modifient sont interdites en lecture seule.
const ROUTES = [
  [/^$/, home.render, false],
  [/^bds$/, bds.renderList, false],
  [/^bd\/new$/, bdForm.render, true],
  [/^bd\/([^/]+)\/edit$/, bdForm.render, true],
  [/^bd\/([^/]+)$/, bds.renderDetail, false],
  [/^collections$/, collections.renderList, false],
  [/^collection\/new$/, collections.renderForm, true],
  [/^collection\/([^/]+)\/edit$/, collections.renderForm, true],
  [/^collection\/([^/]+)$/, collections.renderDetail, false],
  [/^editeurs$/, publishers.renderList, false],
  [/^editeur\/new$/, publishers.renderForm, true],
  [/^editeur\/([^/]+)\/edit$/, publishers.renderForm, true],
  [/^editeur\/([^/]+)$/, publishers.renderDetail, false],
  [/^compte$/, account.render, true],
  [/^import$/, importer.render, true]
];

const TAB_OF = { "": "home", bds: "bds", bd: "bds", collections: "collections", collection: "collections", editeurs: "editeurs", editeur: "editeurs", compte: "compte", import: "compte" };

const NAV_KEY = "bdt:nav";
const lastLibKey = (key) => `bdt:lastLibrary:${key}`;
const legacyDoneKey = (uid) => `bdt:legacyChecked:${uid}`;

const state = {
  user: undefined,      // undefined = pas encore connu, null = déconnecté
  key: null,            // empreinte de l'adresse e-mail
  account: null,        // réglages du compte
  libs: [],             // mes bédéthèques
  booted: false,        // compte chargé (bédéthèques, réglages)
  bootError: null,
  renderId: 0,
  cleanups: [],
  navCount: -1,
  shareCache: new Map()
};

// ---------------------------------------------------------------- Barre de navigation

/** Position de la barre sur grand écran (sur téléphone elle reste toujours en bas). */
export function applyNavPosition(pos) {
  const p = pos === "right" ? "right" : "left";
  document.documentElement.dataset.nav = p;
  try { localStorage.setItem(NAV_KEY, p); } catch { /* rien */ }
}

// ---------------------------------------------------------------- Compte et bédéthèques

export const currentAccount = () => state.account;
export const myLibraries = () => state.libs;
export const myKey = () => state.key;

export function setAccountLocal(data) {
  state.account = { ...(state.account || {}), ...data };
  if (data.navPosition) applyNavPosition(data.navPosition);
}

/** Relit mes bédéthèques (après une création, un ajout de membre, un départ…). */
export async function refreshLibraries() {
  if (!state.key) return [];
  state.libs = await listMyLibraries(state.key);
  return state.libs;
}

/** Met à jour une bédéthèque en mémoire sans tout relire. */
export function patchLibrary(id, data) {
  const lib = state.libs.find((l) => l.id === id);
  if (lib) Object.assign(lib, data);
}

function rememberLibrary(id) {
  if (!state.key) return;
  try { localStorage.setItem(lastLibKey(state.key), id); } catch { /* rien */ }
  if (state.account && state.account.lastLibrary !== id) {
    state.account.lastLibrary = id;
    saveAccount(state.key, { lastLibrary: id }).catch((e) => console.warn("Dernière bédéthèque", e));
  }
}

function defaultLibraryId() {
  const ids = new Set(state.libs.map((l) => l.id));
  let local = null;
  try { local = localStorage.getItem(lastLibKey(state.key)); } catch { /* rien */ }
  for (const id of [state.account?.lastLibrary, local]) if (id && ids.has(id)) return id;
  return state.libs[0]?.id || null;
}

/** Demande un nom, crée la bédéthèque et l'ouvre. */
export async function createLibraryAndOpen() {
  const name = await promptDialog("Par exemple « Ma bédéthèque », « BD de la maison », « Mangas ».", {
    title: "Nouvelle bédéthèque", placeholder: "Nom de la bédéthèque", ok: "Créer"
  });
  if (!name?.trim()) return null;
  try {
    const lib = await createLibrary(state.key, { name, memberName: state.account?.pseudo || "Propriétaire" });
    await refreshLibraries().catch(() => state.libs.push(lib));
    toast(`Bédéthèque « ${lib.name} » créée`);
    location.hash = `#/b/${lib.id}/`;
    return lib;
  } catch (e) {
    toast(e.message || "Création impossible", "error");
    return null;
  }
}

/**
 * Au premier passage d'un compte : réglages, bédéthèques, reprise éventuelle de
 * l'ancienne bédéthèque (users/{uid}), et création d'une première bédéthèque si besoin.
 */
async function bootAccount(user) {
  state.key = await emailKey(user.email);
  state.account = await getAccount(state.key).catch((e) => { console.warn("Réglages du compte", e); return { navPosition: "left", pseudo: "", lastLibrary: "" }; });
  applyNavPosition(state.account.navPosition);
  state.libs = await listMyLibraries(state.key);

  // Reprise de la bédéthèque de l'ancienne version, une seule fois par compte de connexion.
  const doneKey = legacyDoneKey(user.uid);
  if (!localStorage.getItem(doneKey) && !state.libs.some((l) => l.id === user.uid)) {
    const legacy = await findLegacyLibrary(user.uid).catch(() => null);
    if (legacy && (legacy.hasData || legacy.profile?.shareEnabled || !state.libs.length)) {
      const lib = await adoptLegacyLibrary(user.uid, state.key, legacy, state.account.pseudo || "Propriétaire");
      state.libs.push(lib);
    }
    localStorage.setItem(doneKey, "1");
  }

  if (!state.libs.length) {
    const lib = await createLibrary(state.key, { name: "Ma bédéthèque", memberName: state.account.pseudo || "Propriétaire" });
    state.libs.push(lib);
  }
}

// ---------------------------------------------------------------- Routage

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [pathPart, qs = ""] = raw.split("?");
  const query = new URLSearchParams(qs);
  const m = pathPart.match(/^(p|b)\/([^/]+)\/?(.*)$/);
  if (m) return { mode: m[1] === "p" ? "share" : "member", libId: decodeURIComponent(m[2]), path: m[3].replace(/\/$/, ""), query, qs };
  return { mode: "short", libId: null, path: pathPart.replace(/\/$/, ""), query, qs };
}

function show(id) {
  for (const s of ["#splash", "#login-screen", "#app"]) $(s).classList.toggle("hidden", s !== id);
}

function runCleanups() {
  state.cleanups.splice(0).forEach((fn) => { try { fn(); } catch { /* rien */ } });
}

async function route() {
  if (state.user === undefined) return;
  state.navCount++;
  const { mode, libId: hashLib, path, query, qs } = parseHash();
  const share = mode === "share";

  if (!share) {
    if (!state.user) { runCleanups(); show("#login-screen"); return; }
    if (!state.booted) {
      if (state.bootError) {
        show("#app");
        $("#view").innerHTML = errorHtml(state.bootError) + `<button class="btn btn-primary" type="button" onclick="location.reload()">Réessayer</button>`;
        return;
      }
      show("#splash");
      return;
    }
  }

  // Raccourcis (#/, #/bds, anciens liens…) : vers la dernière bédéthèque ouverte.
  if (mode === "short") {
    const id = defaultLibraryId();
    if (path.startsWith("rejoindre/")) toast("Les invitations se font maintenant par adresse e-mail : demandez au propriétaire de vous ajouter.", "error");
    const target = path.startsWith("rejoindre/") ? "" : path;
    location.replace(`#/b/${id}/${target}${qs ? `?${qs}` : ""}`);
    return;
  }

  show("#app");
  runCleanups();
  const id = ++state.renderId;
  const view = $("#view");
  const base = share ? `#/p/${hashLib}/` : `#/b/${hashLib}/`;

  const ctx = {
    user: state.user,
    key: state.key,
    account: state.account,
    libId: hashLib,
    lib: null,
    role: share ? "visitor" : "editor",
    readOnly: share,
    libraryName: "",
    home: DEFAULT_HOME,
    query,
    params: [],
    el: view,
    alive: () => id === state.renderId,
    link: (p = "") => base + p,
    go: (p) => { location.hash = base + p; },
    render(html) { if (this.alive()) view.innerHTML = html; },
    onCleanup: (fn) => state.cleanups.push(fn),
    setTitle(title, { back = null, kicker = "" } = {}) {
      $("#topbar-title").textContent = title;
      $("#topbar-kicker").textContent = kicker;
      document.title = title ? `${title} · Bédéthèque` : "Bédéthèque";
      const b = $("#btn-back");
      b.classList.toggle("hidden", back === null);
      b.onclick = () => (state.navCount > 0 ? history.back() : (location.hash = base + back));
    },
    setActions(html) { $("#topbar-actions").innerHTML = html; },
    setFab(opts) {
      const fab = $("#fab");
      if (!opts || share) { fab.classList.add("hidden"); return; }
      fab.classList.remove("hidden");
      fab.innerHTML = `${icon("plus")}<span>${esc(opts.label)}</span>`;
      fab.onclick = () => { location.hash = base + opts.href; };
    }
  };

  // Onglets
  const tab = TAB_OF[path.split("/")[0]] || "home";
  $$(".tabbar a").forEach((a) => {
    a.href = base + a.dataset.path;
    a.classList.toggle("active", a.dataset.tab === tab);
    a.toggleAttribute("aria-current", a.dataset.tab === tab);
  });
  $(".tabbar [data-tab=compte]").classList.toggle("hidden", share);
  ctx.setActions("");
  ctx.setFab(null);
  ctx.setTitle("Bédéthèque");
  window.scrollTo(0, 0);
  const banner = $("#share-banner");
  const switcher = $("#lib-switch");

  if (share) {
    switcher.classList.add("hidden");
    let sh = state.shareCache.get(hashLib);
    if (!sh) {
      try { sh = await getShare(hashLib); } catch (err) { sh = err?.code === "permission-denied" ? null : { error: err }; }
      if (sh && !sh.error) state.shareCache.set(hashLib, sh);
    }
    if (!ctx.alive()) return;
    if (!sh || sh.error) {
      banner.classList.add("hidden");
      ctx.setTitle("Bédéthèque partagée");
      return ctx.render(sh?.error ? errorHtml(sh.error) : emptyState("Cette bédéthèque n’est pas partagée", "Son propriétaire a peut-être désactivé le partage."));
    }
    ctx.home = { ...DEFAULT_HOME, ...(sh.home || {}) };
    ctx.libraryName = sh.name || "";
    banner.classList.remove("hidden");
    banner.innerHTML = `${icon("eye")}<span>Lecture seule${sh.name ? ` : ${esc(sh.name)}` : ""}</span>${state.user && state.booted ? `<a href="#/">Mes bédéthèques</a>` : ""}`;
  } else {
    banner.classList.add("hidden");
    let lib = state.libs.find((l) => l.id === hashLib);
    if (!lib) {
      // Peut-être ajouté depuis peu : on relit une fois.
      lib = await getLibrary(hashLib).catch(() => null);
      if (lib) await refreshLibraries().catch(() => state.libs.push(lib));
    }
    if (!ctx.alive()) return;
    if (!lib) {
      switcher.classList.remove("hidden");
      $("#lib-switch-name").textContent = "Mes bédéthèques";
      ctx.setTitle("Bédéthèque introuvable");
      const fallback = defaultLibraryId();
      return ctx.render(emptyState(
        "Vous n’avez pas accès à cette bédéthèque",
        "Elle a peut-être été supprimée, ou vous en avez été retiré. Pour y accéder, son propriétaire doit ajouter votre adresse e-mail.",
        fallback ? `<a class="btn btn-primary" href="#/b/${esc(fallback)}/">Ouvrir ma bédéthèque</a>` : ""));
    }
    ctx.lib = lib;
    ctx.role = lib.members?.[state.key]?.role === "owner" ? "owner" : "editor";
    ctx.libraryName = lib.name || "";
    ctx.home = { ...DEFAULT_HOME, ...(lib.home || {}) };
    rememberLibrary(lib.id);
    switcher.classList.remove("hidden");
    $("#lib-switch-name").textContent = lib.name;
  }

  const found = ROUTES.find(([re]) => re.test(path));
  if (!found || (found[2] && share)) {
    ctx.setTitle("Page introuvable", { back: "" });
    return ctx.render(emptyState("Cette page n’existe pas", "", `<a class="btn btn-primary" href="${ctx.link("")}">Retour à l’accueil</a>`));
  }
  ctx.params = path.match(found[0]).slice(1);
  view.innerHTML = "";
  try {
    await found[1](ctx);
  } catch (err) {
    console.error(err);
    if (ctx.alive()) ctx.render(errorHtml(err));
  }
  if (ctx.alive()) view.focus({ preventScroll: true });
}

/** Ré-affiche la page courante (après un changement de nom, de rôle…). */
export const rerender = () => route();

// ---------------------------------------------------------------- Sélecteur de bédéthèque

function openSwitcher() {
  const current = parseHash().libId;
  const d = document.createElement("dialog");
  d.className = "dialog lib-dialog";
  const rows = state.libs.map((l) => {
    const role = l.members?.[state.key]?.role === "owner" ? "owner" : "editor";
    const n = l.memberKeys?.length || 1;
    return `<li class="${l.id === current ? "current" : ""}">
      <a class="who" href="#/b/${esc(l.id)}/"><strong>${esc(l.name)}</strong>
        <small>${n > 1 ? `${n} membres` : "Vous seul"}${l.shared ? " · partagée par lien" : ""}</small></a>
      <span class="role role-${role === "owner" ? "owner" : "coowner"}">${esc(ROLES[role])}</span>
    </li>`;
  }).join("");
  d.innerHTML = `<form method="dialog">
    <h2>Mes bédéthèques</h2>
    <ul class="member-list">${rows}</ul>
    <div class="dialog-actions">
      <button class="btn btn-ghost" value="cancel">Fermer</button>
      <button class="btn btn-primary" value="new" type="button" data-new>${icon("plus")}Nouvelle</button>
    </div></form>`;
  document.body.append(d);
  d.addEventListener("click", (e) => {
    if (e.target.closest("a")) d.close();
    if (e.target.closest("[data-new]")) { d.close(); createLibraryAndOpen(); }
  });
  d.addEventListener("close", () => d.remove());
  d.showModal();
}

// ---------------------------------------------------------------- Démarrage

async function boot(user) {
  state.booted = false;
  state.bootError = null;
  state.navCount = -1;
  if (user) {
    if (!user.email) {
      state.bootError = new Error("Ce compte n’a pas d’adresse e-mail : impossible de retrouver vos bédéthèques.");
    } else {
      route(); // écran d'attente
      try {
        await bootAccount(user);
        state.booted = true;
      } catch (e) {
        console.error(e);
        state.bootError = e;
      }
    }
  } else {
    state.key = null;
    state.account = null;
    state.libs = [];
  }
  route();
}

async function start() {
  bindLoginScreen();
  $("#lib-switch").onclick = openSwitcher;
  window.addEventListener("hashchange", route);
  await completePendingSignIn();
  onUser((user) => {
    state.user = user;
    boot(user);
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("Service worker", e));
  }
}

start();
