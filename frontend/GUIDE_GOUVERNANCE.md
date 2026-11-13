# Guide — Gouvernance & conformité (teeBo)

Ce module répond à trois besoins concrets :

1. **Vérifier que la plateforme est bien multi-IMF.** Chaque institution ne voit
   que ses propres données ; teeBo (l'éditeur) dispose de sa console d'approbation.
2. **Tenir les six registres de gouvernance** exigés par la loi-cadre UMOA et
   suivre la conformité à partir d'un tableau de bord unique.
3. **Éviter la double saisie** : tout ce qui existe déjà ailleurs dans
   l'application est repris automatiquement.

---

## 1. Le multi-IMF, comment ça marche réellement

- Une **IMF = un tenant**. Chaque enregistrement porte l'identifiant de
  l'institution (`imf_id`) ; toutes les lectures et toutes les écritures sont
  filtrées par cet identifiant, y compris les six nouveaux registres de
  gouvernance. Aucune requête ne peut renvoyer les données d'une autre IMF.
- **Chaque inscription est une demande d'accès** (parcours prospect → facture
  proforma → décision). Tant que teeBo n'a pas approuvé, aucune donnée métier
  n'est accessible dans l'espace IMF.
- La **console teeBo** (compte éditeur) permet d'approuver, rejeter, suspendre,
  prolonger l'essai (30 jours) et régénérer les codes d'accès, IMF par IMF.
- Le module Gouvernance est **réservé aux institutions** : le compte éditeur
  n'y entre pas (il est redirigé vers sa propre console).

---

## 2. Les six registres

| Registre | À quoi il sert |
|---|---|
| **Fiche institution** | Raison sociale, forme juridique, RCCM, IFU/NIF, agrément BCEAO, capital, siège, PCA, DG, nombre d'administrateurs, dates d'assemblée générale |
| **Organes** | Conseil d'Administration, Comité d'Audit, Comité des Risques, Comité de Crédit, Comité ALM, Assemblée Générale, Direction Générale — avec quorum et fréquence |
| **Membres** | Administrateurs, DG, DGA, membres de comités, commissaire aux comptes : qualité, sexe, diplôme, expérience, casier judiciaire |
| **Mandats** | Dates de début et de fin, acte de nomination, numéro de renouvellement, statut (en cours / expiré), contrôle du cumul |
| **Sessions & PV** | Ordre du jour, présents, quorum, référence du PV ; la signature scelle le PV par une empreinte numérique et le verrouille |
| **Résolutions** | Décisions et recommandations : responsable, échéance, avancement, priorité, statut |

---

## 3. Ce qui se remplit tout seul (aucune ressaisie)

| Champ | Provenance automatique |
|---|---|
| Raison sociale | Nom de l'IMF |
| Forme juridique | Type d'IMF (SA → SA, coopérative → COOPERATIVE) |
| RCCM, IFU/NIF, adresse légale | Paramètres légaux déjà saisis |
| N° d'agrément BCEAO | Fiche de l'IMF |
| Capital social | Capital déclaré de l'IMF (montant en FCFA) |
| Siège, ville, pays, téléphone, e-mail | Fiche de l'IMF |
| Président du CA | Compte dont le poste est « Président du Conseil d'Administration » |
| Directeur Général | Compte dont le poste est « Directeur Général » |
| Nombre d'administrateurs / dont femmes | Compté dans les membres actifs |
| Nom, fonction, téléphone, e-mail d'un membre | Compte d'accès sélectionné |
| Quorum d'une session | Quorum de l'organe choisi, comparé au nombre de présents |
| Statut d'un mandat | Date de fin dépassée → « expiré » |
| Numéro de renouvellement | Nombre de mandats déjà enregistrés pour la personne |
| Statut d'une résolution | Échéance dépassée et non réalisée → « en retard » |
| Alerte casier judiciaire | Date de casier absente ou de plus de 90 jours |

> Les valeurs reprises restent **modifiables** : l'agent vérifie, corrige si
> besoin, puis enregistre une seule fois.

---

## 4. Le score de conformité

Le tableau de bord calcule un score sur 100 et liste les écarts :

- organe obligatoire non créé → 6 points ;
- quorum non atteint sur une session → 10 points ;
- PV non signé d'une session passée → 6 points ;
- casier judiciaire à fournir ou périmé (> 90 jours) → 3 points ;
- mandat expiré non renouvelé → 6 points ;
- cumul de mandats d'administrateur ≥ 3 → 3 points ;
- résolution en retard → 6 points ;
- fiche institution incomplète → 6 points.

**100 = aucune anomalie.** Le score se met à jour à chaque correction.

---

## 5. Exporter le tableau de bord en PDF

1. Ouvrez **Gouvernance & conformité** dans le menu de gauche.
2. Cliquez sur **Exporter en PDF** (bouton en haut à droite).
3. Le rapport s'ouvre dans un nouvel onglet, déjà mis en page en A4 avec
   l'identité de votre IMF : synthèse, organes, membres, mandats, sessions et
   résolutions.
4. Dans la fenêtre d'impression, choisissez **Enregistrer au format PDF**.

Pour une version imprimée, le bouton d'impression du navigateur suffit : le
format A4 et les marges sont déjà prévus par la feuille de style.

---

## 6. Séparation stricte des tâches (anti-fraude)

- La consultation est ouverte aux postes habilités ; la **modification** est
  réservée à l'administrateur de l'IMF et à la direction.
- Le PCA est un organe de **contrôle** : il ne valide aucune opération de caisse
  et n'a aucun droit de saisie comptable.
- Un **PV signé ne peut plus être modifié** : la tentative est refusée avec un
  message explicite. Seule une opération volontaire de déverrouillage, réalisée
  par la direction, est possible — elle laisse une trace.
- Toute action sensible alimente le journal d'audit immuable.

---

## 7. Redéploiement (procédure numérotée)

1. Ouvrez le service backend sur Render.
2. Déployez le zip `imf-saas-fullstack.zip` (Build : `npm install`, Start : `npm start`).
3. Vérifiez que les variables d'environnement sont intactes (`DATABASE_URL`,
   `JWT_SECRET`, `COOKIE_SECRET`).
4. Attendez le message de fin de migration : la vague 27 crée les six tables
   de gouvernance. La migration est rejouable sans risque.
5. Si vous voyez une erreur SQL, copiez la ligne complète : elle indique le
   fichier et la requête concernés.
6. Côté Netlify, redéployez `imf-saas-netlify.zip`.
7. Rechargez l'application avec **Ctrl + Maj + R** (le cache de l'application
   est renouvelé automatiquement à chaque version).
8. Ouvrez **Gouvernance & conformité** : le tableau de bord doit s'afficher.
9. Cliquez sur **Organes → Générer les organes de base** pour partir d'une base
   complète, puis complétez la fiche institution.

### Si une erreur réapparaît

- **Table déjà existante** : normal, la migration est additive (`IF NOT EXISTS`).
- **Colonne manquante sur une table ancienne** : signalez-la avec le message
  exact ; le correctif est ajouté dans une vague suivante, jamais dans la même.
- **Écran vide après déploiement** : rechargez avec **Ctrl + Maj + R**, puis
  vérifiez que vous êtes bien connecté à une IMF (et non au compte éditeur).
