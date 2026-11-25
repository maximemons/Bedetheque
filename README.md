# Bédéthèque

Une bédéthèque personnelle, pensée pour le téléphone : albums, collections (séries) et éditeurs, avec l’état, la cote, le numéro de tome, les tomes manquants, le scan du code-barres et l’import CSV de masse. Site statique (aucune compilation), hébergeable sur GitHub Pages, avec Firebase pour la connexion et la base de données.

## Ce que fait l’appli

**Albums (BD)**
- Ajout à la main ou par **scan du code-barres** (caméra du téléphone). L’ISBN remplit tout seul titre, série, tome, éditeur, auteurs, année, pages, couverture et résumé, depuis **Google Books** et **Open Library** (sources ouvertes, sans clé). Les champs déjà saisis ne sont jamais écrasés.
- Chaque album a un **état** (Neuf, Très bon état, Bon état, État correct, Abîmé), une **cote** en niveaux (pas coté, faiblement, moyennement, fortement coté), une date d’achat, une case « édition originale », des notes. Le site n’affiche aucun montant.
- **Couverture** : trouvée automatiquement depuis l’ISBN, ou **prise en photo avec le téléphone** (ou choisie dans la galerie), ou donnée par une adresse d’image.
- Bouton **Ajouter et scanner le suivant** : enchaîne les tomes d’une même série (collection et numéro suivant pré-remplis).
- Avertissement si l’ISBN est déjà dans la bédéthèque (on peut quand même ajouter un deuxième exemplaire).

**Recherche et tri**
- Une seule barre cherche dans le titre, la série, l’éditeur, les auteurs, l’année et l’ISBN (début de mot : « ast gaul » trouve « Astérix le Gaulois »). Le bouton de scan cherche par code-barres.
- Tri par série et tome, titre, date d’ajout, date d’achat, année, cote ; filtre par état, cote, collection, éditeur ; affichage en couvertures ou en liste.

**Collections**
- Nombre de tomes de la série et nombre possédé, avec une **planche de cases** (une case par tome, pleine si on l’a) et la liste des **manquants**. Un appui sur une case vide ajoute ce tome.
- Une collection se crée toute seule quand on ajoute un album d’une nouvelle série. Renommer une collection ou changer son éditeur met à jour ses albums.

**Éditeurs**
- Nombre de collections chez chaque éditeur, liste de ses collections, accès à tous ses albums.

**Accueil réglable** (Mon compte › Page d’accueil) : chiffres clés, derniers achats, derniers ajouts, collections à compléter, répartition par cote, répartition par état. On choisit les blocs, leur ordre et le nombre d’albums affichés.

**Partage en lecture seule** (Mon compte › Partage) : un lien `…/#/p/<identifiant>` montre la bédéthèque sans permettre de la modifier, même à quelqu’un sans compte. Le partage se coupe d’un clic.

**Connexion** : Google, e-mail + mot de passe, ou e-mail seul avec un **lien de connexion** (sans mot de passe).

**Hors connexion** : l’appli s’ouvre sans réseau (service worker) et les données déjà vues restent consultables (cache local Firestore). Les ajouts faits hors ligne partent au retour du réseau.

## Conçu pour des dizaines de milliers d’albums

Rien n’est jamais chargé en entier :

- **Listes paginées** (30 par page, chargement au défilement).
- **Compteurs tenus à jour par incréments** (`users/{uid}/meta/stats`, `ownedCount` des collections, `collectionCount` des éditeurs) : l’accueil coûte quelques lectures, que l’on ait 50 ou 50 000 albums.
- **Recherche indexée** : chaque album porte un tableau `keywords` (débuts de mots de 2 à 15 lettres, ISBN, année). Une recherche = une requête `array-contains`, filtrée ensuite sur les autres mots.
- **Autocomplétion** des collections et éditeurs : quelques documents lus à chaque frappe, jamais la liste complète.
- **Recalcul des compteurs** (Mon compte › Données) par requêtes d’agrégation : environ 1 lecture par tranche de 1 000 albums, plus 1 par collection.

## Import CSV de masse

Mon compte › Données (en bas de la page) › **Importer un fichier CSV**.

