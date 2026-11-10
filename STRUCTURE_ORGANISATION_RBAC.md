# Structure organisationnelle, RBAC par verbe & audit anti-fraude (VAGUE 11)

Ce module implémente la structure cible demandée : **8 départements**, leurs
services et leurs rôles métier, avec **RBAC strict par verbe** et une **piste
d'audit immuable** destinée à l'IA anti-fraude. Tout reste **cloisonné par
tenant** (`imf_id` = identifiant unique de chaque IMF) et en **français**.

## 1. Multi-tenancy

Chaque IMF est un tenant isolé : `imf.id` fait office de `tenant_id`. Toutes
les requêtes métier filtrent sur `imf_id` ; aucun rôle ne franchit cette
frontière (sauf la console `teebo_admin`). Le bornage fin dept/service s'ajoute
à ce cloisonnement, jamais à sa place.

## 2. Les 8 départements et leurs services

| Département | Services | Rôles |
|---|---|---|
| Direction Générale | Pilotage stratégique | SuperAdmin (DG) |
| Conformité (LAB-FT) | Contrôle de conformité / LAB-FT | Responsable Conformité |
| SI & Sécurité | Administration système ; Ingénierie sécurité | Administrateur Système ; Ingénieur Sécurité |
| Crédit | Octroi & analyse ; Recouvrement | Directeur Crédit ; Analyste Crédit ; Agent de Recouvrement |
| Opérations | Guichet / Caisse ; Relation clientèle | Directeur des Opérations ; Guichetier/Caissier ; Chargé de Clientèle |
| Finance | Trésorerie ; Comptabilité | CFO ; Trésorier ; Comptable |
| Audit Interne | Audit & inspection | Auditeur Interne (lecture seule) |
| RH & Logistique | RH & Logistique | Responsable RH & Logistique |

Référentiel : `department_catalog`, `service_catalog`, `role_catalog`
(global, partagé par tous les tenants). La fonction
`fn_seed_org_structure(imf_id)` matérialise ces 8 départements + services dans
l'arbre `org_unit` d'un tenant (idempotente).

## 3. Matrice RBAC par verbe

Cinq verbes : **READ / WRITE / UPDATE / DELETE / VALIDATE**. Chaque règle
accorde un verbe sur une ressource à un **périmètre** :

- `tenant` : toute l'IMF
- `department` : le département de l'utilisateur
- `service` : le service de l'utilisateur
- `self` : ses propres enregistrements

Source de vérité : table `rbac_rule` (base) + miroir runtime `src/rbac.js`.
Règles marquantes :

- **SuperAdmin / admin_imf** : tous les verbes, toutes les ressources, périmètre `tenant`.
- **Directeur Crédit** : VALIDATE sur les dossiers de crédit (périmètre département) ; l'**Analyste** peut WRITE/UPDATE mais **jamais VALIDATE**.
- **Guichetier/Caissier** : WRITE + VALIDATE des versements, borné à son service.
- **CFO** : VALIDATE trésorerie & comptabilité (département Finance) ; Trésorier/Comptable bornes à leur service.
- **Auditeur** : **READ uniquement**, périmètre `tenant`, aucune écriture nulle part.
- **Conformité** : lit clients/opérations/audit sur tout le tenant, VALIDATE les opérations suspectes.
- **RH & Logistique** : gère les comptes (`users`) au périmètre tenant, le dossier RH au département.

Côté code : `requirePrivilege(resource, verb)` bloque (403) hors autorisation et
expose `req.rbacScope` ; `perimeterClause(user, scope)` construit la clause SQL
de cloisonnement paramétrée correspondante.

## 4. Journalisation d'audit immuable

Table `audit_log` **append-only** (le trigger `trg_audit_immutable` rejette
toute UPDATE/DELETE). Chaque entrée porte le contexte attendu par l'IA
anti-fraude :

- `actor_id` (user_id), `actor_role`, `department`, `service`
- `action`, `entity`, `entity_id`, `payload` (données modifiées, JSONB)
- `created_at` (timestamp)

Deux alimentations : le trigger `fn_audit()` (INSERT/UPDATE/DELETE des tables
sensibles, qui lit l'acteur via les variables de session posées par
`bindActor()`), et `auditEvent()` pour les actions métier (validation d'un
dossier, connexion, etc.). Consultation via `GET /api/v1/audit-log`
(réservée aux profils habilités READ sur `audit`).

## 5. Endpoints

- `GET /api/v1/structure` — référentiel (départements, services, rôles)
- `GET /api/v1/structure/rbac` — matrice complète rôles × ressources × verbes
- `POST /api/v1/structure/seed` — matérialise la structure pour le tenant (admin)
- `GET /api/v1/audit-log` — journal d'audit immuable du tenant

## 6. Déploiement

Migration **additive et idempotente** (`db/schema_v11.sql`), exécutée par
`backend/src/migrate.js` (ajoutée à la chaîne + seed de la structure pour
chaque tenant existant). Aucune migration de données, aucun ancien rôle
supprimé. Sur Render : redéployer puis lancer la migration habituelle.
