# teebo — API Matrice des habilitations — Déploiement Render

API qui pilote **deux matrices de cases à cocher** :

1. **Côté teebo** (super-admin plateforme) : pour chaque IMF, on **coche/décoche les habilitations autorisées** (le périmètre souscrit).
2. **Côté admin IMF** : au sein de son IMF, l'admin **coche/décoche les habilitations par utilisateur** — uniquement dans le périmètre autorisé par teebo.

> Règle d'or : un admin IMF ne peut **jamais** accorder une habilitation que teebo n'a pas activée pour son IMF. Le serveur le refuse (`non_autorisee_par_teebo`).

## 1. Contenu du dossier

| Fichier | Rôle |
|---|---|
| `server.js` | L'API Express (routes teebo + admin IMF + connexion) |
| `catalog.js` | Le catalogue des habilitations par module |
| `roles.js` | Modèles de rôles (repli ; en prod ils viennent de la base) |
| `auth.js` | Connexion réelle : vérifie le mot de passe + émet le jeton de session |
| `password.js` | Hachage de mot de passe (scrypt natif, sans dépendance) |
| `session.js` | Vérification du jeton de session (JWT HS256) |
| `mailer.js` | **E-mail d'invitation** (SMTP via nodemailer, ou mode MOCK dans les logs) |
| `rbac.js` | Contrôle d'accès deny-by-default (rôle teebo / permission) |
| `db.js` | Connexion PostgreSQL (pool `pg`) |
| `sql/001_habilitations.sql` | Tables habilitations + garde-fous |
| `sql/002_core.sql` | **Tables réelles** : `imf`, `app_user`, `role_template` |
| `sql/003_seed.sql` | Données initiales (rôles, IMF, comptes de départ) |
| `sql/004_user_mgmt.sql` | **Changement de mot de passe obligatoire** (colonne `must_change_password`) |
| `scripts/migrate.mjs` | Applique toutes les migrations dans l'ordre |
| `scripts/hash-password.mjs` | Génère un hachage pour changer un mot de passe |
| `package.json` | Dépendances + scripts `start` / `migrate` / `hash` |
| `render.yaml` | Configuration automatique Render |
| `.env.example` | Modèle des variables d'environnement |

## 3. Mise en PRODUCTION RÉELLE (vrais utilisateurs / rôles en base)

C'est le mode recommandé : les utilisateurs, les rôles et les habilitations
sont stockés en base PostgreSQL, et l'accès se fait par **connexion** (e-mail +
mot de passe) qui délivre un **jeton de session**.

### 3.1 Créer la base
1. Render : **New → PostgreSQL**. Copiez l'`Internal Database URL`.

### 3.2 Régler les variables du Web Service (**Environment**)
```
DEMO=0
USE_SESSION=1
DATABASE_URL=postgres://...        (l'URL copiée)
SESSION_JWT_SECRET=<valeur aléatoire>   (ex. : openssl rand -hex 32)
NETLIFY_ORIGIN=https://votre-site.netlify.app
APP_BASE_URL=https://votre-site.netlify.app   (lien de connexion dans l'e-mail d'invitation)
```
> Avec `render.yaml`, `SESSION_JWT_SECRET` est généré automatiquement.

