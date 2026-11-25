import { importChunk, CommitTimeout } from "../db.js";
import { IMPORT_FIELDS, FREE_WRITES_PER_DAY } from "../constants.js";
import { esc, normalize, parseNumber, parseIntSafe, parseYear, parseDate, parseBool, fmtInt, sleep } from "../utils.js";
import { normalizeIsbn, isValidIsbn, lookupIsbn, parseSeriesTitle } from "../isbn.js";
import { icon, toast } from "../ui.js";

const CHUNK = 150; // lignes par lot : 150 albums + collections + éditeurs + compteurs < 500 écritures
const DEFAULT_SPAN = 5000;

let papaPromise;
function loadPapa() {
  if (!papaPromise) {
    papaPromise = new Promise((resolve, reject) => {
      if (window.Papa) return resolve(window.Papa);
      const s = document.createElement("script");
      s.src = "./js/vendor/papaparse.min.js";
      s.onload = () => resolve(window.Papa);
      s.onerror = () => { papaPromise = null; reject(new Error("Lecteur CSV indisponible")); };
      document.head.append(s);
    });
  }
  return papaPromise;
}

function readText(file, encoding) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsText(file, encoding);
  });
}

function autoMap(headers) {
  const used = new Set();
  const map = {};
  const norm = headers.map((h) => normalize(h));
  for (const f of IMPORT_FIELDS) {
    const aliases = f.aliases.map(normalize);
    let idx = norm.findIndex((h, i) => !used.has(i) && aliases.includes(h));
    if (idx < 0) idx = norm.findIndex((h, i) => !used.has(i) && aliases.some((a) => a.length > 3 && h.includes(a)));
    if (idx >= 0) { used.add(idx); map[f.key] = headers[idx]; }
  }
  return map;
}

function parseEtat(s) {
  const n = normalize(s);
  if (!n) return "nc";
  if (/^(neuf|new|n|mint)$/.test(n) || n.includes("neuf")) return "neuf";
  if (/^(tbe|tb|tres bon|tres bon etat|very good)$/.test(n) || n.includes("tres bon")) return "tbe";
  if (/^(be|b|bon|bon etat|good)$/.test(n) || n.startsWith("bon")) return "be";
  if (/^(ec|moyen|correct|etat correct|assez bon|fair)$/.test(n) || n.includes("correct") || n.includes("moyen")) return "ec";
  if (/(mauvais|abime|use|poor|bad|abime)/.test(n)) return "mauvais";
  return "nc";
}

/** Ligne CSV → données d'album. */
function mapRow(row, mapping) {
  const g = (k) => (mapping[k] ? String(row[mapping[k]] ?? "").trim() : "");
  let titre = g("titre");
  let collectionName = g("collection");
  const numRaw = g("numero");
  let numero = /^\s*hs/i.test(numRaw) ? null : parseIntSafe(numRaw);
  let notes = g("notes");
  if (/^\s*hs/i.test(numRaw)) notes = [notes, `Hors-série ${numRaw}`].filter(Boolean).join(" / ");
  if (!collectionName && titre && !mapping.collection) {
    const p = parseSeriesTitle(titre);
    if (p.serie) { collectionName = p.serie; numero = numero ?? p.numero; titre = p.titre || titre; }
  }
  const rawIsbn = g("isbn");
  const isbn = rawIsbn && isValidIsbn(rawIsbn) ? normalizeIsbn(rawIsbn) : "";
  const cover = g("couverture");
  return {
    bd: {
      isbn, titre, collectionName, numero,
      publisherName: g("editeur"), scenariste: g("scenariste"), dessinateur: g("dessinateur"),
      coloriste: g("coloriste"), auteurs: g("auteurs"),
      annee: parseYear(g("annee")), pages: parseIntSafe(g("pages")),
      etat: parseEtat(g("etat")), cote: parseNumber(g("cote")), prixAchat: parseNumber(g("prixAchat")),
      dateAchat: parseDate(g("dateAchat")), eo: parseBool(g("eo")),
      couverture: /^https?:\/\//i.test(cover) ? cover : "", notes
    },
    badIsbn: rawIsbn && !isbn ? rawIsbn : "",
    totalVolumes: parseIntSafe(g("totalVolumes"))
  };
}

