# teeBo — Plateforme Core Banking SaaS (UEMOA)

> « La finance à visage humain »
> Contact : WhatsApp +226 50 32 14 32 (wa.me/22650321432) — hello@teebo.africa

Plateforme de gestion pour institutions de microfinance (IMF/SFD) de la zone
UEMOA : collecte terrain, clients, tournées, versements, crédit, souscription,
sécurité terminaux, autorisations fines et **pilotage des objectifs**.

---

## 🆕 VAGUE 7 — Module Objectifs & Cibles hiérarchiques

Module de pilotage commercial IMF : hiérarchie **DG → Superviseur → Collectrice**.

### Livré
1. **Base de données** (`db/schema_v3.sql`)
   - Hiérarchie auto-référencée `app_user.parent_id` + anti-cycle.
   - Enums : `kpi_type` (COLLECTION_VOLUME, NEW_ACCOUNTS, RETENTION_RATE),
     `objective_status` (PENDING, IN_PROGRESS, ACHIEVED, FAILED), `objective_period`.
   - Tables `objective` (contrainte d'unicité par périmètre + CHECKs) et
     `objective_progress_event` (journal d'idempotence, index unique partiel).
   - Triggers : recalcul automatique du statut + audit.
2. **Couche service** (`backend/src/objectives_service.js`)
   - Affectation strictement descendante (`assertCanAssign`, `assertDirectReport`).
   - Contrôle de cohérence bloquant (`checkTeamConsistency`).
   - Répartition groupée **atomique** tout-ou-rien (`allocateTeamTargets`).
   - Roll-up temps réel via CTE récursive (`resolveChain`, `recomputeBranchRollup`).
   - Idempotence via `INSERT … ON CONFLICT DO NOTHING`.
3. **API REST** (`backend/src/routes/objectives.js`) — voir §API ci-dessous.
4. **Habilitations** (`backend/src/habilitations.js`) — matrice centralisée.
5. **Notifications automatiques** (`backend/src/objective_notifications.js`)
   - Paliers **50 % / 80 % / 100 %** déclenchés automatiquement.
   - Remontée de la progression sur toute la chaîne hiérarchique.
   - Veille de fin de période (`notifyExpiredFailures`) → alerte sur objectifs non atteints.
   - Table `objective_notification` + index unique = **idempotence** (aucun doublon).
   - Journal consultable : `GET /api/v1/objectives/notifications`.
6. **Tests** : **45 / 45** (module Objectifs) et **12 / 12** (notifications) — voir `RAPPORT_TESTS_FR.md`.

### Règles métier clés
- **Affectation descendante stricte** : un profil ne cible que ses subordonnés directs autorisés.
- **Cohérence bloquante** : la somme des cibles d'équipe doit être ≥ à l'objectif
  global du superviseur → sinon `422 target_below_global` avec l'écart chiffré.
- **Roll-up temps réel** : chaque collecte remonte automatiquement toute la chaîne.
- **Idempotence** : un même fait métier n'est jamais compté deux fois.

---

## API du module Objectifs

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/api/v1/objectives/kpi-types` | Référentiels KPI / périodes / unités |
| POST | `/api/v1/objectives` | Créer une cible (affectation descendante) |
| PATCH | `/api/v1/objectives/:id` | Ajuster une cible + revalidation de cohérence |
| POST | `/api/v1/objectives/team-allocations` | Répartition groupée atomique |
| GET | `/api/v1/objectives/mine` | Mes cibles |
| GET | `/api/v1/objectives/dashboard` | Tableau de bord superviseur |
| GET | `/api/v1/objectives/branch-dashboard` | Vue consolidée branche (DG) |
| GET | `/api/v1/objectives/team/:supervisorId` | Équipe d'un superviseur |
| POST | `/api/v1/objectives/recompute` | Recalcul forcé du roll-up |
| POST | `/api/v1/objectives/progress/collection` | Progression collecte |
| POST | `/api/v1/objectives/progress/new-account` | Progression nouveaux comptes |
| POST | `/api/v1/objectives/progress/retention` | Progression rétention |
| GET | `/api/v1/objectives/notifications` | Journal des notifications d'objectifs |

Détail complet des droits : voir **`MATRICE_HABILITATIONS.md`**.

---

## Arborescence

```
teebo/
├── README.md                 ce fichier
├── PLAN.md                   plan de réalisation
├── RAPPORT_TESTS_FR.md       rapport de tests (45/45 + 12/12)
├── MATRICE_HABILITATIONS.md  matrice de droits par profil
├── ACCES_TEEBO.md            accès de démonstration
├── GUIDE_DEPLOIEMENT.md      pas-à-pas de mise en ligne
├── DEMARRER_LOCAL.sh         lancement local complet (1 commande)
├── LOCAL_TEST/               guide pour tester en local + accès de tous les profils
├── docker-compose.yml        PostgreSQL + API
├── db/                       schémas SQL (schema.sql, schema_v3.sql)
├── backend/                  API Node.js + Express
│   └── src/
│       ├── habilitations.js           matrice de droits (source de vérité)
│       ├── objectives_service.js      logique métier Objectifs
│       ├── objective_notifications.js notifications automatiques
│       └── routes/objectives.js       routes HTTP Objectifs
├── tests/                    suites de tests automatiques (v7, notifications)
├── tools/seed-demo.mjs       remplissage d'une IMF de démonstration
└── frontend/                 interfaces (pages HTML + assets)
```

---

## Démarrage rapide (développement)

1. Créer la base : `createdb teebo` puis appliquer `db/schema.sql` et `db/schema_v3.sql`.
2. Configurer `.env` (voir `.env.example`).
3. `cd backend && npm install && npm run migrate`.
4. Lancer : `node src/server.js` → API sur `http://127.0.0.1:3000`.
5. Ouvrir `frontend/login.html` pour se connecter.

Guide de production complet : voir **`GUIDE_DEPLOIEMENT.md`**.

---

## 🧪 Tester en local (recommandé pour tout valider)

Pour lancer la plateforme entière sur votre ordinateur avec une IMF de démonstration
et **tous les profils prêts à tester** :

```
bash DEMARRER_LOCAL.sh
```

Guide détaillé, accès de chaque profil et scénario de test : voir **`LOCAL_TEST/README.md`**.

Tests automatiques : `bash tests/run_v7.sh` (45/45) et `bash tests/run_notif.sh` (12/12).