#### E-mail d'invitation (optionnel mais recommandé en production)
À la création d'un compte, l'utilisateur reçoit un e-mail avec son lien de connexion et son mot de passe initial. Renseignez un serveur SMTP :
```
MAIL_FROM=teebo <no-reply@votre-domaine>
SMTP_HOST=smtp.sendgrid.net        (ou mailgun, gmail, OVH…)
SMTP_PORT=587
SMTP_SECURE=0                      (1 uniquement pour le port 465)
SMTP_USER=<identifiant SMTP>
SMTP_PASS=<mot de passe / clé API SMTP>
```
> **Mode MOCK** : si `SMTP_HOST` est vide, l'e-mail n'est pas envoyé mais son contenu est écrit dans les logs Render — pratique pour tester le flux sans serveur d'e-mail. La création du compte réussit **même si** l'envoi échoue (vous pouvez toujours réinitialiser le mot de passe depuis l'onglet Utilisateurs).

### 3.3 Appliquer les migrations (crée les tables + les comptes de départ)
Depuis votre machine (ou le Shell Render), le dossier étant installé (`npm install`) :
```
DATABASE_URL="postgres://..." npm run migrate
```
Cela exécute dans l'ordre `001` → `002` → `003`. Les fichiers sont **idempotents**
(relançables sans doublon).

### 3.4 Comptes de départ (À CHANGER immédiatement)

| Rôle | E-mail | Mot de passe |
|---|---|---|
| Super-admin teebo | `admin@teebo.io` | `Teebo!2026` |
| Admin IMF-001 | `admin@imf001.bf` | `AdminImf!2026` |
| Admin IMF-002 | `admin@imf002.bf` | `AdminImf!2026` |

Pour **changer un mot de passe** : générez un nouveau hachage puis mettez-le en base.
```
npm run hash "MonNouveauMotDePasse"
# copiez la chaîne affichée, puis :
#   UPDATE app_user SET password_hash = '<chaîne>' WHERE email = 'admin@imf001.bf';
```

### 3.5 Se connecter
- Depuis le site Netlify : panneau **🔑 Se connecter (production)** → e-mail + mot de passe.
- Le front stocke le jeton reçu et l'envoie en `Authorization: Bearer`.
- L'`imf_id` et les droits sont ensuite **dérivés du jeton**, jamais d'un en-tête.

## 3bis. Déploiement rapide (mode DÉMO, sans base)

1. Mettez ce dossier dans un dépôt Git.
2. Sur [render.com](https://render.com) : **New → Web Service**, pointez sur le dépôt.
3. Render lit `render.yaml`. Laissez **`DEMO = 1`**.
4. Testez : `https://VOTRE-SERVICE.onrender.com/health` → `{"ok":true,"demo":true}`.

En démo, l'état (cases cochées) est conservé en mémoire tant que le service tourne.
La connexion fonctionne aussi en démo avec les comptes du tableau ci-dessus.

## 4. Les routes

### Connexion
- `POST /api/v1/auth/login` body `{ email, password }` → `{ token, user }`. `user.must_change_password=true` indique une première connexion → l'interface impose le changement de mot de passe.
- `POST /api/v1/auth/change-password` (session requise) body `{ current_password, new_password }` → change son propre mot de passe, lève l'obligation et renvoie un **nouveau jeton** `{ ok, token }`. Mot de passe 8 caractères min., différent de l'actuel.
  Vérifie le mot de passe en base (scrypt), calcule les rôles/permissions depuis
  `role_template`, puis signe un jeton de session JWT (valide `SESSION_TTL_SECONDS`).

### Catalogue & modèles
- `GET /api/v1/catalog` → toutes les habilitations groupées par module.
- `GET /api/v1/role-templates` → modèles d'habilitations par rôle (en prod : lus en base).

### Côté teebo (en-tête `Authorization: Bearer <TEEBO_ADMIN_TOKEN>`)
- `GET /api/v1/teebo/imf` → liste des IMF.
- `GET /api/v1/teebo/entitlements?imfId=imf-001` → `{ enabled: [codes] }`.
- `POST /api/v1/teebo/entitlements` body `{ imfId, changes:[{permissionCode, enabled}] }`.

### Côté admin IMF (en-tête `x-imf-id` + `Authorization: Bearer <API_TOKEN>`)
- `GET /api/v1/admin/users` → utilisateurs de l'IMF.
- `GET /api/v1/admin/matrix` → `{ entitled:[codes], grants:{userId:[codes]}, users:[...] }`.
- `POST /api/v1/admin/grants` body `{ changes:[{userId, permissionCode, granted}] }`.
- `POST /api/v1/admin/apply-template` body `{ userId, role, mode }` — **préremplit** les habilitations d'un utilisateur selon un modèle de rôle (`mode`=`replace` par défaut, ou `add`). Toujours intersecté avec le périmètre teebo.
- `GET /api/v1/audit?scope=&action=&limit=&offset=` → **historique** des changements (append-only), scopé par `imf_id`.

### Gestion des comptes utilisateurs (admin IMF — permission `user.manage`)
Toutes ces routes sont scopées à l'`imf_id` de la session : un admin ne voit et ne modifie QUE les comptes de son IMF ; les comptes teebo (`is_teebo_admin`) sont exclus.
- `GET /api/v1/admin/accounts` → `{ items:[{ id, full_name, email, role, active }] }` — comptes de l'IMF.
- `POST /api/v1/admin/accounts` body `{ full_name, email, role, password }` → crée un compte. E-mail **unique par IMF** (sinon `409`), rôle validé contre les modèles, mot de passe **8 caractères minimum** (sinon `400`). Le mot de passe est haché (scrypt) ; jamais stocké en clair.
- `POST /api/v1/admin/accounts/:id/status` body `{ active }` → active/désactive un compte. **Auto-désactivation interdite** (`400`).
- `POST /api/v1/admin/accounts/:id/role` body `{ role }` → change le rôle (validé).
- `POST /api/v1/admin/accounts/:id/password` body `{ password }` → réinitialise le mot de passe (8 caractères min.).

Chaque opération est journalisée dans l'historique (`habilitation_audit`, code `gestion.compte`, actions `USER_CREATE` / `USER_DISABLE` / `USER_ENABLE` / `USER_ROLE` / `USER_PWD_RESET`).

> **Invitation & 1re connexion** : à la création, le compte est marqué `must_change_password=true` et un e-mail d'invitation (lien + mot de passe initial) est envoyé. Une réinitialisation de mot de passe par l'admin remet aussi ce drapeau à `true`. L'utilisateur est alors **obligé de choisir un nouveau mot de passe** à sa connexion (via `POST /api/v1/auth/change-password`), après quoi le drapeau repasse à `false`.

## 6. Mode production : brancher la VRAIE session

Par défaut (`USE_SESSION=0`), l'API utilise les jetons `TEEBO_ADMIN_TOKEN` / `API_TOKEN` + l'en-tête `x-imf-id` : pratique pour déployer vite.

Pour la production teebo, passez `USE_SESSION=1`. L'API ne fait alors **plus confiance aux en-têtes du client** :

- Elle exige un **jeton de session JWT vérifié** (`SESSION_JWT_SECRET`), lu depuis `Authorization: Bearer <jwt>` ou le cookie `teebo_session`.
- L'`imf_id`, les rôles et les permissions viennent **de la session**, jamais d'un en-tête.
- **Côté teebo** : rôle plateforme requis (`TEEBO_ROLE`, défaut `TEEBO_ADMIN`).
- **Côté admin IMF** : permission `rbac.manage` requise (deny-by-default), `imf_id` dérivé de la session.

Le jeton de session doit contenir : `{ sub, imf_id, roles:[...], permissions:[...], exp }`.

> Fichiers concernés : `session.js` (vérification JWT HS256 via le module `crypto` natif, **aucune dépendance ajoutée**) et `rbac.js` (`requireTeeboRole`, `requirePermission`). Dans teebo, remplacez `decodeToken` de `session.js` par votre vérification réelle (votre lib JWT ou votre store de session) : le contrat `{ sub, imf_id, roles, permissions }` reste identique, rien d'autre à changer.

## 7. Garde-fous intégrés

- `credit.auto_disburse` (décaissement IA automatique) est **interdit** : verrouillé côté serveur **et** par un trigger SQL. Impossible à cocher.
- `credit.validate` est marqué **sensible** (validation humaine obligatoire).
- Retirer un entitlement côté teebo retire automatiquement les habilitations utilisateurs correspondantes.
- Chaque changement est journalisé (`habilitation_audit`, append-only).

## 8. Note sécurité (production)

En production, utilisez `USE_SESSION=1` (voir §6) : l'`imf_id` et le rôle sont dérivés de la session serveur, la permission `rbac.manage` est exigée côté admin IMF, et le côté teebo est réservé au rôle plateforme.