1. **Fichier** : CSV avec une ligne d’en-tête, séparateur `;` ou `,` détecté tout seul. Choisir « Windows » si les accents sortent mal (vieux exports Excel). Un modèle est téléchargeable dans la page, et `exemple-import.csv` est fourni.
2. **Colonnes** : reconnues automatiquement (ISBN, Titre, Série, Tome, Éditeur, Scénariste, Dessinateur, Coloriste, Auteurs, Année, Pages, État, Cote, Date d’achat, EO, Couverture, Notes, Nb tomes), corrigeables une à une. La cote s’écrit en toutes lettres (« pas coté », « faiblement », « moyennement », « fortement coté ») ou de 0 à 3. Si seule une colonne « Titre » du type « Astérix - Tome 12 - … » existe, série et tome en sont extraits.
3. **Ligne de départ et ligne d’arrivée** : numéros de ligne du fichier, l’en-tête étant la ligne 1. Raccourcis 1 000 / 5 000 / 15 000 lignes. L’estimation des écritures s’affiche avant de lancer.

Pendant l’import :
- les lignes partent par **lots de 150** (un lot Firestore = 500 écritures au plus) ;
- chaque album importé a un **identifiant stable** (`isbn-<ISBN>`, ou une empreinte série + tome + titre) : les lignes déjà importées sont **ignorées**, on peut relancer une plage sans créer de doublon ;
- la **dernière ligne importée est mémorisée** sur l’appareil pour ce fichier : la page propose de reprendre à la ligne suivante ;
- si Firestore refuse ou ne confirme plus (quota du jour atteint), l’import s’arrête proprement et indique la ligne de reprise ;
- l’écran reste allumé si le navigateur le permet ; le bouton **Arrêter après ce lot** met en pause.

**Quota** : l’offre gratuite Spark permet **20 000 écritures et 50 000 lectures par jour**. Un import coûte environ 1 écriture par album (+ ~10 par lot pour les collections, éditeurs et compteurs). Pour 30 000 lignes : par exemple lignes 2 à 15 001 le premier jour, 15 002 à 30 001 le lendemain. Sur l’offre Blaze, il n’y a pas de limite quotidienne.

L’option « Compléter les infos manquantes depuis l’ISBN » interroge Google Books et Open Library pour chaque ligne (environ 1 seconde par album) : à réserver aux petits lots.

## Mise en route Firebase

Projet : `bedetheque-706f1` (déjà renseigné dans `js/firebase-config.js` et `.firebaserc`).

1. **Authentication › Méthodes de connexion** : activer
   - **Google** ;
   - **Adresse e-mail/Mot de passe**, avec l’option **Lien envoyé par e-mail (connexion sans mot de passe)**.
2. **Authentication › Paramètres › Domaines autorisés** : ajouter le domaine GitHub Pages, par exemple `monpseudo.github.io`.
3. **Firestore Database** : créer la base (mode production, région `eur3` ou `europe-west` conseillée).
4. **Règles et index** : publier `firestore.rules` et `firestore.indexes.json`.

   ```bash
   npm install -g firebase-tools
   firebase login
   firebase deploy --only firestore
   ```

   Sans la CLI : copier `firestore.rules` dans Console › Firestore › Règles. Pour les index, l’appli affiche un lien « Créer l’index » la première fois qu’une recherche en a besoin (création en quelques minutes) ; la CLI les crée tous d’un coup (64 index composites), et exclut de l’indexation les champs d’image.
5. Conseillé : dans Google Cloud › API et services › Identifiants, **restreindre la clé API** aux référents `https://monpseudo.github.io/*` et `https://bedetheque-706f1.firebaseapp.com/*`. La clé d’une app web Firebase n’est pas un secret, la protection des données repose sur les règles Firestore, mais la restriction limite les abus.

## Héberger sur GitHub Pages

1. Pousser le contenu de ce dossier à la racine d’un dépôt (le fichier `.nojekyll` est nécessaire).
2. Dépôt › Settings › Pages › Source : **Deploy from a branch**, branche `main`, dossier `/ (root)`.
3. Le site est servi en HTTPS, ce qu’exige la caméra pour le scan.

Après une mise à jour, augmenter `CACHE` dans `sw.js` (`bedetheque-v2`…) pour que les téléphones prennent la nouvelle version sans attendre.

Le site fonctionne aussi avec Firebase Hosting : `firebase deploy --only hosting`.

## Confidentialité et partage

- Chaque compte ne lit et n’écrit que ses propres données (`firestore.rules`).
- Aucune donnée d’identité (e-mail, nom) n’est enregistrée dans Firestore : le document `users/{uid}` ne contient que le réglage du partage, le nom affiché choisi par l’utilisateur et les réglages de l’accueil.
- Quand le partage est actif, **tous les champs des albums sont lisibles** par les visiteurs, y compris cotes, dates d’achat, photos et notes. Ne pas mettre d’informations personnelles dans les notes d’une bédéthèque partagée.
- Les recherches ISBN partent directement du navigateur vers Google Books et Open Library (seul l’ISBN est envoyé).

