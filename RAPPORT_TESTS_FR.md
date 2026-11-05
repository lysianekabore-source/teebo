# Rapport de tests — Module Objectifs & Notifications (VAGUE 7)

**Résultat global : 57 réussis / 0 échec ✅**

| Suite | Résultat | Commande |
|---|---|---|
| Module Objectifs | **45 / 45** ✅ | `bash tests/run_v7.sh` |
| Notifications automatiques | **12 / 12** ✅ | `bash tests/run_notif.sh` |

Base : PostgreSQL local (schéma `schema_v3.sql`). Suites : cas bout en bout.

---

## 1. Hiérarchie organisationnelle — 7/7
- Arborescence direction > département > service > agence créée.
- DG + superviseur + 3 collectrices créés.
- Superviseur rattaché au DG ; 3 collectrices rattachées au superviseur.
- Cycle hiérarchique refusé (anti-boucle).
- Référentiel KPI exposé (3 KPI + périodes + unités).

## 2. Affectation descendante + contrôle de cohérence — 16/16
- DG assigne une cible au superviseur → 201, statut initial PENDING.
- DG → collectrice refusé (saut de niveau).
- Répartition groupée 500k < objectif global 1M → **422**.
  - Message explicite contenant « inférieure ».
  - Écart manquant chiffré : 500 000.
  - **Tout-ou-rien** vérifié : aucune cible d'équipe écrite après refus.
- Répartition conforme 1M → **201**, cohérence confirmée (team_total ≥ global).
- 3 cibles d'équipe créées.
- Saisie unitaire en brouillon acceptée.
- Baisse cassant la couverture → **422**.
- Superviseur → superviseur refusé (`invalid_assignment_direction`).

## 3. Roll-up temps réel de la progression — 3/3
- Dépôt → progression incrémentée.
- Roll-up remonte collectrice **et** superviseur.
- **Rejeu du même dépôt ignoré** (idempotence) : `skipped = duplicate`.
- Ouverture de compte → KPI NEW_ACCOUNTS.

## 4. Tableaux de bord temps réel — 9/9
- Vue superviseur accessible ; progression propre + équipe.
- Agrégation : réalisé superviseur = 250 000 (remontée de la collectrice).
- Réalisé collectrice 1 visible côté superviseur.
- Consolidation équipe vs objectif global ; objectif global de référence présent.
- Vue consolidée branche (DG) accessible ; recalcul forcé du roll-up branche.

## 5. Accès collectrice (lecture seule) — 4/4
- Collectrice connectée ; consulte ses propres cibles.
- Collectrice ne peut pas créer de cible → **403**.

## 6. Notifications automatiques — 12/12
- Palier **50 %** déclenché au franchissement de la moitié de la cible.
- Palier **80 %** (« bientôt atteint ») déclenché au bon seuil.
- Palier **100 %** (« objectif atteint ») déclenché exactement une fois.
- **Remontée sur toute la chaîne** : la collectrice, le superviseur **et** le DG
  reçoivent chacun leur notification.
- **Idempotence** : le rejeu de la même collecte ne crée **aucun doublon**
  de notification (index unique par événement).
- Journal consultable via `GET /api/v1/objectives/notifications`.
- Veille de fin de période : les objectifs non atteints génèrent une alerte
  (`notifyExpiredFailures`) lors du recalcul de branche.
- Notification livrée en mode développement (journal e-mail + WhatsApp).

---

## Bugs de cause racine corrigés

1. **Idempotence transactionnelle**
   - Symptôme : le rejeu d'un dépôt renvoyait `25P02` (transaction avortée).
   - Cause : un `catch` d'exception sur la contrainte unique avortait toute
     la transaction PostgreSQL, cassant le rejeu **et** le roll-up.
   - Correctif : `INSERT … ON CONFLICT DO NOTHING` (la transaction reste vivante).

2. **Priorité du contrôle de direction**
   - Symptôme : une affectation vers un profil pair renvoyait `not_your_report`
     au lieu de la règle de direction.
   - Cause : le contrôle de rattachement `parent_id` s'exécutait avant la
     vérification du profil autorisé.
   - Correctif : la direction d'affectation est vérifiée en premier
     (`invalid_assignment_direction`).

3. **Fuseau horaire**
   - Symptôme : perte de date au passage JS (décalage d'un jour).
   - Cause : conversion `Date → toISOString()` d'un type `DATE`.
   - Correctif : lecture des dates en `::text` côté SQL, sans conversion JS.

---

## Note de vérification
Environnement **sans accès Internet** : la syntaxe JavaScript et les tests
bout en bout sur base PostgreSQL **locale** sont validés (57/57). La validation
en ligne (déploiement réel, envoi effectif WhatsApp/SMTP) reste à effectuer
lors de la mise en production.
