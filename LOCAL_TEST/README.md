# teebo — Tester la plateforme en local

Ce dossier vous permet de **lancer toute la plateforme sur votre propre ordinateur** et
de tester chaque profil (administrateur IMF, DG, superviseur, collectrice) sans rien
déployer sur Internet.

---

## 1. Ce dont vous avez besoin

- **Node.js 20 ou plus récent** — à télécharger sur https://nodejs.org (choisissez la version « LTS »).
- **PostgreSQL 16** en local — à télécharger sur https://www.postgresql.org/download/
  - Alternative : **Docker Desktop** (https://www.docker.com/products/docker-desktop/), qui lance tout seul la base de données.
- Un navigateur (Chrome, Edge, Firefox…).

> Vous n'avez **rien d'autre à installer** : le lanceur fait le reste.

---

## 2. Préparer la base de données

Deux possibilités :

### Option A — avec Docker (le plus simple)

Dans un terminal, depuis le dossier du projet :

```
docker compose up -d db
```

La base `teebo` est créée automatiquement sur le port **5432**.

### Option B — avec PostgreSQL installé sur votre machine

Créez une base et un utilisateur :

```
createdb teebo
```

*(Ou via pgAdmin : clic droit sur « Bases » → Créer → base de données → nom : `teebo`.)*

---

## 3. Lancer la plateforme (une seule commande)

Dans le dossier du projet :

```
bash DEMARRER_LOCAL.sh
```

Le script enchaîne tout automatiquement :

1. vérifie Node.js ;
2. installe les dépendances (seulement la 1re fois) ;
3. prépare la base (crée les tables) ;
4. démarre l'interface de programmation (l'« API ») ;
5. **remplit la base avec une IMF de démonstration complète** ;
6. affiche les accès de test à l'écran.

> Si la base n'est pas sur le port 5432, indiquez-la avant de lancer :
> ```
> DATABASE_URL='postgres://teebo:teebo@127.0.0.1:5432/teebo' bash DEMARRER_LOCAL.sh
> ```

---

## 4. Ouvrir les pages web

À la fin du lancement, ouvrez dans votre navigateur :

```
file:///chemin/vers/le/projet/frontend/login.html
```

Le plus simple : ouvrez le dossier `frontend`, puis **double-cliquez sur `login.html`**.

*(Les pages dialogue avec l'API lancée à l'étape 3, sur http://127.0.0.1:3000.)*

---

## 5. Accès de test (tous les profils)

| Profil | Identifiant | Mot de passe | Ce qu'on y teste |
|---|---|---|---|
| **Administrateur IMF** | `admin@demo-teebo.bf` | `DemoAdmin#2026` | Tout : utilisateurs, unités, objectifs, habilitations, pilotage |
| **Directeur général** | `dg@demo-teebo.bf` | `DemoDg#2026x` | Fixe les cibles, suit son équipe, notifications |
| **Superviseur terrain** | `sup@demo-teebo.bf` | `DemoSup#2026x` | Répartit les cibles dans son équipe, tableaux de bord |
| **Collectrice 1** | `c1@demo-teebo.bf` | `DemoCol#2026x` | Saisie des collectes, progression de ses cibles |
| **Collectrice 2** | `c2@demo-teebo.bf` | `DemoCol#2026x` | Idem |
| **Collectrice 3** | `c3@demo-teebo.bf` | `DemoCol#2026x` | Idem |
| **Console éditeur teebo** | `hello@teebo.africa` | `Teebo#Admin2026` | Approuver les demandes d'accès, gérer les IMF |

> ⚠️ **Ces mots de passe sont des mots de passe de démonstration.** En production, changez-les impérativement.

---

## 6. Scénario de test conseillé (10 minutes)

1. **Console éditeur** → connectez-vous avec `hello@teebo.africa`, vérifiez qu'une nouvelle
   demande d'accès IMF peut être approuvée.
2. **Administrateur IMF** → connectez-vous et vérifiez l'arborescence
   Direction › Département › Service › Agence et les 6 utilisateurs.
3. **Directeur général** → onglet Objectifs : la cible de 3 000 000 FCFA est visible.
4. **Superviseur** → onglet Objectifs : la cible est répartie en 3 × 1 000 000 FCFA.
5. **Collectrice 1** → saisissez une nouvelle collecte de 300 000 FCFA.
6. **Résultat attendu** : la progression remonte automatiquement (collectrice → superviseur → DG)
   et une **notification automatique** se déclenche au franchissement de 50 %.

---

## 7. Vérifier que tout fonctionne (tests automatiques)

Il existe deux suites de tests automatiques :

```
bash tests/run_v7.sh        # 45 vérifications (module Objectifs / Vague 7)
bash tests/run_notif.sh     # 12 vérifications (notifications automatiques)
```

Attendu : **45/45 réussis** et **12/12 réussis**.

---

## 8. Arrêter la plateforme

```
kill $(lsof -t -i:3000)
```

(Ou fermez la fenêtre du terminal si l'API tourne au premier plan.)

---

## 9. En cas de souci

| Symptôme | Cause probable | Solution |
|---|---|---|
| « L'API ne répond pas » | Base non démarrée | `docker compose up -d db` puis relancer le script |
| Page blanche à la connexion | API non lancée | Relancez `bash DEMARRER_LOCAL.sh` |
| « DATABASE_URL » erreur | Mauvais port / mot de passe | Renseignez `DATABASE_URL` comme à l'étape 3 |
| Le seed dit « déjà effectué » | Démo déjà créée | Normal : la démo existe déjà, connectez-vous directement |

Pour repartir de zéro : supprimez la base (`dropdb teebo && createdb teebo`) puis relancez.

---

## Contact

**teebo.africa** — La finance à visage humain.
WhatsApp : [+226 50 32 14 32](https://wa.me/22650321432) · E-mail : hello@teebo.africa
