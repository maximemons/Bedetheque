import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";

// La clé "apiKey" d'une app web Firebase n'est pas un secret : elle identifie le projet.
// La protection des données repose sur les règles Firestore (voir firestore.rules).
// Conseil : restreindre cette clé aux domaines du site dans Google Cloud › Identifiants.
export const firebaseConfig = {
  apiKey: "AIzaSyDGqOMjWgGFPpxSpImESbXO8iHByzI076A",
  authDomain: "bedetheque-706f1.firebaseapp.com",
  projectId: "bedetheque-706f1",
  storageBucket: "bedetheque-706f1.firebasestorage.app",
  messagingSenderId: "157545723700",
  appId: "1:157545723700:web:4f9bf26936cd0270ec5761"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Cache local persistant : la bédéthèque reste consultable hors connexion,
// et les écritures faites hors ligne partent dès que le réseau revient.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  ignoreUndefinedProperties: true
});

export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });
