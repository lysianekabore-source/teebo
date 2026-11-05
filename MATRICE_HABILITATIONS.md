# teebo — Matrice d'habilitation par profil

> Version : VAGUE 7 (module Objectifs & Cibles hiérarchiques)
> Source de vérité technique : `backend/src/habilitations.js`
> Contact : hello@teebo.africa — WhatsApp +226 50 32 14 32

---

## 1. Les profils (rôles) de la plateforme

| Code technique | Libellé métier | Position dans la hiérarchie | Double authentification (2FA) |
|---|---|---|---|
| `teebo_admin` | Éditeur teebo | Hors IMF — console d'approbation | Obligatoire |
| `admin_imf` | Administrateur IMF | Sommet de l'IMF cliente | Obligatoire |
| `direction` | Direction générale | Sommet opérationnel de l'IMF | Obligatoire |
| `department` | Chef de département | Encadrement intermédiaire | Obligatoire |
| `service` | Chef de service | Encadrement de proximité | Obligatoire |
| `agency` | Chef d'agence | Encadrement d'agence | Obligatoire |
| `staff` | Agent / Collectrice | Terrain (exécution) | Non obligatoire |
| `caissier` | Caissier | Caisse (versements) | Non obligatoire |

### Alias du module Objectifs
Le module Objectifs utilise trois profils simplifiés qui correspondent aux rôles socle :

| Alias module | Rôle socle équivalent | Signification |
|---|---|---|
| `dg` | `direction` / `agency` | Directeur général / chef d'agence |
| `supervisor` | `department` / `service` | Superviseur / encadrant |
| `collectrice` | `staff` | Agent de terrain |

**Hiérarchie d'affectation descendante :** `dg` → `supervisor` → `collectrice`.
Un profil ne peut créer une cible que pour le niveau immédiatement inférieur autorisé.

---

## 2. Matrice synthétique (domaines × profils)

Légende : **L** = lecture · **E** = écriture/création · **V** = validation · **—** = aucun accès

| Domaine / Fonction | teebo_admin | admin_imf | direction | department | service | agency | staff | caissier |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Console éditeur (approbation des IMF) | L/E | — | — | — | — | — | — | — |
| Gestion des comptes & unités | — | L/E | L/E | — | — | — | — | — |
| Objectifs — créer / répartir / modifier | — | L/E | L/E | L/E | L/E | L/E | — | — |
| Objectifs — consulter ses propres cibles | — | L | L | L | L | L | L | L |
| Objectifs — tableau de bord équipe | — | L | L | L | L | L | — | — |
| Objectifs — vue consolidée branche | — | L | L | — | — | L | — | — |
| Objectifs — progression (collecte / compte) | — | E | E | E | E | E | E | E |
| Objectifs — progression (rétention) | — | E | E | E | E | E | — | — |
| Tournée du jour | — | L/E | L/E | L/E | L/E | L/E | L/E | L/E |
| Enrôlement clients | — | L/E | L/E | L/E | L/E | L/E | L/E | L/E |
| Déclaration versements | — | E | E | — | — | — | — | E |
| Validation versements | — | V | V | — | — | — | — | V |
| Autorisations fines (visibilité) | — | L/E | L | — | — | — | — | — |
| Terminaux & sécurité | — | L/E | L/E | — | — | — | — | — |

---

## 3. Matrice détaillée par endpoint (module Objectifs)

| Méthode | Route | Profils autorisés |
|---|---|---|
| GET | `/objectives/kpi-types` | admin_imf, direction, agency, department, service, staff, caissier, dg, supervisor, collectrice |
| POST | `/objectives` | admin_imf, direction, agency, department, service, dg, supervisor |
| PATCH | `/objectives/:id` | admin_imf, direction, agency, department, service, dg, supervisor |
| POST | `/objectives/team-allocations` | admin_imf, direction, agency, department, service, dg, supervisor |
| GET | `/objectives/mine` | Tous les profils de lecture ci-dessus |
| GET | `/objectives/dashboard` | admin_imf, direction, agency, department, service, dg, supervisor |
| GET | `/objectives/branch-dashboard` | admin_imf, direction, agency, dg |
| GET | `/objectives/team/:supervisorId` | admin_imf, direction, agency, department, service, dg, supervisor |
| POST | `/objectives/recompute` | admin_imf, direction, agency, dg |
| POST | `/objectives/progress/collection` | Tous les profils de lecture |
| POST | `/objectives/progress/new-account` | Tous les profils de lecture |
| POST | `/objectives/progress/retention` | admin_imf, direction, agency, department, service, dg, supervisor |

---

## 4. Règles de sécurité transverses

1. **Cloisonnement par IMF** : chaque requête est bornée à `imf_id = utilisateur.imf_id`.
   Seul `teebo_admin` franchit cette frontière (console éditeur).
2. **Affectation strictement descendante** : un profil ne cible que ses
   subordonnés directs autorisés. Toute autre cible → `403 invalid_assignment_direction`.
3. **Anti-cycle hiérarchique** : impossible de rattacher un agent à l'un de ses
   propres subordonnés → `422 cycle_detected`.
4. **Cohérence bloquante** : la somme des cibles d'équipe doit être ≥ à l'objectif
   global du superviseur, sinon `422 target_below_global` avec écart chiffré.
5. **Idempotence** : un même fait métier (dépôt, ouverture de compte) n'est jamais
   compté deux fois (`409`/ignoré silencieusement selon le cas).
6. **2FA obligatoire** pour tous les profils à privilèges (voir tableau §1).
7. **Expiration du mot de passe** : signalée à la connexion (`password_change_required`).

---

## 5. Comment vérifier les droits d'un profil

À la connexion, l'application expose le profil effectif et l'état 2FA :

- `GET /api/v1/auth/me` → renvoie le rôle et l'identité de la session courante.
- `GET /api/v1/auth/2fa/status` → indique si la 2FA est requise pour ce profil.

Le groupe de droits appliqué à chaque route est directement lisible dans
`backend/src/habilitations.js` (constantes `ADMIN`, `SUPERVISION`, `READ`,
`OBJ_MANAGERS`, `OBJ_READERS`, `OBJ_BRANCH`, etc.).
