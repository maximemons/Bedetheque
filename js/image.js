// Photos de couverture prises avec le téléphone, compressées avant l'envoi.
// Elles sont rangées dans Firestore (pas besoin de Firebase Storage ni de l'offre Blaze) :
//  - une vignette (~15 à 25 Ko) dans l'album lui-même, pour les listes ;
//  - une version plus grande (~100 à 200 Ko) dans users/{uid}/covers/{id}, lue seulement sur la fiche.

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    // Les navigateurs récents appliquent l'orientation EXIF des photos.
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Cette image n’a pas pu être lue. Essayez une photo JPEG ou PNG.")); };
    img.src = url;
  });
}

function toJpeg(img, maxW, maxH, maxBytes) {
  const ratio = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight);
  const w = Math.max(1, Math.round(img.naturalWidth * ratio));
  const h = Math.max(1, Math.round(img.naturalHeight * ratio));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const c = canvas.getContext("2d");
  c.fillStyle = "#fff";
  c.fillRect(0, 0, w, h);
  c.imageSmoothingQuality = "high";
  c.drawImage(img, 0, 0, w, h);
  let q = 0.82, data = canvas.toDataURL("image/jpeg", q);
  // Une data URL fait environ 4/3 de la taille du fichier.
  while (data.length * 0.75 > maxBytes && q > 0.4) {
    q -= 0.08;
    data = canvas.toDataURL("image/jpeg", q);
  }
  return data;
}

/** Fichier image → { thumb, full } en data URL JPEG. */
export async function makeCoverPhoto(file) {
  if (!file || !file.type.startsWith("image/")) throw new Error("Choisissez une image.");
  const img = await loadImage(file);
  return {
    thumb: toJpeg(img, 240, 360, 28 * 1024),
    full: toJpeg(img, 900, 1300, 220 * 1024)
  };
}

export const isDataUrl = (s) => typeof s === "string" && s.startsWith("data:image/");
