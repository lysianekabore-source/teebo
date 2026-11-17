# Procédure de l'administrateur d'une IMF

Ce guide décrit, pas à pas, tout ce que fait l'administrateur d'une institution de
microfinance (IMF) sur teebo : de la demande d'accès jusqu'au travail quotidien de
ses équipes.

**Adresse de connexion : https://teebo-imf.netlify.app/login**

> Vous n'avez jamais à créer de mot de passe à la place d'un collaborateur, et vous
> ne le connaissez jamais. Vous diffusez un **code d'accès** ; la personne crée
> elle-même son mot de passe et active sa double authentification.

---

## Étape 1 — Demander l'accès pour l'IMF

1. Ouvrez le site teebo et cliquez sur **Demander un accès**.
2. Renseignez l'identité de l'institution : nom, forme juridique (SA / SCOOP),
   pays de l'UEMOA, ville, capital social, numéro d'agrément BCEAO, RCCM, IFU,
   téléphone, WhatsApp et e-mail de l'IMF.
3. Renseignez le **futur administrateur** : nom complet, fonction, e-mail et
   téléphone. C'est à cette adresse que le code d'accès sera transmis.
4. Choisissez les **modules** dont vous avez besoin (ou le pack complet) et le
   cycle de facturation (mensuel ou annuel).
5. Une **facture proforma** s'affiche : vérifiez les montants puis validez-la.
   La demande part alors chez teeBo.

*À savoir :* un même e-mail ou un même numéro d'agrément ne peut pas déposer deux
fois une demande. Une demande rejetée peut être redéposée.

---

## Étape 2 — Recevoir le code d'accès

1. teeBo étudie la demande, puis l'**approuve** : l'institution passe en **essai
gratuit de 30 jours**.
2. À l'approbation, **le compte administrateur est créé automatiquement** et son
   code d'accès (`TBO-CC-NNNNNN-U00001`) vous est envoyé par **WhatsApp** et/ou
   **e-mail**, avec le lien de connexion.
