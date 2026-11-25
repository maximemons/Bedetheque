// États d'un album, du meilleur au moins bon.
export const ETATS = [
  { key: "neuf", label: "Neuf", short: "Neuf" },
  { key: "tbe", label: "Très bon état", short: "TBE" },
  { key: "be", label: "Bon état", short: "BE" },
  { key: "ec", label: "État correct", short: "EC" },
  { key: "mauvais", label: "Abîmé", short: "Abîmé" },
  { key: "nc", label: "Non renseigné", short: "—" }
];
export const ETAT_KEYS = ETATS.map((e) => e.key);
export const etatLabel = (k) => (ETATS.find((e) => e.key === k) || ETATS[ETATS.length - 1]).label;
export const etatShort = (k) => (ETATS.find((e) => e.key === k) || ETATS[ETATS.length - 1]).short;

// Cote d'un album : un niveau, sans montant. Stockée en nombre (0 à 3) pour pouvoir trier.
export const COTES = [
  { key: 0, label: "Pas coté", short: "Non" },
  { key: 1, label: "Faiblement coté", short: "Faible" },
  { key: 2, label: "Moyennement coté", short: "Moyenne" },
  { key: 3, label: "Fortement coté", short: "Forte" }
];
export const coteLabel = (n) => (COTES.find((c) => c.key === n) || COTES[0]).label;

// Tris de la liste des BD. Chaque tri correspond à un champ indexé (voir firestore.indexes.json).
export const BD_SORTS = [
  { key: "serie", field: "seriesSort", label: "Série et tome", dir: "asc" },
  { key: "titre", field: "titleLower", label: "Titre", dir: "asc" },
  { key: "ajout", field: "createdAt", label: "Date d’ajout", dir: "desc" },
  { key: "achat", field: "dateAchat", label: "Date d’achat", dir: "desc" },
  { key: "annee", field: "annee", label: "Année de parution", dir: "desc" },
  { key: "cote", field: "cote", label: "Cote", dir: "desc" }
];

export const COLLECTION_SORTS = [
  { key: "nom", field: "nameLower", label: "Nom", dir: "asc" },
  { key: "fournies", field: "ownedCount", label: "Les plus fournies", dir: "desc" },
  { key: "recentes", field: "updatedAt", label: "Modifiées récemment", dir: "desc" }
];

export const PUBLISHER_SORTS = [
  { key: "nom", field: "nameLower", label: "Nom", dir: "asc" },
  { key: "collections", field: "collectionCount", label: "Nombre de collections", dir: "desc" }
];

// Blocs de la page d'accueil, réglables dans « Mon compte ».
export const HOME_WIDGETS = [
  { id: "counts", label: "Chiffres clés (BD, collections, éditeurs)" },
  { id: "lastPurchases", label: "Derniers achats" },
  { id: "lastAdded", label: "Derniers ajouts" },
  { id: "inProgress", label: "Collections à compléter" },
  { id: "cotes", label: "Répartition par cote" },
  { id: "states", label: "Répartition par état" }
];
export const DEFAULT_HOME = {
  widgets: HOME_WIDGETS.map((w) => ({ id: w.id, on: w.id !== "states" })),
  recentCount: 8
};

// Champs reconnus par l'import CSV, avec les en-têtes détectés automatiquement.
export const IMPORT_FIELDS = [
  { key: "isbn", label: "ISBN / EAN", aliases: ["isbn", "ean", "isbn13", "isbn 13", "isbn10", "code barre", "code barres", "codebarre", "gencod"] },
  { key: "titre", label: "Titre de l’album", aliases: ["titre", "title", "album", "titre album", "titre de l album", "nom"] },
  { key: "collection", label: "Collection / série", aliases: ["serie", "series", "collection", "saga", "nom serie", "nom de la serie"] },
  { key: "numero", label: "Numéro (tome)", aliases: ["tome", "numero", "n", "no", "num", "volume", "vol", "t"] },
  { key: "editeur", label: "Éditeur", aliases: ["editeur", "editeurs", "publisher", "maison d edition", "edition"] },
  { key: "scenariste", label: "Scénariste", aliases: ["scenariste", "scenario", "scenaristes", "scenar", "writer"] },
  { key: "dessinateur", label: "Dessinateur", aliases: ["dessinateur", "dessin", "dessinateurs", "illustrateur", "artist"] },
  { key: "coloriste", label: "Coloriste", aliases: ["coloriste", "couleurs", "couleur", "coloristes"] },
  { key: "auteurs", label: "Auteurs (autres)", aliases: ["auteur", "auteurs", "author", "authors"] },
  { key: "annee", label: "Année de parution", aliases: ["annee", "year", "parution", "date parution", "date de parution", "depot legal", "dl", "date publication"] },
  { key: "pages", label: "Pages", aliases: ["pages", "nb pages", "nombre de pages", "pagination"] },
  { key: "etat", label: "État", aliases: ["etat", "condition", "etat album"] },
  { key: "cote", label: "Cote (pas coté, faible, moyenne, forte)", aliases: ["cote", "niveau de cote", "cotation", "rarete"] },
  { key: "dateAchat", label: "Date d’achat", aliases: ["date achat", "date d achat", "achat", "achete le", "date d acquisition", "acquis le"] },
  { key: "eo", label: "Édition originale", aliases: ["eo", "edition originale", "originale"] },
  { key: "couverture", label: "Couverture (URL)", aliases: ["couverture", "cover", "image", "url couverture", "image url"] },
  { key: "notes", label: "Notes", aliases: ["notes", "note", "commentaire", "commentaires", "remarque", "remarques"] },
  { key: "totalVolumes", label: "Nombre de tomes de la série", aliases: ["nb tomes", "nombre de tomes", "total tomes", "tomes parus", "nb albums"] }
];

// Quota gratuit Firestore (offre Spark), par jour.
export const FREE_WRITES_PER_DAY = 20000;
export const FREE_READS_PER_DAY = 50000;