function templateCsv() {
  const head = ["ISBN", "Titre", "Série", "Tome", "Éditeur", "Scénariste", "Dessinateur", "Année", "État", "Cote", "Prix d'achat", "Date d'achat", "EO", "Nb tomes", "Notes"];
  const rows = [
    ["9782205049657", "Le Secret de l'Espadon", "Blake et Mortimer", "1", "Blake et Mortimer", "Edgar P. Jacobs", "Edgar P. Jacobs", "1950", "Bon état", "12", "9,50", "14/03/2024", "non", "30", ""],
    ["", "Astérix le Gaulois", "Astérix", "1", "Hachette", "René Goscinny", "Albert Uderzo", "1961", "TBE", "", "", "2023-12-25", "", "40", "Cadeau"]
  ];
  return "\uFEFF" + [head, ...rows].map((r) => r.map((c) => (/[;"\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(";")).join("\r\n");
}

export async function render(ctx) {
  ctx.setTitle("Importer un CSV", { back: "compte" });
  const st = { file: null, rows: [], headers: [], mapping: {}, running: false, stop: false, wake: null };
  const progressKey = () => `bdt:import:${ctx.uid}:${st.file.name}:${st.file.size}`;
  const lastLine = () => st.rows.length + 1; // l'en-tête est la ligne 1

  ctx.render(`
    <div class="import">
      <section class="panel">
        <h2>1. Le fichier</h2>
        <p class="hint">Un CSV avec une ligne d’en-tête (séparateur virgule ou point-virgule). Les colonnes sont reconnues automatiquement, vous pourrez les corriger.</p>
        <label class="file-drop">
          <input type="file" accept=".csv,.txt,text/csv" data-file>
          <span>${icon("upload")}<strong data-file-label>Choisir un fichier CSV</strong></span>
        </label>
        <label class="field inline"><span>Encodage</span>
          <select data-enc><option value="UTF-8">UTF-8</option><option value="windows-1252">Windows (Excel ancien)</option></select></label>
        <a class="btn btn-ghost" data-template download="modele-bedetheque.csv">${icon("download")}Télécharger un modèle</a>
        <p class="hint" data-file-info aria-live="polite"></p>
      </section>
      <div data-steps class="hidden">
        <section class="panel">
          <h2>2. Les colonnes</h2>
          <p class="hint">Il faut au moins un titre, une série ou un ISBN par ligne.</p>
          <div class="mapping" data-mapping></div>
        </section>
        <section class="panel">
          <h2>3. Les lignes à importer</h2>
          <p class="hint">Numéros de ligne du fichier, l’en-tête étant la ligne 1. Firestore gratuit accepte ${fmtInt(FREE_WRITES_PER_DAY)} écritures par jour : découpez les gros fichiers sur plusieurs jours.</p>
          <div class="cols-2">
            <label class="field"><span>Ligne de départ</span><input type="number" inputmode="numeric" min="2" data-start></label>
            <label class="field"><span>Ligne d’arrivée</span><input type="number" inputmode="numeric" min="2" data-end></label>
          </div>
          <div class="chips">
            <button class="chip" type="button" data-span="1000">1 000 lignes</button>
            <button class="chip" type="button" data-span="5000">5 000 lignes</button>
            <button class="chip" type="button" data-span="15000">15 000 lignes</button>
            <button class="chip" type="button" data-span="all">Jusqu’à la fin</button>
          </div>
          <p class="estimate" data-estimate></p>
          <p class="notice" data-resume hidden></p>
          <label class="check"><input type="checkbox" data-enrich><span>Compléter les infos manquantes (couverture, année…) depuis l’ISBN</span></label>
          <p class="hint">Option lente : environ une seconde par album, à réserver aux petits lots. Les albums déjà présents (même ISBN, ou même série + tome + titre) sont toujours ignorés : vous pouvez relancer une plage sans créer de doublon.</p>
          <div data-preview></div>
          <div class="form-actions">
            <button class="btn btn-primary" type="button" data-run>${icon("upload")}Lancer l’import</button>
          </div>
        </section>
      </div>
      <section class="panel hidden" data-progress>
        <h2>Import en cours</h2>
        <div class="meter meter-lg"><span data-bar style="width:0%"></span></div>
        <p data-status aria-live="polite"></p>
        <dl class="import-counts">
          <dt>Ajoutés</dt><dd data-added>0</dd>
          <dt>Ignorés</dt><dd data-skipped>0</dd>
          <dt>Écritures</dt><dd data-writes>0</dd>
        </dl>
        <div class="form-actions"><button class="btn btn-danger-ghost" type="button" data-stop>Arrêter après ce lot</button></div>
        <details><summary>Journal</summary><ol class="log" data-log></ol></details>
      </section>
    </div>`);

  const $q = (s) => ctx.el.querySelector(s);
  const blobUrl = URL.createObjectURL(new Blob([templateCsv()], { type: "text/csv;charset=utf-8" }));
  $q("[data-template]").href = blobUrl;
  ctx.onCleanup(() => URL.revokeObjectURL(blobUrl));
  ctx.onCleanup(() => { st.stop = true; window.onbeforeunload = null; st.wake?.release?.(); });

  const startIn = $q("[data-start]"), endIn = $q("[data-end]");

  async function loadFile() {
    const file = $q("[data-file]").files[0];
    if (!file) return;
    st.file = file;
    $q("[data-file-label]").textContent = file.name;
    $q("[data-file-info]").textContent = "Lecture du fichier…";
    try {
      const Papa = await loadPapa();
      const text = await readText(file, $q("[data-enc]").value);
      const res = Papa.parse(text, { header: true, skipEmptyLines: false, transformHeader: (h) => h.replace(/^\uFEFF/, "").trim() });
      const rows = res.data;
      while (rows.length && Object.values(rows[rows.length - 1]).every((v) => !String(v ?? "").trim())) rows.pop();
      st.rows = rows;
      st.headers = (res.meta.fields || []).filter(Boolean);
    } catch (e) {
      $q("[data-file-info]").textContent = `Fichier illisible : ${e.message}`;
      return;
    }
    if (!st.headers.length || !st.rows.length) {
      $q("[data-file-info]").textContent = "Ce fichier ne contient pas de lignes de données après l’en-tête.";
      $q("[data-steps]").classList.add("hidden");
      return;
    }
    $q("[data-file-info]").textContent = `${fmtInt(st.rows.length)} lignes de données (lignes 2 à ${fmtInt(lastLine())}), ${st.headers.length} colonnes.`;
    st.mapping = autoMap(st.headers);
    drawMapping();
    const done = parseInt(localStorage.getItem(progressKey()) || "0", 10);
    const resume = $q("[data-resume]");
    if (done >= 2) {
      resume.hidden = false;
      resume.textContent = done >= lastLine()
        ? `Ce fichier a déjà été importé en entier (jusqu’à la ligne ${fmtInt(done)}).`
        : `Un import précédent s’est arrêté à la ligne ${fmtInt(done)}. Reprise proposée à la ligne ${fmtInt(done + 1)}.`;
    } else resume.hidden = true;
    const from = Math.min(Math.max(2, done + 1), lastLine());
    startIn.value = from;
    endIn.value = Math.min(from + DEFAULT_SPAN - 1, lastLine());
    $q("[data-steps]").classList.remove("hidden");
    update();
  }
  $q("[data-file]").onchange = loadFile;
  $q("[data-enc]").onchange = () => st.file && loadFile();

  function drawMapping() {
    const opts = (sel) => `<option value="">Ne pas importer</option>` + st.headers.map((h) => `<option ${h === sel ? "selected" : ""}>${esc(h)}</option>`).join("");
    $q("[data-mapping]").innerHTML = IMPORT_FIELDS.map((f) => `
      <label class="map-row"><span>${esc(f.label)}</span><select data-map="${f.key}">${opts(st.mapping[f.key])}</select></label>`).join("");
    $q("[data-mapping]").onchange = (e) => {
      const k = e.target.dataset.map;
      if (k) { if (e.target.value) st.mapping[k] = e.target.value; else delete st.mapping[k]; update(); }
    };
  }

  function range() {
    const max = lastLine();
    let a = parseInt(startIn.value, 10), b = parseInt(endIn.value, 10);
    if (!Number.isFinite(a)) a = 2;
    if (!Number.isFinite(b)) b = max;
    a = Math.min(Math.max(2, a), max);
    b = Math.min(Math.max(a, b), max);
    return [a, b];
  }

  function update() {
    if (!st.rows.length) return;
    const [a, b] = range();
    const n = b - a + 1;
    const writes = n + Math.ceil(n / CHUNK) * 12;
    const over = writes > FREE_WRITES_PER_DAY * 0.9;
    $q("[data-estimate]").innerHTML = `${fmtInt(n)} ligne${n > 1 ? "s" : ""}, environ <strong>${fmtInt(writes)} écritures</strong> au plus et ${fmtInt(Math.ceil(n / 30) + Math.ceil(n / CHUNK) * 4)} lectures.`
      + (over ? `<br><span class="warn">C’est proche ou au-delà du quota gratuit quotidien. Réduisez la plage, l’import s’arrêtera sinon en cours de route (sans rien perdre).</span>` : "");
    const hasKey = st.mapping.titre || st.mapping.isbn || st.mapping.collection;
    $q("[data-run]").disabled = !hasKey;
    // Aperçu des 3 premières lignes de la plage
    const sample = st.rows.slice(a - 2, a + 1).map((r, i) => ({ line: a + i, ...mapRow(r, st.mapping) }));
    $q("[data-preview]").innerHTML = hasKey ? `<div class="table-wrap"><table class="preview">
      <caption>Aperçu</caption>
      <thead><tr><th>Ligne</th><th>Titre</th><th>Série</th><th>Tome</th><th>Éditeur</th><th>ISBN</th><th>État</th></tr></thead>
      <tbody>${sample.map((s) => `<tr><td>${s.line}</td><td>${esc(s.bd.titre)}</td><td>${esc(s.bd.collectionName)}</td><td>${esc(s.bd.numero ?? "")}</td><td>${esc(s.bd.publisherName)}</td><td>${esc(s.bd.isbn || s.badIsbn)}</td><td>${esc(s.bd.etat)}</td></tr>`).join("")}</tbody>
      </table></div>` : `<p class="form-error">Associez au moins la colonne du titre, de la série ou de l’ISBN.</p>`;
  }
  startIn.oninput = update;
  endIn.oninput = update;
  ctx.el.querySelectorAll("[data-span]").forEach((b) => (b.onclick = () => {
    const [a] = range();
    endIn.value = b.dataset.span === "all" ? lastLine() : Math.min(a + parseInt(b.dataset.span, 10) - 1, lastLine());
    update();
  }));

  const logEl = $q("[data-log]");
  const log = (text, cls = "") => {
    logEl.insertAdjacentHTML("afterbegin", `<li class="${cls}">${esc(text)}</li>`);
    while (logEl.children.length > 300) logEl.lastElementChild.remove();
  };

  $q("[data-stop]").onclick = (e) => { st.stop = true; e.currentTarget.disabled = true; $q("[data-status]").textContent = "Arrêt à la fin du lot en cours…"; };

  $q("[data-run]").onclick = async () => {
    if (st.running) return;
    const [a, b] = range();
    startIn.value = a; endIn.value = b;
    st.running = true; st.stop = false;
    const enrich = $q("[data-enrich]").checked;
    $q("[data-steps]").classList.add("hidden");
    $q("[data-progress]").classList.remove("hidden");
    $q("[data-stop]").disabled = false;
    window.onbeforeunload = () => "Import en cours";
    try { st.wake = await navigator.wakeLock?.request("screen"); } catch { /* facultatif */ }

    const total = b - a + 1;
    let added = 0, skipped = 0, writes = 0, doneUpTo = a - 1, failure = null;
    const bar = $q("[data-bar]"), status = $q("[data-status]");

    for (let from = a; from <= b; from += CHUNK) {
      if (st.stop || !ctx.alive()) break;
      const to = Math.min(from + CHUNK - 1, b);
      status.textContent = `Lignes ${fmtInt(from)} à ${fmtInt(to)} sur ${fmtInt(a)}–${fmtInt(b)}…`;
      const entries = [];
      for (let line = from; line <= to; line++) {
        const row = st.rows[line - 2];
        if (!row || Object.values(row).every((v) => !String(v ?? "").trim())) { skipped++; continue; }
        const m = mapRow(row, st.mapping);
        if (!m.bd.titre && !m.bd.isbn && !m.bd.collectionName) { skipped++; log(`Ligne ${line} ignorée : ni titre, ni série, ni ISBN.`, "warn"); continue; }
        if (m.badIsbn) log(`Ligne ${line} : ISBN « ${m.badIsbn} » invalide, album importé sans ISBN.`, "warn");
        entries.push({ line, bd: m.bd, totalVolumes: m.totalVolumes });
      }
      if (enrich) {
        for (const e of entries) {
          if (st.stop) break;
          if (!e.bd.isbn || (e.bd.titre && e.bd.couverture && e.bd.annee)) continue;
          const info = await lookupIsbn(e.bd.isbn, { coverProbe: false }).catch(() => null);
          if (info) for (const k of ["titre", "collectionName", "numero", "publisherName", "scenariste", "dessinateur", "annee", "pages", "couverture"]) if (!e.bd[k] && info[k]) e.bd[k] = info[k];
          await sleep(300);
        }
      }
      try {
        const res = await importChunk(ctx.uid, entries);
        added += res.added;
        skipped += res.skipped.length;
        writes += res.writes;
        res.skipped.forEach((s) => log(`Ligne ${s.line} ignorée : ${s.reason}.`));
        doneUpTo = to;
        localStorage.setItem(progressKey(), String(to));
      } catch (err) {
        failure = err;
        break;
      }
      if (!ctx.alive()) return;
      bar.style.width = `${Math.round(((doneUpTo - a + 1) / total) * 100)}%`;
      $q("[data-added]").textContent = fmtInt(added);
      $q("[data-skipped]").textContent = fmtInt(skipped);
      $q("[data-writes]").textContent = fmtInt(writes);
      await sleep(150);
    }

    st.running = false;
    window.onbeforeunload = null;
    try { await st.wake?.release(); } catch { /* rien */ }
    if (!ctx.alive()) return;
    $q("[data-added]").textContent = fmtInt(added);
    $q("[data-skipped]").textContent = fmtInt(skipped);
    $q("[data-writes]").textContent = fmtInt(writes);
    $q("[data-stop]").classList.add("hidden");

    const next = doneUpTo + 1;
    let text;
    if (failure) {
      const quota = failure?.code === "resource-exhausted" || failure instanceof CommitTimeout;
      text = quota
        ? `Firestore a refusé ou n’a pas confirmé les écritures, sans doute parce que le quota du jour est atteint. Lignes ${fmtInt(a)} à ${fmtInt(doneUpTo)} importées. Reprenez demain à la ligne ${fmtInt(next)} : les lignes déjà passées seront ignorées.`
        : `Arrêt sur une erreur (${failure.message}). Lignes ${fmtInt(a)} à ${fmtInt(doneUpTo)} importées. Reprenez à la ligne ${fmtInt(next)}.`;
      log(text, "err");
    } else if (doneUpTo < b) {
      text = `Import arrêté. Lignes ${fmtInt(a)} à ${fmtInt(doneUpTo)} traitées. Prochaine ligne : ${fmtInt(next)}.`;
    } else {
      text = `Terminé : ${fmtInt(added)} album${added > 1 ? "s" : ""} ajouté${added > 1 ? "s" : ""}, ${fmtInt(skipped)} ignoré${skipped > 1 ? "s" : ""}.` + (b < lastLine() ? ` Prochaine plage à partir de la ligne ${fmtInt(next)}.` : "");
      toast("Import terminé");
    }
    status.innerHTML = `${esc(text)}`;
    $q("[data-progress] .form-actions").insertAdjacentHTML("beforeend",
      `<button class="btn btn-primary" type="button" data-again>Importer une autre plage</button><a class="btn btn-ghost" href="${ctx.link("bds?sort=ajout")}">Voir les albums ajoutés</a>`);
    $q("[data-again]").onclick = () => {
      $q("[data-progress]").classList.add("hidden");
      $q("[data-steps]").classList.remove("hidden");
      const from = Math.min(next, lastLine());
      startIn.value = from;
      endIn.value = Math.min(from + DEFAULT_SPAN - 1, lastLine());
      logEl.innerHTML = "";
      $q("[data-progress] .form-actions").innerHTML = `<button class="btn btn-danger-ghost" type="button" data-stop>Arrêter après ce lot</button>`;
      $q("[data-stop]").onclick = (e) => { st.stop = true; e.currentTarget.disabled = true; };
      update();
    };
  };
}
