# teebo — Vague 50

## 1. Correctif : la chaîne d'accès d'une nouvelle IMF est complète

**Symptôme.** Une demande d'accès déposée depuis le site pouvait être approuvée par
l'éditeur alors qu'aucun compte n'existait pour cette institution : le premier
administrateur n'avait donc ni identifiant ni code, et personne ne pouvait se
connecter.

**Correction.** L'approbation d'une demande (`POST /api/v1/teebo/requests/:id/approve`)
crée désormais, dans la même transaction :

1. le compte **administrateur de l'IMF** (`admin_imf`, poste « Administrateur IMF »),
   avec l'e-mail, le nom et le téléphone saisis dans le formulaire de demande ;
2. son **code d'accès** (`TBO-CC-NNNNNN-U00001`), attribué par la base ;
3. la **structure organisationnelle de départ** (direction, départements, services) ;
4. la **transmission du code** par WhatsApp et/ou e-mail, avec le lien de connexion
   `https://teebo-imf.netlify.app/login`.

Le mot de passe n'est jamais créé par l'éditeur : le titulaire le crée lui-même au
premier accès, puis active la double authentification.

**Réponse** : le compte administrateur créé, son code, le résultat de l'envoi et un
message en français expliquant la suite. Si un compte administrateur existait déjà,
il est réactivé et son code reste valable (message dédié, pas de doublon).

## 2. Nouveau : test de non-régression du module Gouvernance

`test/governance.test.mjs` — aucune bibliothèque à installer (Node 18+).

```
TEEBO_URL=https://teebo-api-p825.onrender.com \
IMF_EMAIL=admin@mon-imf.bf IMF_PASSWORD='...' \
node test/governance.test.mjs
```

Il vérifie : les 12 écrans de lecture (aucun 500), le rapport PDF, le cloisonnement
(un identifiant inconnu ou appartenant à une autre IMF est toujours refusé en 404),
le refus d'écriture pour un compte sans habilitation (403), puis le cycle complet
création → modification → suppression sur un organe, un membre, un mandat, une
session, une résolution et un détenteur de capital. Tout ce qui est créé porte le
préfixe `[TEST-TECHNIQUE]` et est supprimé à la fin.

Option `--sans-ecriture` : lectures et refus seulement, aucune création.

## 3. Procédure de l'administrateur IMF

`PROCEDURE-ADMIN-IMF.md` à la racine du serveur : le parcours quotidien complet
(demande d'accès, réception du code, première connexion, création de l'organisation,
ajout du personnel, habilitations, travail courant, dépannage).
