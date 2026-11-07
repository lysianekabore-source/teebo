# Guide de déploiement teebo — pas à pas

Ce guide s'adresse à un profil **non technique**. Suivez les étapes dans l'ordre.
Durée estimée : 20 à 30 minutes la première fois.

---

## Ce dont vous avez besoin

- Un ordinateur avec **Node.js 20** installé.
- **PostgreSQL** (base de données) installé, ou un service PostgreSQL en ligne.
- Le fichier **teebo-plateforme.zip** (fourni).
- Un dossier de travail vide (ex. « teebo ») sur votre ordinateur.

---

## ÉTAPE 1 — Récupérer et décompresser les fichiers

1. Téléchargez **teebo-plateforme.zip**.
2. Clic droit sur le fichier → **Extraire tout…** (Windows) ou double-clic (Mac).
3. Vous obtenez un dossier nommé **teebo** contenant `backend`, `frontend`, `db`,
   ainsi que les fichiers `.md` (documentation).
4. Ouvrez un terminal (invité de commandes) **dans ce dossier**.

---

## ÉTAPE 2 — Créer la base de données

1. Assurez-vous que PostgreSQL est démarré.
2. Créez une base nommée `teebo` :
   - En ligne de commande : `createdb teebo`
   - OU via l'interface graphique pgAdmin : clic droit sur « Databases » →
     **Create** → **Database…** → nom `teebo` → **Save**.
3. Appliquez les schémas.

   **Méthode recommandée (automatique) :** vous n'avez rien à copier à la main.
   La commande `npm run migrate` de l'ÉTAPE 4 applique **tous** les schémas
   dans le bon ordre (`schema.sql`, puis `schema_v3.sql` → `schema_v9.sql`).

   **Méthode manuelle (pgAdmin), si vous y tenez :** ouvrez pgAdmin → clic droit
   sur la base `teebo` → **Query Tool**, puis copiez-collez et exécutez (**Run**,
   F5) le contenu de chaque fichier **dans cet ordre** :
   `schema.sql`, `schema_v3.sql`, `schema_v4.sql`, `schema_v5.sql`,
   `schema_v6.sql`, `schema_v7.sql`, `schema_v8.sql`, `schema_v9.sql`.
   Le schéma `schema_v9.sql` ajoute le socle KYC BCEAO (état civil, pièce
   d'identité, profession, origine des fonds, PPE, bénéficiaire effectif) et la
   suppression d'IMF (archivage/purge + journal d'audit).

> Astuce : les schémas sont **idempotents** — les relancer est sans danger.

---

## ÉTAPE 3 — Configurer l'application

1. Dans le dossier `backend`, copiez le fichier `.env.example` et renommez la
   copie en **`.env`**.
2. Ouvrez `.env` dans un éditeur de texte et renseignez :
   - `DATABASE_URL` : l'adresse de votre base, ex.
     `postgres://utilisateur:motdepasse@127.0.0.1:5432/teebo`
   - `TEEBO_ADMIN_EMAIL` : l'e-mail de l'administrateur éditeur teebo.
   - `TEEBO_ADMIN_PASSWORD` : un mot de passe **fort** (changez-le !).
   - `PORT` : `3000` (par défaut).
3. Enregistrez le fichier.

---

## ÉTAPE 4 — Installer et initialiser

Dans le terminal, placez-vous dans `backend` puis lancez, l'un après l'autre :

1. `npm install` → installe les dépendances (patientez).
2. `npm run migrate` → crée l'administrateur éditeur teebo dans la base.
   Le terminal affiche « Admin teebo créé » avec son code d'accès.

---

## ÉTAPE 4 bis — Valider les migrations sur votre vraie base (recommandé)

Cette étape vérifie, **sur votre serveur PostgreSQL réel**, que tous les objets
de facturation (tables, déclencheurs d'audit, numérotation des factures,
TVA configurable par IMF) sont bien en place et se comportent correctement.

1. Placez-vous dans le dossier `backend`.
2. Assurez-vous que `DATABASE_URL` est renseigné (voir ÉTAPE 3).
3. Lancez : `npm run test:migrations`
4. Le test affiche une liste de contrôles `✓` puis
   `RÉSULTAT : N réussis / 0 échec(s)`.

> **Aucun risque pour vos données.** Toutes les écritures du test se font dans
> une transaction annulée automatiquement (`ROLLBACK`) : la base, y compris le
> compteur de factures, reste **strictement inchangée**. Le test peut être
> rejoué autant de fois que nécessaire, même sur une base déjà en production.

Messages possibles :

| Message | Signification | Action |
|---|---|---|
| `DATABASE_URL non défini` | adresse de la base absente | renseignez `DATABASE_URL` (ÉTAPE 3) |
| `Le paquet « pg » n'est pas installé` | dépendances non installées | relancez `npm install` (ÉTAPE 4) |
| `0 échec(s)` | tout est conforme | vous pouvez déployer |
| au moins un `✗` | un objet manque | rejouez l'ÉTAPE 2 (schémas) puis relancez |

---

## ÉTAPE 5 — Démarrer la plateforme

1. Dans `backend`, lancez : `node src/server.js`
2. Le message `teebo API … http://127.0.0.1:3000` confirme le démarrage.
3. Ouvrez votre navigateur sur le fichier `frontend/login.html`
   (ou servez le dossier `frontend`).
4. Connectez-vous avec les accès de `ACCES_TEEBO.md`.

---

## ÉTAPE 6 — Vérifier que tout fonctionne

1. Connectez-vous en tant qu'**administrateur éditeur teebo**
   (`hello@teebo.africa`) → la console teebo s'ouvre.
