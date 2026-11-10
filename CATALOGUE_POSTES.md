# Catalogue des postes (≈45) — rattachement strict Département › Service

Chaque utilisateur est désormais rattaché à un **poste** (`position_code`). Le poste
impose automatiquement :

- le **département** et le **service** de rattachement (cloisonnement RBAC) ;
- le **rôle-archetype** qui fournit les **permissions par défaut** (matrice RBAC par
  verbe READ / WRITE / UPDATE / DELETE / VALIDATE, schema_v11) ;
- un **niveau hiérarchique** (`hierarchy_level`, 0→100) et un **niveau de validation**
  (`validation_level`) utilisés par les **circuits d'approbation**.

> Les rôles des utilisateurs déjà créés ne sont pas réécrits : le poste est **additif**.

## Règle de supervision de la collecte

Un **Agent de collecte** (`needs_supervisor = true`) **doit** être rattaché à un
**Superviseur** dont le poste peut superviser la collecte :
**Chef d'agence** OU **Agent de crédit** (`can_supervise_collectors = true`).
La règle est appliquée côté interface (champ Superviseur conditionnel) **et** côté
serveur (validation à la création : `supervisor_required` / `invalid_supervisor`).

## 1. Direction Générale (DG)
| Poste | Service | Archetype RBAC | Niv. hiér. | Niv. valid. |
|---|---|---|---|---|
| Directeur Général (DG) | Pilotage | superadmin | 100 | 100 |
| Directeur Général Adjoint (DGA) | Pilotage | superadmin | 95 | 95 |
| Assistante de Direction | Pilotage | office_staff | 20 | 0 |

## 2. Conformité & Juridique
| Poste | Service | Archetype | Niv. hiér. | Niv. valid. |
|---|---|---|---|---|
| Responsable Conformité | Réglementation BCEAO | compliance_officer | 80 | 70 |
| Juriste Spécialiste Microfinance | Réglementation BCEAO | compliance_officer | 60 | 0 |
| Analyste LBA/FT | Protection des Données | compliance_officer | 60 | 0 |
| DPO | Protection des Données | compliance_officer | 60 | 40 |

## 3. Système d'Information & Sécurité
| Poste | Service | Archetype | Niv. hiér. | Niv. valid. |
|---|---|---|---|---|
| Administrateur Système & Réseau | Support & Infrastructures | it_admin | 80 | 60 |
| Technicien Support Informatique | Support & Infrastructures | it_admin | 40 | 0 |
| Responsable Sécurité des SI (RSSI) | Cybersécurité & Data IA | security_engineer | 80 | 60 |
| Data Scientist | Cybersécurité & Data IA | security_engineer | 60 | 0 |

## 4. Crédit & Engagement
| Poste | Service | Archetype | Niv. hiér. | Niv. valid. | Superv. collecte |
|---|---|---|---|---|---|
| Directeur du Crédit | Direction Crédit | credit_director | 80 | 80 | — |
| Chef de Service Octroi | Analyse & Octroi | credit_director | 70 | 70 | — |
| Analyste de Crédit | Analyse & Octroi | credit_analyst | 60 | 0 | — |
| Gestionnaire de portefeuille | Analyse & Octroi | credit_analyst | 55 | 0 | — |
| **Agent de Crédit** | Analyse & Octroi | credit_analyst | 50 | 0 | **Oui** |
| Responsable Recouvrement | Recouvrement & Contentieux | recovery_agent | 70 | 60 | — |
| Agent de Recouvrement | Recouvrement & Contentieux | recovery_agent | 50 | 0 | — |
| Spécialiste Contentieux | Recouvrement & Contentieux | recovery_agent | 55 | 0 | — |

