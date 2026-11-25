import { isBookEan, normalizeIsbn, isValidIsbn } from "./isbn.js";
import { icon } from "./ui.js";

let libPromise;
function loadFallbackLib() {
  if (!libPromise) {
    libPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "./js/vendor/html5-qrcode.min.js";
      s.onload = () => resolve(window.__Html5QrcodeLibrary__);
      s.onerror = () => { libPromise = null; reject(new Error("Lecteur de code-barres indisponible")); };
      document.head.append(s);
    });
  }
  return libPromise;
}

async function nativeSupported() {
  if (!("BarcodeDetector" in window)) return false;
  try {
    const f = await window.BarcodeDetector.getSupportedFormats();
    return f.includes("ean_13");
  } catch {
    return false;
  }
}

/**
 * Ouvre la caméra et résout l'ISBN-13 lu (ou saisi), ou null si on ferme.
 * La caméra exige HTTPS : c'est le cas sur GitHub Pages.
 */
export function scanIsbn() {
  return new Promise((resolve) => {
    const ov = document.createElement("div");
    ov.className = "scanner";
    ov.setAttribute("role", "dialog");
    ov.setAttribute("aria-label", "Scanner un code-barres");
    ov.innerHTML = `
      <div class="scanner-head">
        <p>Visez le code-barres au dos de l’album</p>
        <button class="icon-btn" type="button" data-close aria-label="Fermer">${icon("close")}</button>
      </div>
      <div class="scanner-view">
        <video playsinline muted></video>
        <div id="scanner-h5"></div>
        <div class="scanner-frame" aria-hidden="true"></div>
      </div>
      <p class="scanner-msg" aria-live="polite">Ouverture de la caméra…</p>
      <form class="scanner-manual">
        <input inputmode="numeric" autocomplete="off" placeholder="Ou tapez l’ISBN" aria-label="ISBN">
        <button class="btn btn-primary" type="submit">Valider</button>
      </form>`;
    document.body.append(ov);
    document.body.classList.add("no-scroll");

    const video = ov.querySelector("video");
    const msg = ov.querySelector(".scanner-msg");
    let stream = null, timer = null, h5 = null, done = false;

    const finish = async (val) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
      if (h5) { try { await h5.stop(); h5.clear(); } catch { /* déjà arrêté */ } }
      ov.remove();
      document.body.classList.remove("no-scroll");
      resolve(val);
    };

    const accept = (raw) => {
      const code = normalizeIsbn(raw);
      if (isBookEan(code)) {
        navigator.vibrate?.(60);
        finish(code);
      } else {
        msg.textContent = `Code ${raw} lu, mais ce n’est pas un ISBN. Visez le code qui commence par 978 ou 979.`;
      }
    };

    ov.querySelector("[data-close]").onclick = () => finish(null);
    ov.addEventListener("keydown", (e) => e.key === "Escape" && finish(null));
    ov.querySelector("form").onsubmit = (e) => {
      e.preventDefault();
      const v = e.target.querySelector("input").value;
      if (isValidIsbn(v)) finish(normalizeIsbn(v));
      else msg.textContent = "Cet ISBN n’est pas valide (13 chiffres, ou 10 avec un X final possible).";
    };

    (async () => {
      try {
        if (await nativeSupported()) {
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } }, audio: false });
          video.srcObject = stream;
          await video.play();
          const detector = new window.BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a"] });
          msg.textContent = "Centrez le code-barres dans le cadre.";
          let busy = false;
          timer = setInterval(async () => {
            if (busy || done || video.readyState < 2) return;
            busy = true;
            try {
              const codes = await detector.detect(video);
              if (codes.length) accept(codes[0].rawValue);
            } catch { /* image suivante */ }
            busy = false;
          }, 200);
        } else {
          video.remove();
          const lib = await loadFallbackLib();
          if (done) return;
          const F = lib.Html5QrcodeSupportedFormats;
          h5 = new lib.Html5Qrcode("scanner-h5", { formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A], verbose: false });
          await h5.start(
            { facingMode: "environment" },
            { fps: 12, qrbox: (w, h) => ({ width: Math.floor(Math.min(w * 0.85, 340)), height: Math.floor(Math.min(h * 0.4, 150)) }), aspectRatio: 1.333 },
            (text) => accept(text),
            () => {}
          );
          ov.querySelector(".scanner-frame").remove();
          msg.textContent = "Centrez le code-barres dans le cadre.";
        }
      } catch (err) {
        console.warn(err);
        msg.textContent = err?.name === "NotAllowedError"
          ? "L’accès à la caméra a été refusé. Autorisez-le dans le navigateur, ou tapez l’ISBN."
          : "Caméra indisponible sur cet appareil. Tapez l’ISBN ci-dessous.";
      }
    })();
  });
}
