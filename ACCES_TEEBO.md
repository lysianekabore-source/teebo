# teebo — Accès de démonstration & d'administration

> Ces accès sont fournis pour la recette, la démonstration et la formation.
> ⚠️ À changer impérativement avant toute mise en production réelle.

---

## 1. Console éditeur teebo (approbation des IMF)

| Champ | Valeur |
|---|---|
| URL | `/teebo.html` (console) ou `/login.html` |
| Identifiant | `hello@teebo.africa` |
| Mot de passe | `Teebo#Admin2026` |
| Profil | Éditeur teebo |
| Rôle | Approbation / rejet des demandes d'accès IMF |
| 2FA | Obligatoire (enrôlement à la 1re connexion) |

---

## 2. Démonstration module Objectifs — IMF « Burkina Faso n°1 »

IMF de test : **imf-obj.bf** (code `TBO-BF-000001`).

| Profil | Identifiant (e-mail = login) | Mot de passe | Rôle technique |
|---|---|---|---|
| Administrateur IMF | `direction@imf-obj.bf` | `ImfAdmin#2026` | admin_imf |
| Directeur général | `dg.v7@imf-obj.bf` | `Dg#2026Test` | dg |
| Superviseur | `sup.v7@imf-obj.bf` | `Sup#2026Test` | supervisor |
| Superviseur 2 | `sup2.v7@imf-obj.bf` | (à activer) | supervisor |
| Collectrice 1 | `c1.v7@imf-obj.bf` | (à activer) | collectrice |
| Collectrice 2 | `c2.v7@imf-obj.bf` | (à activer) | collectrice |
| Collectrice 3 | `c3.v7@imf-obj.bf` | (à activer) | collectrice |

> Les comptes « à activer » se créent via l'écran d'activation :
> `POST /api/v1/auth/activate` avec le code d'accès (`code_user`) affiché
> à la création du compte, puis un mot de passe au choix.

**Codes d'accès (login alternatif)** : on peut se connecter avec le code
`TBO-BF-000001-U0000X` à la place de l'e-mail.

---

## 3. Parcours prospect (public — création d'une IMF)

| Étape | Action | Endpoint |
|---|---|---|
| 1 | Déposer une demande d'accès IMF | `POST /api/v1/requests` |
| 2 | Choisir la formule | `POST /api/v1/requests/:id/select-plan` |
| 3 | Valider la facture proforma | `POST /api/v1/requests/:id/validate-proforma` |
| 4 | teebo approuve (console) | `POST /api/v1/teebo/requests/:id/approve` |
| 5 | Activer le compte admin IMF | `POST /api/v1/auth/activate` |

---

## 4. Formules commerciales (référentiel)

| Code | Libellé | Prix (FCFA) | Essai |
|---|---|---|---|
| `starter` | Starter | 4 500 000 | 30 jours |
| `business` | Business | 12 000 000 | 30 jours |
| `enterprise` | Enterprise | 35 000 000 | 30 jours |

---

## 5. Points d'entrée de l'application

| Page | Fichier | Usage |
|---|---|---|
| Accueil | `index.html` | Présentation de la plateforme |
| Connexion | `login.html` | Authentification tous profils |
| Espace IMF | `app.html` | Console de gestion IMF |
| Console teebo | `teebo.html` | Approbations (éditeur) |
| Terrain | `terrain.html` | Vue collectrice (tournée) |
| Démonstration | `demo.html` | Parcours navigable guidé |
| Essai & échéances | `essai.html` | Formules et proforma |
| Autorisations fines | `autorisations.html` | Visibilité inter-entités |
| Terminaux & sécurité | `securite.html` | Appareils et alertes |
| Documentation | `documentation.html` | Guide intégré |

---

## 6. Contacts officiels

- WhatsApp : **+226 50 32 14 32** (wa.me/22650321432)
- E-mail : **hello@teebo.africa**
- Slogan : « La finance à visage humain »

---

## 7. Sécurité — à faire avant production

1. Changer **tous** les mots de passe ci-dessus.
2. Activer la 2FA pour tous les comptes à privilèges.
3. Définir `TEEBO_ADMIN_PASSWORD` avec un secret fort dans les variables d'environnement.
4. Restreindre `CORS_ORIGIN` au domaine réel (ne pas laisser `*`).
5. Servir l'application en HTTPS et poser `Secure` + `HttpOnly` sur le cookie de session.
