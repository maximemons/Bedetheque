import { $, $$, esc } from "./utils.js";
import { icon, errorHtml } from "./ui.js";
import { onUser, completePendingSignIn, bindLoginScreen } from "./auth.js";
import { ensureUser, getUserDoc, getMembership } from "./db.js";
import { DEFAULT_HOME } from "./constants.js";
import { emptyState } from "./components.js";

import * as home from "./views/home.js";
import * as bds from "./views/bds.js";
import * as bdForm from "./views/bd-form.js";
import * as collections from "./views/collections.js";
import * as publishers from "./views/publishers.js";
import * as account from "./views/account.js";
import * as importer from "./views/import.js";
import * as join from "./views/join.js";

// Accès : 0 = tout le monde (y compris visiteurs du partage), 1 = propriétaire et co-propriétaires,
// 2 = uniquement dans son propre espace (pas sous #/p/ ni #/b/).
// [motif, vue, accès]
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
  [/^import$/, importer.render, true],
  [/^rejoindre\/([^/]+)\/([^/]+)$/, join.render, 2]
];

const TAB_OF = { "": "home", bds: "bds", bd: "bds", collections: "collections", collection: "collections", editeurs: "editeurs", editeur: "editeurs", compte: "compte", import: "compte", rejoindre: "compte" };

const PENDING_JOIN = "bdt:pendingJoin";
const lastLibKey = (uid) => `bdt:lastLibrary:${uid}`;