## Photos de couverture

- Sur la fiche d’ajout ou de modification : **Prendre une photo** ouvre l’appareil photo, **Choisir une image** ouvre la galerie.
- La photo est réduite et compressée sur le téléphone avant l’envoi, en deux versions : une vignette (environ 25 Ko) dans l’album, pour que les listes restent rapides, et une version nette (environ 200 Ko au plus) dans `users/{uid}/covers/{id}`, lue seulement à l’ouverture de la fiche.
- Tout est stocké dans Firestore : pas besoin de Firebase Storage, qui exige l’offre Blaze sur les nouveaux projets. Une photo compte comme une écriture de plus.
- Une photo remplace la couverture trouvée par ISBN ; « Retirer la couverture » la supprime.

## Scan du code-barres

- Chrome sur Android utilise le détecteur natif du navigateur (`BarcodeDetector`).
- Safari sur iPhone et les autres navigateurs utilisent la bibliothèque `html5-qrcode` (fournie dans `js/vendor/`, chargée seulement quand on scanne).
- Seuls les codes EAN-13 en 978/979 (ISBN) sont acceptés ; on peut toujours taper l’ISBN à la main dans le scanner.

## Structure

```
index.html                 squelette de l'appli (connexion, barre du haut, onglets)
css/style.css              styles (mobile d'abord, clair et sombre)
js/firebase-config.js      configuration et initialisation Firebase
js/fs.js                   point d'entrée unique du SDK Firestore
js/app.js                  routeur, écran de connexion ou appli, mode partage
js/auth.js                 connexion Google, e-mail/mot de passe, lien e-mail
js/db.js                   accès aux données : listes paginées, compteurs, import, recalcul
js/isbn.js                 validation ISBN, recherche Google Books / Open Library
js/image.js                compression des photos de couverture
js/scanner.js              scan du code-barres (natif ou html5-qrcode)
js/components.js           couvertures, lignes, planche des tomes, pagination
js/ui.js                   icônes, messages, boîtes de dialogue
js/utils.js                normalisation, mots-clés, dates, montants
js/constants.js            états, tris, blocs de l'accueil, colonnes d'import
js/views/home.js           accueil
js/views/bds.js            liste et fiche album
js/views/bd-form.js        ajout et modification d'un album
js/views/collections.js    liste, fiche et formulaire collection
js/views/publishers.js     liste, fiche et formulaire éditeur
js/views/account.js        compte : accueil, partage, données
js/views/import.js         import CSV de masse
js/vendor/                 papaparse (MIT), html5-qrcode (Apache-2.0)
sw.js                      service worker (appli hors connexion)
manifest.webmanifest       installation sur l'écran d'accueil
firestore.rules            règles d'accès
firestore.indexes.json     index composites
firebase.json, .firebaserc configuration Firebase CLI
exemple-import.csv         fichier d'exemple pour l'import
```

## Données Firestore

```
users/{uid}                    shareEnabled, shareName, home { widgets[], recentCount }
users/{uid}/meta/stats         bdCount, collectionCount, publisherCount, etat { neuf, tbe, be, ec, mauvais, nc }, cote { 0, 1, 2, 3 }
users/{uid}/bds/{id}           isbn, titre, collectionId, collectionName, numero, publisherId, publisherName,
                               scenariste, dessinateur, coloriste, auteurs, annee, pages, couverture, hasCoverPhoto, resume,
                               etat, cote (0 pas coté … 3 fortement coté), dateAchat (AAAA-MM-JJ), eo, notes,
                               titleLower, seriesSort, keywords[], createdAt, updatedAt
users/{uid}/collections/{id}   name, nameLower, publisherId, publisherName, totalVolumes, ownedCount, notes, keywords[]
users/{uid}/publishers/{id}    name, nameLower, collectionCount, notes, keywords[]
users/{uid}/covers/{bdId}      data (photo de couverture en grand, JPEG)
```

Les champs triables existent toujours (éventuellement à `null`), sinon Firestore exclurait l’album des tris.

## Navigation

```
#/                      accueil
#/bds?q=&sort=&dir=&etat=&cote=&col=&pub=    albums
#/bd/new?isbn=&col=&num=&scan=1        ajout
#/bd/<id>  #/bd/<id>/edit
#/collections  #/collection/<id>  #/collection/new  #/collection/<id>/edit
#/editeurs     #/editeur/<id>     #/editeur/new     #/editeur/<id>/edit
#/compte  #/import
#/p/<uid>/…             mêmes pages en lecture seule (partage)
```