## 5. Opérations & Réseau
| Poste | Service | Archetype | Niv. hiér. | Niv. valid. | Superv. collecte | Besoin superviseur |
|---|---|---|---|---|---|---|
| Directeur des Opérations / Réseau | Direction Opérations | operations_director | 80 | 80 | — | — |
| **Chef d'Agence** | Caisses & Guichets | agency | 70 | 60 | **Oui** | — |
| Chef de Caisse | Caisses & Guichets | teller | 60 | 50 | — | — |
| Caissier / Guichetier | Caisses & Guichets | teller | 40 | 10 | — | — |
| Gestionnaire de Clientèle | Client & Canaux Digitaux | customer_agent | 50 | 0 | — | — |
| Agent Support Canaux Digitaux | Client & Canaux Digitaux | customer_agent | 40 | 0 | — | — |
| **Agent de collecte** | Client & Canaux Digitaux | collectrice | 30 | 0 | — | **Oui** |

## 6. Finance, Comptabilité & Trésorerie
| Poste | Service | Archetype | Niv. hiér. | Niv. valid. |
|---|---|---|---|---|
| Directeur Financier (CFO) | Direction Finance | cfo | 80 | 80 |
| Trésorier | Trésorerie & Réconciliation | treasurer | 60 | 50 |
| Analyste Flux Mobile Money | Trésorerie & Réconciliation | treasurer | 55 | 0 |
| Chef Comptable | Reporting Réglementaire | accountant | 65 | 60 |
| Comptable | Reporting Réglementaire | accountant | 50 | 0 |

## 7. Audit, Risques & Contrôle Interne
| Poste | Service | Archetype | Niv. hiér. | Niv. valid. |
|---|---|---|---|---|
| Directeur de l'Audit et des Risques | Direction Audit | auditor | 80 | 80 |
| Contrôleur Permanent | Contrôle Permanent | auditor | 60 | 0 |
| Auditeur Interne | Contrôle Permanent | auditor | 60 | 0 |
| Inspecteur | Inspection & Anti-Fraude | auditor | 60 | 0 |
| Analyste Fraude Technologique | Inspection & Anti-Fraude | auditor | 60 | 0 |

## 8. Capital Humain & Moyens Généraux
| Poste | Service | Archetype | Niv. hiér. | Niv. valid. |
|---|---|---|---|---|
| Directeur RH & Logistique | Direction Support | hr_logistics_manager | 80 | 80 |
| Responsable RH | Paie & Administration | hr_logistics_manager | 70 | 60 |
| Gestionnaire de Paie | Paie & Administration | hr_logistics_manager | 50 | 0 |
| Responsable Logistique | Logistique & Patrimoine | hr_logistics_manager | 70 | 50 |
| Gestionnaire de Stock | Logistique & Patrimoine | hr_logistics_manager | 45 | 0 |
| Gestionnaire de la Flotte | Logistique & Patrimoine | hr_logistics_manager | 45 | 0 |

---

## Points techniques

- **Base** : `db/schema_v12.sql` — table `position_catalog` (+ `app_user.position_code`),
  fonctions `fn_position_can_supervise()` / `fn_position_needs_supervisor()`, nouvel
  archetype `office_staff` (enum + role_catalog + rbac_rule), services détaillés.
- **Runtime** : `backend/src/org_structure.js` (`POSITIONS[]` + helpers), `rbac.js`
  (archetypes `office_staff` + rétrocompatibilité `agency`/`collectrice`/`teller`…),
  `routes/structure.js` (`GET /api/v1/positions`), `routes/org.js` (`POST /users`
  accepte `position_code` → dérive rôle/département/service/permissions + valide le
  superviseur), `migrate.js` (+schema_v12).
- **Interface** : `assets/app.js` — liste déroulante « Poste occupé » groupée
  Département › Service, et champ **Superviseur** affiché uniquement pour un
  Agent de collecte.
- **PWA** : Service Worker `teebo-v6` (zn + zr) — pensez à un rechargement forcé
  (Ctrl+Shift+R) après déploiement.
- **Cloisonnement multi-tenant (`imf_id`) et pistes d'audit immuables inchangés.**
