# teebo — Récapitulatif des habilitations par profil

> Institution de microfinance (IMF) — zone UEMOA · Conformité BCEAO
> Version : matrice par défaut alignée sur `backend/src/permissions.js`
> Source de vérité technique : `backend/src/permissions.js` (fonction `buildProfilesMatrix`)
> Généré le : 2026-11-07
> Contact : hello@teebo.africa · WhatsApp +226 50 32 14 32 · www.teebo.africa

---

Ce document liste, **profil par profil**, les domaines d’habilitation accordés **par défaut** à la création d’un compte utilisateur IMF. L’administrateur IMF peut ensuite ajuster finement ces droits, entité par entité. Le cloisonnement par IMF (`imf_id`) reste garanti côté base de données.

## 1. Fiche détaillée par profil

### ▸ Administrateur IMF  `admin_imf`

**Habilitations accordées (12/12) :**

- ✅ Organisation — créer / supprimer des unités
- ✅ Personnel — créer des comptes & envoyer les codes
- ✅ Paramètres IMF & mentions légales
- ✅ Autorisations fines inter-entités
- ✅ Objectifs — créer / répartir
- ✅ Objectifs — tableau de bord équipe
- ✅ Objectifs — consulter
- ✅ Enrôlement des clients
- ✅ Tournée du jour (collecte)
- ✅ Déclaration des versements
- ✅ Validation des versements
- ✅ Consultation des relevés & rapports

### ▸ Direction  `direction`

**Habilitations accordées (12/12) :**

- ✅ Organisation — créer / supprimer des unités
- ✅ Personnel — créer des comptes & envoyer les codes
- ✅ Paramètres IMF & mentions légales
- ✅ Autorisations fines inter-entités
- ✅ Objectifs — créer / répartir
- ✅ Objectifs — tableau de bord équipe
- ✅ Objectifs — consulter
- ✅ Enrôlement des clients
- ✅ Tournée du jour (collecte)
- ✅ Déclaration des versements
- ✅ Validation des versements
- ✅ Consultation des relevés & rapports

### ▸ Département  `department`

**Habilitations accordées (7/12) :**

- ✅ Objectifs — créer / répartir
- ✅ Objectifs — tableau de bord équipe
- ✅ Objectifs — consulter
- ✅ Enrôlement des clients
- ✅ Tournée du jour (collecte)
- ✅ Validation des versements
- ✅ Consultation des relevés & rapports

**Non accordées par défaut :** Organisation — créer / supprimer des unités · Personnel — créer des comptes & envoyer les codes · Paramètres IMF & mentions légales · Autorisations fines inter-entités · Déclaration des versements

### ▸ Service  `service`

**Habilitations accordées (7/12) :**

- ✅ Objectifs — créer / répartir
- ✅ Objectifs — tableau de bord équipe
- ✅ Objectifs — consulter
- ✅ Enrôlement des clients
- ✅ Tournée du jour (collecte)
- ✅ Validation des versements
- ✅ Consultation des relevés & rapports

**Non accordées par défaut :** Organisation — créer / supprimer des unités · Personnel — créer des comptes & envoyer les codes · Paramètres IMF & mentions légales · Autorisations fines inter-entités · Déclaration des versements

### ▸ Agence  `agency`

**Habilitations accordées (8/12) :**

- ✅ Personnel — créer des comptes & envoyer les codes
- ✅ Objectifs — créer / répartir
- ✅ Objectifs — tableau de bord équipe
- ✅ Objectifs — consulter
- ✅ Enrôlement des clients
- ✅ Tournée du jour (collecte)
- ✅ Validation des versements
- ✅ Consultation des relevés & rapports

**Non accordées par défaut :** Organisation — créer / supprimer des unités · Paramètres IMF & mentions légales · Autorisations fines inter-entités · Déclaration des versements

### ▸ Personnel / collectrice  `staff`

**Habilitations accordées (4/12) :**

- ✅ Objectifs — consulter
- ✅ Enrôlement des clients
- ✅ Tournée du jour (collecte)
- ✅ Déclaration des versements

**Non accordées par défaut :** Organisation — créer / supprimer des unités · Personnel — créer des comptes & envoyer les codes · Paramètres IMF & mentions légales · Autorisations fines inter-entités · Objectifs — créer / répartir · Objectifs — tableau de bord équipe · Validation des versements · Consultation des relevés & rapports

### ▸ Caissier  `caissier`

**Habilitations accordées (4/12) :**

- ✅ Objectifs — consulter
- ✅ Déclaration des versements
- ✅ Validation des versements
- ✅ Consultation des relevés & rapports

**Non accordées par défaut :** Organisation — créer / supprimer des unités · Personnel — créer des comptes & envoyer les codes · Paramètres IMF & mentions légales · Autorisations fines inter-entités · Objectifs — créer / répartir · Objectifs — tableau de bord équipe · Enrôlement des clients · Tournée du jour (collecte)

---

## 2. Matrice synthétique (domaines × profils)

Légende : ✅ accordé par défaut · — non accordé

| Domaine d’habilitation | Administrateur IMF | Direction | Département | Service | Agence | Personnel / collectrice | Caissier |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Organisation — créer / supprimer des unités | ✅ | ✅ | — | — | — | — | — |
| Personnel — créer des comptes & envoyer les codes | ✅ | ✅ | — | — | ✅ | — | — |
| Paramètres IMF & mentions légales | ✅ | ✅ | — | — | — | — | — |
| Autorisations fines inter-entités | ✅ | ✅ | — | — | — | — | — |
| Objectifs — créer / répartir | ✅ | ✅ | ✅ | ✅ | ✅ | — | — |
| Objectifs — tableau de bord équipe | ✅ | ✅ | ✅ | ✅ | ✅ | — | — |
| Objectifs — consulter | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Enrôlement des clients | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Tournée du jour (collecte) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Déclaration des versements | ✅ | ✅ | — | — | — | ✅ | ✅ |
| Validation des versements | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| Consultation des relevés & rapports | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |

---

## 3. Alias du module Objectifs

Trois profils simplifiés correspondent aux rôles socle :

| Alias | Rôle socle équivalent | Habilitations par défaut |
|---|---|---|
| `dg` | `direction` | Organisation — créer / supprimer des unités · Personnel — créer des comptes & envoyer les codes · Paramètres IMF & mentions légales · Autorisations fines inter-entités · Objectifs — créer / répartir · Objectifs — tableau de bord équipe · Objectifs — consulter · Enrôlement des clients · Tournée du jour (collecte) · Déclaration des versements · Validation des versements · Consultation des relevés & rapports |
| `supervisor` | `service` | Objectifs — créer / répartir · Objectifs — tableau de bord équipe · Objectifs — consulter · Enrôlement des clients · Tournée du jour (collecte) · Validation des versements · Consultation des relevés & rapports |
| `collectrice` | `staff` | Objectifs — consulter · Enrôlement des clients · Tournée du jour (collecte) · Déclaration des versements |

---

## 4. Règles transverses

1. **Cloisonnement par IMF** : chaque requête est bornée à `imf_id = utilisateur.imf_id`.
2. **Ajustement fin** : l’administrateur IMF peut accorder ou retirer un domaine, entité par entité (table `user_permission`).
3. **Par défaut, aucune visibilité croisée** entre utilisateurs ou entités non autorisés.
4. **2FA obligatoire** pour les profils à privilèges (Administrateur IMF, Direction, encadrement).
5. **Rotation du mot de passe** : expiration automatique après 60 jours ; déconnexion auto après 30 min d’inactivité.

---

_IMF · Agrément BCEAO · teebo — plateforme des institutions de microfinance en zone UEMOA._
