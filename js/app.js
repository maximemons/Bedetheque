import { $, $$, esc } from "./utils.js";
import { icon, errorHtml } from "./ui.js";
import { onUser, completePendingSignIn, bindLoginScreen } from "./auth.js";
import { ensureUser, getUserDoc } from "./db.js";
import { DEFAULT_HOME } from "./constants.js";
import { emptyState } from "./components.js";

import * as home from "./views/home.js";
import * as bds from "./views/bds.js";
import * as bdForm from "./views/bd-form.js";
import * as collections from "./views/collections.js";
import * as publishers from "./views/publishers.js";
import * as account from "./views/account.js";
import * as importer from "./views/import.js";

// [motif, vue, réservé au propriétaire]
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

const state = { user: undefined, ready: false, renderId: 0, cleanups: [], navCount: -1, ownerDoc: null, shareCache: new Map() };

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [pathPart, qs = ""] = raw.split("?");
  const query = new URLSearchParams(qs);
  const m = pathPart.match(/^p\/([^/]+)\/?(.*)$/);
  if (m) return { share: true, uid: m[1], path: m[2].replace(/\/$/, ""), query };
  return { share: false, uid: null, path: pathPart.replace(/\/$/, ""), query };
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
  const { share, uid: shareUid, path, query } = parseHash();
  if (!share && !state.user) {
    runCleanups();
    show("#login-screen");
    return;
  }
  show("#app");
  runCleanups();
  const id = ++state.renderId;
  const view = $("#view");
  const base = share ? `#/p/${shareUid}/` : "#/";

  const ctx = {
    user: state.user,
    uid: share ? shareUid : state.user.uid,
    readOnly: share,
    query,
    params: [],
    el: view,
    profile: share ? null : state.ownerDoc,
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

  // Barre d'onglets et bandeau de partage
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

  if (share) {
    let owner = state.shareCache.get(shareUid);
    if (!owner) {
      try {
        owner = await getUserDoc(shareUid);
      } catch (err) {
        if (!ctx.alive()) return;
        $("#share-banner").classList.add("hidden");
        ctx.setTitle("Bédéthèque partagée");
        return ctx.render(err?.code === "permission-denied"
          ? emptyState("Cette bédéthèque n’est pas partagée", "Son propriétaire a peut-être désactivé le partage.")
          : errorHtml(err));
      }
      if (owner) state.shareCache.set(shareUid, owner);
    }
    if (!ctx.alive()) return;
    ctx.profile = owner || { home: DEFAULT_HOME };
    const banner = $("#share-banner");
    banner.classList.remove("hidden");
    banner.innerHTML = `${icon("eye")}<span>Lecture seule${owner?.shareName ? ` : la bédéthèque de ${esc(owner.shareName)}` : ""}</span>`;
  } else {
    $("#share-banner").classList.add("hidden");
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

export function refreshOwnerDoc(data) {
  state.ownerDoc = { ...(state.ownerDoc || {}), ...data };
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
    state.navCount = -1;
    route();
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("Service worker", e));
  }
}

start();