3. Si vous ne recevez rien : demandez à teeBo de **renvoyer le code** (console
   éditeur → *Codes d'accès* → *Renvoyer*). L'ancien code reste valable tant
   qu'il n'est pas régénéré.

---

## Étape 3 — Première connexion

1. Ouvrez **https://teebo-imf.netlify.app/login**.
2. Saisissez votre **code d'accès** (ou votre e-mail) puis votre mot de passe.
   *Première fois* : le mot de passe n'existe pas encore.
3. **Créez votre mot de passe** (12 caractères ou plus, avec majuscules, minuscules,
   chiffres et symboles). Il vous sera demandé de le changer tous les 90 jours.
4. **Activez la double authentification** : installez une application
d'authentification (Google Authenticator, Microsoft Authenticator, FreeOTP…),
   scannez le QR code affiché, puis saisissez le code à 6 chiffres pour confirmer.
   Cette étape est obligatoire pour les profils de direction.
5. Vous arrivez sur le **tableau de bord de votre institution**.

---

## Étape 4 — Compléter les paramètres de l'institution

Menu **Paramètres** :

- **Identité visuelle** : logo, couleurs, nom légal, formule d'appel.
- **Mentions légales** : RCCM, IFU, agrément BCEAO, capital, adresse — elles
  apparaissent telles quelles sur les factures et relevés remis aux clients.
- **Coordonnées d'envoi** : numéro WhatsApp et adresse e-mail qui signeront les
  messages envoyés à vos collaborateurs (bouton **Envoyer un e-mail de test** pour
  vérifier la chaîne).

---

## Étape 5 — Construire l'organisation

Menu **Structure / Organisation** :

1. La structure de départ (Direction Générale, départements, services) est déjà en
   place. Renommez-la si besoin : *Modifier* sur chaque unité.
2. Ajoutez vos **agences** : *Nouvelle unité* → type **Agence** → nom et ville.
3. La hiérarchie est contrôlée : une agence ne se rattache pas à un département,
   un service se rattache à un département, etc. Le code de l'unité est attribué
   automatiquement (DIR / DEP / SRV / AGC).

---

## Étape 6 — Ajouter le personnel

Menu **Personnel / Utilisateurs** → **Nouvel utilisateur** :

1. Renseignez nom complet, e-mail et téléphone.
2. Choisissez le **poste** : c'est lui qui détermine le rôle et les habilitations
   par défaut (Directeur d'agence, Agent de crédit, Caissier, Agent de collecte…).
3. Rattachez la personne à son **unité** (agence, service, département).
4. Pour un **agent de collecte**, indiquez obligatoirement un **superviseur**
   (chef d'agence ou agent de crédit habilité à superviser la collecte).
5. Enregistrez : le **code d'accès** est généré et envoyé automatiquement. Un
   bandeau affiche les liens **WhatsApp** / **e-mail** prêts à cliquer si l'envoi
   automatique n'est pas configuré.
6. Le collaborateur se connecte, crée son mot de passe et active sa double
   authentification, comme à l'étape 3.

---

## Étape 7 — Ajuster les habilitations

Menu **Habilitations** :

- **Par poste** : cochez/décochez les droits communs à tous les titulaires d'un
  poste (ex. « Agent de crédit » → *clients.read*, *credit.create* mais pas
  *credit.validate_final*).
- **Par personne** : la surcharge individuelle est prioritaire sur le poste. Elle
  sert aux exceptions (remplacement, mission ponctuelle).
- **Règles de sécurité** : un profil de surveillance (Direction, PCA) ne peut
  jamais recevoir la gestion du personnel, de la structure, des paramètres ni de
  la matrice des droits. Un agent ordinaire ne reçoit jamais les droits de
  l'administrateur : chaque compte a exactement les droits de son poste.
- Vérifiez le résultat avec **Profil de l'utilisateur** → *Habilitations effectives*.

---

## Étape 8 — Travailler au quotidien

| Besoin | Où |
|---|---|
| Ouvrir / fermer l'accès d'un collaborateur | Personnel → bouton *Accès* |
| Régénérer un code perdu (départ, suspicion) | Personnel → *Régénérer le code* |
| Renvoyer le code par WhatsApp / e-mail | Personnel → *Renvoyer le code* |
| Suivre les envois de codes | Personnel → *Journal des envois* |
| Vérifier qui a fait quoi | **Journal d'audit** |
| Voir les modules souscrits et les factures | **Abonnement** |

**Règles à connaître :**

- Un code régénéré **ferme immédiatement** les sessions ouvertes et remet le mot de
  passe « à créer » : la personne repasse par l'étape 3.
- Fermer l'accès d'un utilisateur ne supprime aucune donnée : il ne peut simplement
  plus se connecter.
- Chaque écriture (création, modification, suppression) est tracée avec l'auteur et
  la date.

---

## Dépannage rapide

| Message / situation | Que faire |
|---|---|
| « Identifiants invalides » | Vérifiez le code (majuscules, sans espace). Sinon, *Renvoyer le code*. |
| « Vous devez d'abord changer votre mot de passe » | C'est normal après une régénération : créez le nouveau mot de passe. |
| « Double authentification obligatoire » | Installez une application d'authentification puis enrôlez le compte. |
| « Vous ne disposez pas de cette habilitation » | Le poste ou la personne n'a pas le droit : ajustez à l'étape 7. |
| Le code n'arrive pas | Vérifiez WhatsApp/e-mail de la fiche, puis utilisez les liens manuels. |
| Une page affiche encore l'ancienne version | Ctrl + Maj + R (ou vider le cache du navigateur). |

---

## En cas de besoin

Contactez teeBo depuis le site. Précisez le **code de l'institution**
(`TBO-CC-NNNNNN`) et, si possible, le **code du compte** concerné
(`TBO-CC-NNNNNN-U00001`) : le support retrouve ainsi immédiatement le dossier.
