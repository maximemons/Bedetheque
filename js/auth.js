import { auth, googleProvider } from "./firebase-config.js";
import {
  onAuthStateChanged, signInWithPopup, signInWithRedirect, getRedirectResult, signOut,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail,
  sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink, sendEmailVerification
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js";
import { $ } from "./utils.js";
import { promptDialog } from "./ui.js";

const EMAIL_KEY = "bdt:emailForSignIn";

const MESSAGES = {
  "auth/invalid-email": "Cette adresse e-mail n’est pas valide.",
  "auth/missing-password": "Saisissez votre mot de passe.",
  "auth/invalid-credential": "E-mail ou mot de passe incorrect.",
  "auth/wrong-password": "E-mail ou mot de passe incorrect.",
  "auth/user-not-found": "Aucun compte avec cet e-mail. Créez-en un.",
  "auth/email-already-in-use": "Un compte existe déjà avec cet e-mail. Connectez-vous ou utilisez « Mot de passe oublié ».",
  "auth/weak-password": "Le mot de passe doit faire au moins 6 caractères.",
  "auth/too-many-requests": "Trop de tentatives. Réessayez dans quelques minutes.",
  "auth/popup-closed-by-user": "Fenêtre Google fermée avant la fin de la connexion.",
  "auth/unauthorized-domain": "Ce domaine n’est pas autorisé dans Firebase (Authentication › Paramètres › Domaines autorisés).",
  "auth/operation-not-allowed": "Cette méthode de connexion n’est pas activée dans la console Firebase.",
  "auth/invalid-action-code": "Ce lien de connexion a expiré ou a déjà servi. Demandez-en un nouveau.",
  "auth/network-request-failed": "Pas de connexion réseau."
};
const msgFor = (e) => MESSAGES[e?.code] || e?.message || "La connexion a échoué.";

export const onUser = (cb) => onAuthStateChanged(auth, cb);
export const logout = () => signOut(auth);

const appUrl = () => location.origin + location.pathname;

/**
 * Les bédéthèques sont rattachées à une adresse e-mail : elle doit être vérifiée.
 * C'est le cas d'office avec Google et avec le lien de connexion ; avec e-mail + mot de passe,
 * il faut cliquer sur le lien reçu par e-mail.
 */
export const needsVerification = (user) => !!user && !!user.email && !user.emailVerified;

export async function resendVerification() {
  if (!auth.currentUser) return;
  await sendEmailVerification(auth.currentUser, { url: appUrl() });
}

/** Relit l'état du compte et renouvelle le jeton (les règles lisent « email_verified » dans le jeton). */
export async function reloadUser() {
  const u = auth.currentUser;
  if (!u) return null;
  await u.reload();
  await u.getIdToken(true);
  return auth.currentUser;
}

export const authMessage = (e) => msgFor(e);

/** À appeler au démarrage : termine une connexion par lien e-mail ou par redirection Google. */
export async function completePendingSignIn() {
  try {
    await getRedirectResult(auth);
  } catch (e) {
    showError(msgFor(e));
  }
  if (isSignInWithEmailLink(auth, location.href)) {
    let email = localStorage.getItem(EMAIL_KEY);
    if (!email) email = await promptDialog("Confirmez l’e-mail qui a reçu le lien.", { title: "Connexion par lien", type: "email" });
    if (email) {
      try {
        await signInWithEmailLink(auth, email, location.href);
        localStorage.removeItem(EMAIL_KEY);
      } catch (e) {
        showError(msgFor(e));
      }
    }
    history.replaceState(null, "", location.pathname + "#/");
  }
}

function showError(text) {
  const el = $("#login-error");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("hidden", !text);
  $("#login-info")?.classList.add("hidden");
}
function showInfo(text) {
  const el = $("#login-info");
  el.textContent = text;
  el.classList.remove("hidden");
  $("#login-error")?.classList.add("hidden");
}

export function bindLoginScreen() {
  const form = $("#login-form");
  const email = () => form.elements.email.value.trim();
  const password = () => form.elements.password.value;
  const busy = async (btn, fn) => {
    btn.disabled = true;
    try { await fn(); } catch (e) { showError(msgFor(e)); } finally { btn.disabled = false; }
  };

  $("#btn-google").onclick = (e) => busy(e.currentTarget, async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment", "auth/cancelled-popup-request"].includes(err.code)) {
        await signInWithRedirect(auth, googleProvider);
      } else throw err;
    }
  });

  form.onsubmit = (e) => {
    e.preventDefault();
    busy(form.querySelector("[type=submit]"), () => signInWithEmailAndPassword(auth, email(), password()));
  };

  $("#btn-signup").onclick = (e) => busy(e.currentTarget, async () => {
    if (!email() || !password()) return showError("Saisissez un e-mail et un mot de passe (6 caractères minimum).");
    const cred = await createUserWithEmailAndPassword(auth, email(), password());
    await sendEmailVerification(cred.user, { url: appUrl() }).catch((err) => console.warn("Vérification", err));
  });

  $("#btn-reset").onclick = (e) => busy(e.currentTarget, async () => {
    if (!email()) return showError("Saisissez votre e-mail, puis appuyez de nouveau sur « Mot de passe oublié ».");
    await sendPasswordResetEmail(auth, email());
    showInfo(`Un e-mail pour choisir un nouveau mot de passe a été envoyé à ${email()}.`);
  });

  $("#btn-link").onclick = (e) => busy(e.currentTarget, async () => {
    if (!email()) return showError("Saisissez votre e-mail pour recevoir le lien.");
    await sendSignInLinkToEmail(auth, email(), { url: appUrl(), handleCodeInApp: true });
    localStorage.setItem(EMAIL_KEY, email());
    showInfo(`Lien envoyé à ${email()}. Ouvrez-le sur cet appareil pour vous connecter.`);
  });
}