const state = { user: undefined, ready: false, renderId: 0, cleanups: [], navCount: -1, ownerDoc: null, shareCache: new Map(), libCache: new Map() };

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [pathPart, qs = ""] = raw.split("?");
  const query = new URLSearchParams(qs);
  // #/p/<uid>/… : visiteur (lecture seule) ; #/b/<uid>/… : co-propriétaire (accès complet)
  const m = pathPart.match(/^(p|b)\/([^/]+)\/?(.*)$/);
  if (m) return { mode: m[1] === "p" ? "share" : "coowner", uid: m[2], path: m[3].replace(/\/$/, ""), query };
  return { mode: "own", uid: null, path: pathPart.replace(/\/$/, ""), query };
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
  const { mode, uid: libUid, path, query } = parseHash();
  const share = mode === "share";
  const coowner = mode === "coowner";
  if (!share && !state.user) {
    // Lien d'invitation ouvert sans être connecté : on le reprendra après la connexion.
    if (path.startsWith("rejoindre/")) localStorage.setItem(PENDING_JOIN, location.hash);
    runCleanups();
    show("#login-screen");
    return;
  }
  // Sa propre bédéthèque ouverte en mode co-propriétaire : on revient à l'adresse normale.
  if (coowner && libUid === state.user.uid) {
    location.replace("#/" + path);
    return;
  }
  show("#app");
  runCleanups();
  const id = ++state.renderId;
  const view = $("#view");
  const base = share ? `#/p/${libUid}/` : coowner ? `#/b/${libUid}/` : "#/";

  const ctx = {
    user: state.user,
    uid: share || coowner ? libUid : state.user.uid,
    role: share ? "visitor" : coowner ? "coowner" : "owner",
    readOnly: share,
    libraryName: "",
    query,
    params: [],
    el: view,
    profile: share || coowner ? null : state.ownerDoc,
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

  // Barre d'onglets et bandeau
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
  banner.classList.remove("coowner");

  if (share) {
    let owner = state.shareCache.get(libUid);
    if (!owner) {
      try {
        owner = await getUserDoc(libUid);
      } catch (err) {
        if (!ctx.alive()) return;
        banner.classList.add("hidden");
        ctx.setTitle("Bédéthèque partagée");
        return ctx.render(err?.code === "permission-denied"
          ? emptyState("Cette bédéthèque n’est pas partagée", "Son propriétaire a peut-être désactivé le partage.")
          : errorHtml(err));
      }
      if (owner) state.shareCache.set(libUid, owner);
    }
    if (!ctx.alive()) return;
    ctx.profile = owner || { home: DEFAULT_HOME };
    ctx.libraryName = owner?.shareName || "";
    banner.classList.remove("hidden");
    banner.innerHTML = `${icon("eye")}<span>Lecture seule${owner?.shareName ? ` : la bédéthèque de ${esc(owner.shareName)}` : ""}</span>`;
  } else if (coowner) {
    let lib = state.libCache.get(libUid);
    if (!lib) {
      try {
        const me = await getMembership(libUid, state.user.uid);
        const owner = me ? await getUserDoc(libUid) : null;
        lib = me ? { me, owner: owner || {} } : null;
      } catch (err) {
        lib = err?.code === "permission-denied" ? null : { error: err };
      }
      if (lib && !lib.error) state.libCache.set(libUid, lib);
    }
    if (!ctx.alive()) return;
    if (!lib || lib.error) {
      banner.classList.add("hidden");
      if (localStorage.getItem(lastLibKey(state.user.uid)) === libUid) localStorage.removeItem(lastLibKey(state.user.uid));
      ctx.setTitle("Bédéthèque partagée");
      $(".tabbar [data-tab=compte]").href = "#/compte";
      return ctx.render(lib?.error ? errorHtml(lib.error) : emptyState(
        "Vous n’êtes pas co-propriétaire de cette bédéthèque",
        "Le propriétaire vous a peut-être retiré, ou le lien est incorrect.",
        `<a class="btn btn-primary" href="#/">Ouvrir ma bédéthèque</a>`));
    }
    ctx.profile = { home: DEFAULT_HOME, ...lib.owner };
    ctx.libraryName = lib.owner.shareName || "";
    localStorage.setItem(lastLibKey(state.user.uid), libUid);
    banner.classList.remove("hidden");
    banner.classList.add("coowner");
    banner.innerHTML = `${icon("users")}<span>Co-propriétaire${ctx.libraryName ? ` : la bédéthèque de ${esc(ctx.libraryName)}` : ""}</span><a href="#/">Ma bédéthèque</a>`;
  } else {
    banner.classList.add("hidden");
    if (!path.startsWith("rejoindre/")) localStorage.removeItem(lastLibKey(state.user.uid));
  }

  const found = ROUTES.find(([re]) => re.test(path));
  if (!found || (found[2] === true && share) || (found[2] === 2 && mode !== "own")) {
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

export function refreshOwnerDoc(data) {
  state.ownerDoc = { ...(state.ownerDoc || {}), ...data };
}

/** Oublie ce qu'on sait d'une bédéthèque partagée (après l'avoir quittée ou rejointe). */
export function forgetLibrary(ownerUid) {
  state.libCache.delete(ownerUid);
  if (state.user && localStorage.getItem(lastLibKey(state.user.uid)) === ownerUid) localStorage.removeItem(lastLibKey(state.user.uid));
}

async function start() {
  bindLoginScreen();
  window.addEventListener("hashchange", route);
  await completePendingSignIn();
  onUser(async (user) => {
    state.user = user;
    if (user) {
      try {
        await ensureUser(user.uid);
        state.ownerDoc = await getUserDoc(user.uid);
      } catch (e) {
        console.error(e);
      }
    } else {
      state.ownerDoc = null;
    }
    state.libCache.clear();
    state.navCount = -1;
    if (user) {
      // Invitation ouverte avant la connexion : on y retourne.
      const pending = localStorage.getItem(PENDING_JOIN);
      if (pending) {
        localStorage.removeItem(PENDING_JOIN);
        if (location.hash !== pending) { location.hash = pending; return; }
      } else if (/^#?\/?$/.test(location.hash)) {
        // Au lancement, on rouvre la dernière bédéthèque utilisée (la sienne ou une partagée).
        const last = localStorage.getItem(lastLibKey(user.uid));
        if (last && last !== user.uid) { location.replace(`#/b/${last}/`); return; }
      }
    }
    route();
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("Service worker", e));
  }
}

start();
