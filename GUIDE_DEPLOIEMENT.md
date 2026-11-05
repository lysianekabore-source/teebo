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
3. Appliquez les schémas dans l'ordre :
   - Ouvrez pgAdmin → clic droit sur la base `teebo` → **Query Tool**.
   - Copiez-collez le contenu de `db/schema.sql` → **Run** (F5).
   - Puis copiez-collez le contenu de `db/schema_v3.sql` → **Run** (F5).

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

Si une page reste blanche : videz le cache du navigateur (Ctrl+Shift+R).

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
| Accès refusé (403) sur une action | Profil non autorisé | Vérifiez `MATRICE_HABILITATIONS.md` |

---

## Contacts

- WhatsApp : **+226 50 32 14 32** (wa.me/22650321432)
- E-mail : **hello@teebo.africa**
- « La finance à visage humain »
