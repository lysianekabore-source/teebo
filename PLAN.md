# Plan de réalisation — Plateforme teebo

## Vue d'ensemble
Construction par vagues successives d'une plateforme core banking SaaS pour
IMF/SFD de l'UEMOA. Stack : **Node.js + Express + PostgreSQL**, front HTML/JS.

---

## Vagues réalisées

| Vague | Thème | État |
|---|---|---|
| 1 | Socle : IMF, comptes, authentification, 2FA | ✅ |
| 2 | Clients, enrôlement, espaces en ligne | ✅ |
| 3 | Collecte terrain, tournées, versements caisse | ✅ |
| 4 | Crédit, produits, frais, gel/dégel | ✅ |
| 5 | Souscription, essai & échéances, sécurité terminaux | ✅ |
| 6 | Autorisations fines (visibilité inter-entités) | ✅ |
| **7** | **Module Objectifs & Cibles hiérarchiques** | ✅ (45/45 tests) |
| **7b** | **Notifications automatiques d'objectifs** | ✅ (12/12 tests) |
| **7c** | **Accès local complet (test bout en bout)** | ✅ |

---

## VAGUE 7 — Module Objectifs : étapes

### Étape 1 — Modélisation des données
- Hiérarchie auto-référencée `parent_id` + anti-cycle.
- Enums KPI / statut / période.
- Tables `objective` et `objective_progress_event`.
- Triggers statut + audit.

### Étape 2 — Logique métier (couche service)
- `assertCanAssign` : direction d'affectation autorisée par profil.
- `assertDirectReport` : rattachement hiérarchique direct.
- `checkTeamConsistency` : somme équipe ≥ objectif global.
- `allocateTeamTargets` : répartition atomique (tout-ou-rien).
- `createObjective` / `updateObjective` : création et ajustement avec revalidation.
- `incrementProgress` : roll-up + idempotence.
- `recomputeBranchRollup` : recalcul consolidé de branche.
- `supervisorDashboard` / `branchDashboard` : tableaux de bord temps réel.

### Étape 3 — API REST
- POST/PATCH objectifs, répartition d'équipe, progression, tableaux de bord.
- Exposition des référentiels KPI.

### Étape 4 — Habilitations
- Centralisation des droits dans `backend/src/habilitations.js`.
- Matrice documentée dans `MATRICE_HABILITATIONS.md`.

### Étape 5 — Validation
- Tests bout en bout : **45/45** (voir `RAPPORT_TESTS_FR.md`).
- Cas couverts : saut de niveau refusé, cohérence bloquée, tout-ou-rien,
  idempotence, cloisonnement par IMF, roll-up temps réel, lecture seule collectrice.

---

## VAGUE 7b — Notifications automatiques

### Réalisé
- Module `backend/src/objective_notifications.js` : paliers **50 % / 80 % / 100 %**.
- Déclenchement automatique à chaque montée de progression, sur toute la chaîne.
- Veille de fin de période (`notifyExpiredFailures`) : alerte sur objectifs non atteints.
- Table `objective_notification` + index unique = idempotence (aucun doublon).
- Journal consultable : `GET /api/v1/objectives/notifications`.
- Tests : **12/12** (voir `RAPPORT_TESTS_FR.md`).

---

## VAGUE 7c — Accès local complet

### Réalisé
- `DEMARRER_LOCAL.sh` : lancement de toute la plateforme en **une commande**.
- `tools/seed-demo.mjs` : crée automatiquement une IMF de démonstration
  (6 utilisateurs, arborescence, cibles, collectes) pour tester tous les profils.
- `LOCAL_TEST/README.md` : guide pas-à-pas + accès de chaque profil.
- `tests/run_v7.sh` et `tests/run_notif.sh` : tests automatiques portables.

---

## Prochaines étapes possibles
- Historique graphique de progression par période.
- Objectifs d'équipe par agence et consolidation multi-agences.
- Export PDF des tableaux de bord.
- Envoi réel des notifications via l'API WhatsApp Business / SMTP (en production).
