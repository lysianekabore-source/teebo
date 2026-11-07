# Vérifier les fonctionnalités en local — teebo / IMF

Ce document vous aide à confirmer, **sur votre poste**, que les fonctionnalités
demandées sont bien présentes et opérationnelles avant tout déploiement.
Tout est en français et respecte le cloisonnement hiérarchique
(Guichet → son point de service ; Agence → elle + ses guichets ;
Siège / Direction Générale → tout).

---

## 0. Prérequis

1. Base PostgreSQL créée et schémas appliqués (voir `GUIDE_DEPLOIEMENT.md`,
   ÉTAPES 2 à 4). La commande `npm run migrate` applique automatiquement
   `schema.sql` puis `schema_v3.sql` → `schema_v9.sql`.
2. API démarrée : dans `backend`, `node src/server.js`
   (message `teebo API … http://127.0.0.1:3000`).
3. Un navigateur récent. En cas de page blanche ou d'ancien affichage :
   **Ctrl+Shift+R** (rechargement forcé, pour contourner le cache / service
   worker). Le cache du service worker est passé en version **teebo-v2**.

---

## 1. Application responsive (tout écran)

1. Ouvrez `frontend/app.html` (ou `teebo.html`) dans le navigateur.
2. Ouvrez les outils de développement (F12) → mode « appareil mobile ».
3. Testez trois largeurs : **1200 px**, **768 px**, **375 px**.
   - Attendu : la barre latérale se replie, les tableaux défilent
     horizontalement, les KPI passent sur 1–2 colonnes, les fenêtres (modales
     et feuilles) restent lisibles et les boutons restent cliquables.
4. L'application terrain (`terrain.html`) est déjà au format téléphone
   (colonne centrée ≤ 460 px).

---

## 2. Super-admin teebo : supprimer une IMF

1. Connectez-vous en **administrateur éditeur teebo**.
2. Module **Institutions** → sur une ligne, bouton rouge **Supprimer**.
3. Dans la fenêtre : choisissez **Archiver** (soft) ou **Supprimer
   définitivement** (hard), puis ressaisissez le **code de l'IMF**.
4. Attendu :
   - **Archiver** : l'IMF passe en statut suspendu et reçoit une date
     d'archivage, sans effacement des données.
   - **Supprimer définitivement** : l'IMF et toutes ses données rattachées
     (comptes, clients, budgets…) sont purgées **en cascade**.
   - Dans les deux cas, une **entrée de journal d'audit** est créée
     (`imf_deletion_log`).
5. Contrôle de sécurité : le tenant système `TBO-SYS-000000` (rôle
   `teebo_admin`) ne peut **jamais** être supprimé (bouton bloqué côté interface
   et refus côté serveur).

Contrôle direct en base (facultatif) :

```sql
SELECT imf_code, imf_name, mode, deleted_by_email, created_at
  FROM imf_deletion_log ORDER BY created_at DESC LIMIT 5;
```

---

## 3. Enrôlement client conforme BCEAO (KYC)

1. Application terrain → connexion collectrice → **Nouveau client (KYC BCEAO)**.
2. Renseignez au minimum : **nom complet**, **date de naissance**, **n° de
   pièce d'identité**. Complétez le socle BCEAO : lieu de naissance, sexe,
   nationalité, situation matrimoniale, type et autorité de la pièce, dates de
   délivrance / expiration, identifiant fiscal (NIU/NINA), profession,
   employeur, secteur d'activité, origine des fonds, objet de la relation,
   bénéficiaire effectif, et la case **PPE** (personne politiquement exposée).
3. Autorisez la **géolocalisation** : le client doit être enregistré chez lui
   (le GPS du lieu est capturé automatiquement).
4. Attendu : un **code client** est généré et un message invite à ouvrir le
   compte d'épargne.

Contrôle direct en base (facultatif) :

```sql
SELECT code_client, full_name, gender, nationality, id_type, profession,
       fund_origin, is_pep, beneficial_owner
  FROM client ORDER BY created_at DESC LIMIT 5;
```

> Les mêmes champs KYC sont persistés à l'enrôlement d'un client existant
> (route `/clients/enroll`) et lors de la complétion
> (`/clients/:id/complete-enrollment`).

---

## 4. La collectrice crée un espace client pour tout client

1. Application terrain → **Créer un espace client**.
2. **Recherchez un client existant** (nom, code ou téléphone) et sélectionnez-le.
3. Choisissez le **mode de connexion** (mot de passe / SMS / PIN) et le
   **format de relevé** (PDF / CSV / les deux), puis validez.
4. Attendu : un **mot de passe temporaire** s'affiche ; l'espace en ligne du
   client est créé. Une seconde création sur le même client renvoie
   « espace déjà créé ».

---

## 5. Cloisonnement hiérarchique (rappel à vérifier)

- Une **collectrice** (staff) ne voit que les clients de son point de service.
- Une **agence** voit ses propres clients + ceux de ses guichets rattachés.
- Le **Siège / Direction Générale** voit l'ensemble.

Toute nouvelle donnée (client KYC, espace client, suppression d'IMF) respecte ce
cloisonnement : les requêtes sont toujours filtrées par `imf_id` et par la
position de l'utilisateur dans l'arborescence Siège → Agence → Guichet.

---

## 6. En cas de souci

| Symptôme | Cause probable | Solution |
|---|---|---|
| Page blanche / ancien affichage | cache ou service worker | **Ctrl+Shift+R**, ou redéployez |
| Bouton « Supprimer » refuse | code IMF mal ressaisi | ressaisissez exactement le code affiché |
| « GPS indisponible » à la création client | localisation refusée | autorisez la géolocalisation du navigateur |
| `relation … does not exist` | schémas incomplets | relancez `npm run migrate` |
