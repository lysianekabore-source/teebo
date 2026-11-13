# Fiche de synthèse des rôles — Formation des utilisateurs teeBo

> Document de formation. Il décrit, pour chaque poste de l'organisation, son rattachement, son niveau hiérarchique, son autorité de validation et les **actions concrètes** autorisées dans l'application. Le cloisonnement par IMF et par entité (Siège → Agence → Guichet) s'applique à toutes ces actions : chacun ne voit que le périmètre de son unité.

## Comment lire cette fiche

- **Niveau** : rang hiérarchique (0 à 100).
- **Validation** : capacité à approuver/valider (0 = pas d'autorité de validation).
- **Peut faire** : les habilitations actives du poste (ce que l'utilisateur voit et peut utiliser).
- Les postes **Directeur Général / DGA** disposent d'un accès complet.

## Principes de séparation des tâches (anti-fraude)

1. **Le caissier ne s'auto-approuve pas** : il saisit et déclare, mais l'approbation des versements/retraits et les arrêtés de caisse relèvent d'un supérieur (Chef de caisse, Chef d'agence, Directeur des Opérations).
2. **Coffre ≠ comptabilité** : les mouvements de coffre/caisse (habilitation « Coffre / Trésorerie ») et la tenue des écritures comptables sont confiés à des postes distincts.
3. **Audit en lecture seule** : les postes d'audit, de contrôle et d'inspection consultent sans pouvoir modifier les opérations.
4. **Validation finale du crédit** réservée aux postes habilités (Direction, Directeur du Crédit, Chef de Service Octroi).
5. **Cloisonnement strict** : un guichet ne voit que son point de service ; une agence voit son périmètre et ses guichets rattachés ; le Siège voit tout — toujours dans la même IMF.


## 1. Département : Direction Générale

### Service : Pilotage stratégique

#### Directeur Général (DG)
- **Rôle système** : `superadmin` — Encadrant · Autorité de validation (niveau 100)
- **Niveau** : 100 · **Validation** : 100
- **Peut faire** : Accès COMPLET à l'IMF (toutes les habilitations). La Direction Générale n'est bloquée par aucun module.

#### Directeur Général Adjoint (DGA)
- **Rôle système** : `superadmin` — Encadrant · Autorité de validation (niveau 95)
- **Niveau** : 95 · **Validation** : 95
- **Peut faire** : Accès COMPLET à l'IMF (toutes les habilitations). La Direction Générale n'est bloquée par aucun module.

#### Assistante de Direction
- **Rôle système** : `office_staff` — Opérationnel
- **Niveau** : 20 · **Validation** : 0
- **Peut faire** :
    - Objectifs — consulter
    - Organisation — consulter l’arborescence
    - Consultation des relevés & rapports
    - Personnel — consulter l’annuaire


## 2. Département : Conformité (LAB-FT)

### Service : Réglementation BCEAO

#### Responsable Conformité
- **Rôle système** : `compliance_officer` — Encadrant · Autorité de validation (niveau 70)
- **Niveau** : 80 · **Validation** : 70
- **Peut faire** :
    - Audit — consulter la piste d’audit
    - Clients — consulter les dossiers
    - Conformité — traiter les déclarations
    - Conformité — consulter les alertes LBC/FT
    - Opérations — consulter
    - Rapports — exporter (PDF / tableur)
    - Consultation des relevés & rapports

#### Juriste Spécialiste Microfinance
- **Rôle système** : `compliance_officer` — Opérationnel
- **Niveau** : 60 · **Validation** : 0
- **Peut faire** :
    - Clients — consulter les dossiers
    - Conformité — consulter les alertes LBC/FT
    - Consultation des relevés & rapports

### Service : Protection des Données (LBA/FT & KYC)

#### Analyste LBA/FT
- **Rôle système** : `compliance_officer` — Opérationnel
- **Niveau** : 60 · **Validation** : 0
- **Peut faire** :
    - Clients — consulter les dossiers
    - Conformité — traiter les déclarations
    - Conformité — consulter les alertes LBC/FT
    - Opérations — consulter
    - Consultation des relevés & rapports

#### DPO (Data Protection Officer)
- **Rôle système** : `compliance_officer` — Autorité de validation (niveau 40)
- **Niveau** : 60 · **Validation** : 40
- **Peut faire** :
    - Conformité — consulter les alertes LBC/FT
    - Consultation des relevés & rapports
    - Sécurité — consulter les journaux de connexion


## 3. Département : Système d'Information & Sécurité

### Service : Support & Infrastructures

#### Administrateur Système & Réseau
- **Rôle système** : `it_admin` — Encadrant · Autorité de validation (niveau 60)
- **Niveau** : 80 · **Validation** : 60
- **Peut faire** :
    - Terminaux — enrôler / révoquer
    - Terminaux — consulter le parc
    - Organisation — consulter l’arborescence
    - Sécurité — consulter les journaux de connexion
    - Personnel — consulter l’annuaire

#### Technicien Support Informatique
- **Rôle système** : `it_admin` — Opérationnel
- **Niveau** : 40 · **Validation** : 0
- **Peut faire** :
    - Terminaux — consulter le parc
    - Sécurité — consulter les journaux de connexion

### Service : Cybersécurité & Data IA

#### Responsable Sécurité des SI (RSSI)
- **Rôle système** : `security_engineer` — Encadrant · Autorité de validation (niveau 60)
- **Niveau** : 80 · **Validation** : 60
- **Peut faire** :
    - Audit — consulter la piste d’audit
    - Conformité — consulter les alertes LBC/FT
    - Terminaux — enrôler / révoquer
    - Terminaux — consulter le parc
    - Sécurité — consulter les journaux de connexion

#### Data Scientist
- **Rôle système** : `security_engineer` — Opérationnel
- **Niveau** : 60 · **Validation** : 0
- **Peut faire** :
    - Opérations — consulter
    - Rapports — exporter (PDF / tableur)
    - Consultation des relevés & rapports


## 4. Département : Crédit

### Service : Direction Crédit

#### Directeur du Crédit
- **Rôle système** : `credit_director` — Encadrant · Autorité de validation (niveau 80)
- **Niveau** : 80 · **Validation** : 80
- **Peut faire** :
    - Clients — consulter les dossiers
    - Crédit — instruire / analyser
    - Crédit — consulter les dossiers
    - Crédit — écran de VALIDATION FINALE (octroi)
    - Objectifs — tableau de bord équipe
    - Objectifs — consulter
    - Objectifs — créer / répartir
    - Opérations — consulter
    - Rapports — exporter (PDF / tableur)
    - Consultation des relevés & rapports

### Service : Analyse & Octroi

#### Chef de Service Octroi
- **Rôle système** : `credit_director` — Encadrant · Autorité de validation (niveau 70)
- **Niveau** : 70 · **Validation** : 70
- **Peut faire** :
    - Clients — consulter les dossiers
    - Crédit — instruire / analyser
    - Crédit — consulter les dossiers
    - Crédit — écran de VALIDATION FINALE (octroi)
    - Objectifs — tableau de bord équipe
    - Objectifs — consulter
    - Opérations — consulter
    - Consultation des relevés & rapports

#### Analyste de Crédit
- **Rôle système** : `credit_analyst` — Opérationnel
- **Niveau** : 60 · **Validation** : 0
- **Peut faire** :
    - Clients — consulter les dossiers
    - Crédit — initier une demande
    - Crédit — instruire / analyser
    - Crédit — consulter les dossiers
    - Opérations — consulter
    - Consultation des relevés & rapports
    - Épargne — consulter les comptes

#### Gestionnaire de portefeuille
- **Rôle système** : `credit_analyst` — Opérationnel
- **Niveau** : 55 · **Validation** : 0
- **Peut faire** :
    - Clients — consulter les dossiers
    - Crédit — instruire / analyser
    - Crédit — consulter les dossiers
    - Opérations — consulter
    - Consultation des relevés & rapports

#### Agent de Crédit
- **Rôle système** : `credit_analyst` — Superviseur de collecte
- **Niveau** : 50 · **Validation** : 0
- **Peut faire** :
    - Clients — consulter les dossiers
    - Collecte — affecter les collectrices
    - Collecte — superviser les encaissements
    - Crédit — initier une demande
    - Crédit — instruire / analyser
    - Crédit — consulter les dossiers
    - Opérations — consulter
    - Consultation des relevés & rapports
    - Épargne — consulter les comptes

### Service : Recouvrement & Contentieux

#### Responsable Recouvrement
- **Rôle système** : `recovery_agent` — Encadrant · Autorité de validation (niveau 60)
- **Niveau** : 70 · **Validation** : 60
- **Peut faire** :
    - Clients — consulter les dossiers
    - Crédit — consulter les dossiers
    - Crédit — recouvrement & contentieux
    - Opérations — consulter
    - Consultation des relevés & rapports

#### Spécialiste Contentieux
- **Rôle système** : `recovery_agent` — Opérationnel
- **Niveau** : 55 · **Validation** : 0
- **Peut faire** :
    - Clients — consulter les dossiers
    - Crédit — consulter les dossiers
    - Crédit — recouvrement & contentieux

#### Agent de Recouvrement
- **Rôle système** : `recovery_agent` — Opérationnel
- **Niveau** : 50 · **Validation** : 0
- **Peut faire** :
    - Clients — consulter les dossiers
    - Crédit — consulter les dossiers
    - Crédit — recouvrement & contentieux
    - Opérations — consulter


## 5. Département : Opérations

### Service : Direction Opérations

#### Directeur des Opérations / Réseau
- **Rôle système** : `operations_director` — Encadrant · Autorité de validation (niveau 80)
- **Niveau** : 80 · **Validation** : 80
- **Peut faire** :
    - Caisse — approuver les versements/retraits
    - Clients — modifier les dossiers (KYC)
    - Clients — consulter les dossiers
    - Collecte — affecter les collectrices
    - Collecte — superviser les encaissements
    - Objectifs — tableau de bord équipe
    - Objectifs — consulter
    - Objectifs — créer / répartir
    - Opérations — consulter
    - Opérations — valider / contre-passer
    - Rapports — exporter (PDF / tableur)
    - Consultation des relevés & rapports
    - Collecte — organiser les tournées
    - Épargne — ouvrir / paramétrer les comptes
    - Épargne — consulter les comptes
    - Personnel — consulter l’annuaire
    - Coffre / Trésorerie — mouvements de caisse & coffre

### Service : Caisses & Guichets

#### Chef d'Agence
- **Rôle système** : `agency` — Encadrant · Autorité de validation (niveau 60) · Superviseur de collecte
- **Niveau** : 70 · **Validation** : 60
- **Peut faire** :
    - Caisse — approuver les versements/retraits
    - Enrôlement des clients
    - Clients — geler / dégeler un compte
    - Clients — modifier les dossiers (KYC)
    - Clients — consulter les dossiers
    - Collecte — affecter les collectrices
    - Collecte — superviser les encaissements
    - Crédit — consulter les dossiers
    - Crédit — recouvrement & contentieux
    - Objectifs — tableau de bord équipe
    - Objectifs — consulter
    - Objectifs — créer / répartir
    - Opérations — consulter
    - Opérations — valider / contre-passer
    - Opérations — saisir
    - Rapports — exporter (PDF / tableur)
    - Consultation des relevés & rapports
    - Collecte — organiser les tournées
    - Tournée du jour (collecte)
    - Épargne — ouvrir / paramétrer les comptes
    - Épargne — consulter les comptes
    - Personnel — consulter l’annuaire
    - Coffre / Trésorerie — mouvements de caisse & coffre

#### Chef de Caisse
- **Rôle système** : `teller` — Encadrant · Autorité de validation (niveau 50)
- **Niveau** : 60 · **Validation** : 50
- **Peut faire** :
    - Caisse — approuver les versements/retraits
    - Déclaration des versements
    - Validation des versements
    - Enrôlement des clients
    - Clients — consulter les dossiers
    - Opérations — consulter
    - Opérations — valider / contre-passer
    - Opérations — saisir
    - Consultation des relevés & rapports
    - Tournée du jour (collecte)
    - Épargne — consulter les comptes
    - Coffre / Trésorerie — mouvements de caisse & coffre

#### Caissier / Guichetier
- **Rôle système** : `teller` — Autorité de validation (niveau 10)
- **Niveau** : 40 · **Validation** : 10
- **Peut faire** :
    - Déclaration des versements
    - Validation des versements
    - Enrôlement des clients
    - Clients — consulter les dossiers
    - Opérations — consulter
    - Opérations — saisir
    - Tournée du jour (collecte)
    - Épargne — consulter les comptes

### Service : Client & Canaux Digitaux

#### Gestionnaire de Clientèle
- **Rôle système** : `customer_agent` — Opérationnel
- **Niveau** : 50 · **Validation** : 0
- **Peut faire** :
    - Enrôlement des clients
    - Clients — modifier les dossiers (KYC)
    - Clients — consulter les dossiers
    - Opérations — consulter
    - Consultation des relevés & rapports
    - Épargne — consulter les comptes

#### Agent Support Canaux Digitaux
- **Rôle système** : `customer_agent` — Opérationnel
- **Niveau** : 40 · **Validation** : 0
- **Peut faire** :
    - Clients — consulter les dossiers
    - Terminaux — consulter le parc
    - Opérations — consulter
    - Épargne — consulter les comptes

#### Agent de collecte
- **Rôle système** : `collectrice` — Doit être rattaché à un superviseur
- **Niveau** : 30 · **Validation** : 0
- **Peut faire** :
    - Déclaration des versements
    - Enrôlement des clients
    - Clients — consulter les dossiers
    - Objectifs — consulter
    - Opérations — consulter
    - Tournée du jour (collecte)
    - Épargne — consulter les comptes


## 6. Département : Finance

### Service : Direction Finance

#### Directeur Financier (CFO)
- **Rôle système** : `cfo` — Encadrant · Autorité de validation (niveau 80)
- **Niveau** : 80 · **Validation** : 80
- **Peut faire** :
    - Tarification — frais & commissions
    - Objectifs — consulter
    - Opérations — consulter
    - Opérations — valider / contre-passer
    - Rapports — exporter (PDF / tableur)
    - Consultation des relevés & rapports
    - Épargne — consulter les comptes
    - Coffre / Trésorerie — mouvements de caisse & coffre

### Service : Trésorerie & Réconciliation

#### Trésorier
- **Rôle système** : `treasurer` — Autorité de validation (niveau 50)
- **Niveau** : 60 · **Validation** : 50
- **Peut faire** :
    - Opérations — consulter
    - Rapports — exporter (PDF / tableur)
    - Consultation des relevés & rapports
    - Épargne — consulter les comptes
    - Coffre / Trésorerie — mouvements de caisse & coffre

#### Analyste Flux Mobile Money
- **Rôle système** : `treasurer` — Opérationnel
- **Niveau** : 55 · **Validation** : 0
- **Peut faire** :
    - Opérations — consulter
    - Consultation des relevés & rapports
    - Épargne — consulter les comptes

### Service : Reporting Réglementaire

#### Chef Comptable
- **Rôle système** : `accountant` — Encadrant · Autorité de validation (niveau 60)
- **Niveau** : 65 · **Validation** : 60
- **Peut faire** :
    - Comptabilité — tenir les comptes & écritures
    - Crédit — consulter les dossiers
    - Tarification — frais & commissions
    - Opérations — consulter
    - Opérations — valider / contre-passer
    - Rapports — exporter (PDF / tableur)
    - Consultation des relevés & rapports
    - Épargne — consulter les comptes

#### Comptable
- **Rôle système** : `accountant` — Opérationnel
- **Niveau** : 50 · **Validation** : 0
- **Peut faire** :
    - Comptabilité — tenir les comptes & écritures
    - Crédit — consulter les dossiers
    - Opérations — consulter
    - Rapports — exporter (PDF / tableur)
    - Consultation des relevés & rapports
    - Épargne — consulter les comptes


## 7. Département : Audit Interne

### Service : Direction Audit

#### Directeur de l'Audit et des Risques
- **Rôle système** : `auditor` — Encadrant · Autorité de validation (niveau 80)
- **Niveau** : 80 · **Validation** : 80
- **Peut faire** :
    - Audit — consulter la piste d’audit
    - Clients — consulter les dossiers
    - Conformité — consulter les alertes LBC/FT
    - Crédit — consulter les dossiers
    - Opérations — consulter
    - Organisation — consulter l’arborescence
    - Rapports — exporter (PDF / tableur)
    - Consultation des relevés & rapports
    - Épargne — consulter les comptes
    - Sécurité — consulter les journaux de connexion
    - Personnel — consulter l’annuaire

### Service : Contrôle Permanent

#### Contrôleur Permanent
- **Rôle système** : `auditor` — Opérationnel
- **Niveau** : 60 · **Validation** : 0
- **Peut faire** :
    - Audit — consulter la piste d’audit
    - Clients — consulter les dossiers
    - Conformité — consulter les alertes LBC/FT
    - Crédit — consulter les dossiers
    - Opérations — consulter
    - Consultation des relevés & rapports
    - Épargne — consulter les comptes

#### Auditeur Interne
- **Rôle système** : `auditor` — Opérationnel
- **Niveau** : 60 · **Validation** : 0
- **Peut faire** :
    - Audit — consulter la piste d’audit
    - Clients — consulter les dossiers
    - Conformité — consulter les alertes LBC/FT
    - Crédit — consulter les dossiers
    - Opérations — consulter
    - Organisation — consulter l’arborescence
    - Rapports — exporter (PDF / tableur)
    - Consultation des relevés & rapports
    - Épargne — consulter les comptes
    - Sécurité — consulter les journaux de connexion
    - Personnel — consulter l’annuaire

### Service : Inspection & Anti-Fraude

#### Inspecteur
- **Rôle système** : `auditor` — Opérationnel
- **Niveau** : 60 · **Validation** : 0
- **Peut faire** :
    - Audit — consulter la piste d’audit
    - Clients — consulter les dossiers
    - Crédit — consulter les dossiers
    - Opérations — consulter
    - Consultation des relevés & rapports

#### Analyste Fraude Technologique
- **Rôle système** : `auditor` — Opérationnel
- **Niveau** : 60 · **Validation** : 0
- **Peut faire** :
    - Audit — consulter la piste d’audit
    - Opérations — consulter
    - Consultation des relevés & rapports
    - Sécurité — consulter les journaux de connexion


## 8. Département : Ressources Humaines & Logistique

### Service : Direction Support

#### Directeur RH & Logistique
- **Rôle système** : `hr_logistics_manager` — Encadrant · Autorité de validation (niveau 80)
- **Niveau** : 80 · **Validation** : 80
- **Peut faire** :
    - Organisation — consulter l’arborescence
    - Consultation des relevés & rapports
    - Personnel — créer des comptes & envoyer les codes
    - Personnel — consulter l’annuaire

### Service : Paie & Administration

#### Responsable RH
- **Rôle système** : `hr_logistics_manager` — Encadrant · Autorité de validation (niveau 60)
- **Niveau** : 70 · **Validation** : 60
- **Peut faire** :
    - Organisation — consulter l’arborescence
    - Consultation des relevés & rapports
    - Personnel — créer des comptes & envoyer les codes
    - Personnel — consulter l’annuaire

#### Gestionnaire de Paie
- **Rôle système** : `hr_logistics_manager` — Opérationnel
- **Niveau** : 50 · **Validation** : 0
- **Peut faire** :
    - Consultation des relevés & rapports
    - Personnel — consulter l’annuaire

### Service : Logistique & Patrimoine

#### Responsable Logistique
- **Rôle système** : `hr_logistics_manager` — Encadrant · Autorité de validation (niveau 50)
- **Niveau** : 70 · **Validation** : 50
- **Peut faire** :
    - Terminaux — enrôler / révoquer
    - Terminaux — consulter le parc
    - Organisation — consulter l’arborescence
    - Consultation des relevés & rapports

#### Gestionnaire de Stock
- **Rôle système** : `hr_logistics_manager` — Opérationnel
- **Niveau** : 45 · **Validation** : 0
- **Peut faire** :
    - Terminaux — consulter le parc
    - Consultation des relevés & rapports

#### Gestionnaire de la Flotte
- **Rôle système** : `hr_logistics_manager` — Opérationnel
- **Niveau** : 45 · **Validation** : 0
- **Peut faire** :
    - Terminaux — consulter le parc
    - Consultation des relevés & rapports


---

**Récapitulatif** : 42 postes répartis sur 8 départements et 20 services. Toutes les habilitations sont cloisonnées par IMF et par entité.