2. Déconnectez-vous, puis connectez-vous en **administrateur IMF**
   (`direction@imf-obj.bf`) → l'espace IMF s'ouvre.
3. Ouvrez le module **Objectifs** : la liste des cibles s'affiche.
4. Test express : créez une cible, puis vérifiez le tableau de bord.

### Vérifier la prévisualisation de facture (module Paramètres IMF)

1. Connecté en **administrateur IMF**, ouvrez le module **Paramètres**.
2. Renseignez les mentions légales et, si applicable, le taux de **TVA**
   (laissé vide = TVA non applicable ; aucun taux n'est imposé par défaut).
3. Cliquez sur **Aperçu de la facture** : le PDF de facture s'affiche
   dynamiquement dans la page, avec le logo, les mentions légales et le calcul
   HT + TVA à jour selon vos paramètres.
4. Modifiez un paramètre (ex. le taux de TVA) puis relancez l'aperçu :
   le document se régénère immédiatement avec les nouvelles valeurs.

Si une page reste blanche : videz le cache du navigateur (Ctrl+Shift+R).

### Vérifier les nouvelles fonctionnalités (suppression d'IMF + enrôlement KYC)

1. **Suppression d'une IMF (super-admin teebo)** : connecté en administrateur
   éditeur teebo, ouvrez le module **Institutions**. Chaque ligne propose un
   bouton rouge **Supprimer**. Il ouvre une fenêtre de confirmation où vous
   choisissez **Archiver** (masquer sans effacer) ou **Supprimer
   définitivement** (purge en cascade), puis vous devez **ressaisir le code de
   l'IMF** pour confirmer. Le tenant système teebo (`TBO-SYS-000000`) est
   protégé et ne peut pas être supprimé.
2. **Nouveau client KYC BCEAO (collectrice)** : ouvrez l'application terrain,
   connectez-vous en collectrice, puis **Nouveau client (KYC BCEAO)**. Le
   formulaire reprend le socle d'identité BCEAO (état civil, pièce d'identité,
   profession, origine des fonds, PPE, bénéficiaire effectif). La position GPS
   du lieu est capturée automatiquement : le client doit être enregistré chez
   lui.
3. **Espace client pour tout client** : dans l'application terrain, **Créer un
   espace client** permet désormais de **rechercher un client existant** puis de
   lui ouvrir un accès en ligne (mode de connexion + format de relevé).

> Un guide de vérification détaillé en local est fourni :
> **`VERIFIER_FONCTIONNALITES_LOCAL.md`**.

---

## ÉTAPE 7 — Mise en production (recommandé)

1. **HTTPS** : servez l'application derrière un certificat SSL (Let's Encrypt).
2. **CORS** : dans `.env`, remplacez `CORS_ORIGIN=true` par votre domaine réel.
3. **Mots de passe** : changez tous les mots de passe de démonstration.
4. **2FA** : activez la double authentification pour tous les comptes à privilèges.
5. **Sauvegardes** : planifiez une sauvegarde quotidienne de la base PostgreSQL.
6. **Processus** : utilisez un gestionnaire de service (systemd, PM2,
   Docker) pour que l'API redémarre automatiquement après un redémarrage.

---

## En cas de problème

| Symptôme | Cause probable | Solution |
|---|---|---|
| « ECONNREFUSED » au démarrage | PostgreSQL arrêté | Démarrez PostgreSQL |
| « password authentication failed » | Mauvais `DATABASE_URL` | Corrigez le mot de passe dans `.env` |
| Page blanche dans le navigateur | Cache navigateur | Ctrl+Shift+R (rechargement forcé) |
| « relation … does not exist » | Schémas non appliqués | Rejouez l'ÉTAPE 2 |
| `npm run test:migrations` échoue sur un objet | Schémas incomplets | Rejouez l'ÉTAPE 2 puis relancez l'ÉTAPE 4 bis |
| L'aperçu de facture reste vide | Paramètres IMF incomplets | Renseignez les mentions légales (module Paramètres) |
| `ENOENT ... /app/frontend/index.html` (Render) | le dossier `frontend` n'était pas copié dans l'image | corrigé : le `Dockerfile` copie désormais `frontend` ; **re-déployez** (Manual Deploy > Clear build cache & deploy) |
| Impossible de se connecter après le mot de passe | enrôlement 2FA obligatoire à terminer | suivez l'écran « Activer la double authentification » (scan du QR + code à 6 chiffres) |

---

## Première connexion : double authentification (2FA)

La double authentification (code à 6 chiffres) est **obligatoire pour tous les
comptes**. À la toute première connexion, après avoir saisi l'identifiant et le
mot de passe, l'écran d'**enrôlement** s'affiche automatiquement :

1. Ouvrez une application d'authentification (Google Authenticator, Authy,
   FreeOTP…) sur votre téléphone.
2. **Scannez le QR code** affiché (ou saisissez la clé proposée manuellement).
3. Saisissez le **code à 6 chiffres** généré par l'application, puis validez.
4. **Notez vos codes de secours** (affichés une seule fois) : ils dépannent en
   cas de perte du téléphone. Vous êtes ensuite connecté directement.

Aux connexions suivantes, il suffira de saisir le code à 6 chiffres après le
mot de passe. Le QR code est généré **localement** par le serveur (image
`data:` intégrée) : aucun appel à un service externe, conforme à la politique
de sécurité (CSP) stricte.
| Accès refusé (403) sur une action | Profil non autorisé | Vérifiez `MATRICE_HABILITATIONS.md` |

---

## Contacts

- WhatsApp : **+226 50 32 14 32** (wa.me/22650321432)
- E-mail : **hello@teebo.africa**
- « La finance à visage humain »
