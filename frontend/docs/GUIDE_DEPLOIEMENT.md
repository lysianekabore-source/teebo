# Guide de déploiement teebo — pas à pas

Ce guide s'adresse à un profil **non technique**. Suivez les étapes dans l'ordre.
Durée estimée : 20 à 30 minutes la première fois.

---

## Ce dont vous avez besoin

- Un ordinateur avec **Node.js 20** installé.
- **PostgreSQL** (base de données) installé, ou un service PostgreSQL en ligne.
- Le fichier **teebo-plateforme.zip** (fourni).
- Un dossier de travail vide (ex. « teebo ») sur votre ordinateur.

---

## ÉTAPE 1 — Récupérer et décompresser les fichiers

1. Téléchargez **teebo-plateforme.zip**.
2. Clic droit sur le fichier → **Extraire tout…** (Windows) ou double-clic (Mac).
3. Vous obtenez un dossier nommé **teebo** contenant `backend`, `frontend`, `db`,
   ainsi que les fichiers `.md` (documentation).
4. Ouvrez un terminal (invité de commandes) **dans ce dossier**.

---

## ÉTAPE 2 — Créer la base de données

1. Assurez-vous que PostgreSQL est démarré.
2. Créez une base nommée `teebo` :
   - En ligne de commande : `createdb teebo`
   - OU via l'interface graphique pgAdmin : clic droit sur « Databases » →
     **Create** → **Database…** → nom `teebo` → **Save**.
3. Appliquez les schémas.

   **Méthode recommandée (automatique) :** vous n'avez rien à copier à la main.
   La commande `npm run migrate` de l'ÉTAPE 4 applique **tous** les schémas
   dans le bon ordre (`schema.sql`, puis `schema_v3.sql` → `schema_v9.sql`).

   **Méthode manuelle (pgAdmin), si vous y tenez :** ouvrez pgAdmin → clic droit
   sur la base `teebo` → **Query Tool**, puis copiez-collez et exécutez (**Run**,
   F5) le contenu de chaque fichier **dans cet ordre** :
   `schema.sql`, `schema_v3.sql`, `schema_v4.sql`, `schema_v5.sql`,
   `schema_v6.sql`, `schema_v7.sql`, `schema_v8.sql`, `schema_v9.sql`.
   Le schéma `schema_v9.sql` ajoute le socle KYC BCEAO (état civil, pièce
   d'identité, profession, origine des fonds, PPE, bénéficiaire effectif) et la
   suppression d'IMF (archivage/purge + journal d'audit).

> Astuce : les schémas sont **idempotents** — les relancer est sans danger.

---

## ÉTAPE 3 — Configurer l'application

1. Dans le dossier `backend`, copiez le fichier `.env.example` et renommez la
   copie en **`.env`**.
2. Ouvrez `.env` dans un éditeur de texte et renseignez :
   - `DATABASE_URL` : l'adresse de votre base, ex.
     `postgres://utilisateur:motdepasse@127.0.0.1:5432/teebo`
   - `TEEBO_ADMIN_EMAIL` : l'e-mail de l'administrateur éditeur teebo.
   - `TEEBO_ADMIN_PASSWORD` : un mot de passe **fort** (changez-le !).
   - `PORT` : `3000` (par défaut).
3. Enregistrez le fichier.

---

## ÉTAPE 4 — Installer et initialiser

Dans le terminal, placez-vous dans `backend` puis lancez, l'un après l'autre :

1. `npm install` → installe les dépendances (patientez).
2. `npm run migrate` → crée l'administrateur éditeur teebo dans la base.
   Le terminal affiche « Admin teebo créé » avec son code d'accès.

---

## ÉTAPE 4 bis — Valider les migrations sur votre vraie base (recommandé)

Cette étape vérifie, **sur votre serveur PostgreSQL réel**, que tous les objets
de facturation (tables, déclencheurs d'audit, numérotation des factures,
TVA configurable par IMF) sont bien en place et se comportent correctement.

1. Placez-vous dans le dossier `backend`.
2. Assurez-vous que `DATABASE_URL` est renseigné (voir ÉTAPE 3).
3. Lancez : `npm run test:migrations`
4. Le test affiche une liste de contrôles `✓` puis
   `RÉSULTAT : N réussis / 0 échec(s)`.

> **Aucun risque pour vos données.** Toutes les écritures du test se font dans
> une transaction annulée automatiquement (`ROLLBACK`) : la base, y compris le
> compteur de factures, reste **strictement inchangée**. Le test peut être
> rejoué autant de fois que nécessaire, même sur une base déjà en production.

Messages possibles :

| Message | Signification | Action |
|---|---|---|
| `DATABASE_URL non défini` | adresse de la base absente | renseignez `DATABASE_URL` (ÉTAPE 3) |
| `Le paquet « pg » n'est pas installé` | dépendances non installées | relancez `npm install` (ÉTAPE 4) |
| `0 échec(s)` | tout est conforme | vous pouvez déployer |
| au moins un `✗` | un objet manque | rejouez l'ÉTAPE 2 (schémas) puis relancez |

---

## ÉTAPE 5 — Démarrer la plateforme

1. Dans `backend`, lancez : `node src/server.js`
2. Le message `teebo API … http://127.0.0.1:3000` confirme le démarrage.
3. Ouvrez votre navigateur sur le fichier `frontend/login.html`
   (ou servez le dossier `frontend`).
4. Connectez-vous avec les accès de `ACCES_TEEBO.md`.

---

## ÉTAPE 6 — Vérifier que tout fonctionne

1. Connectez-vous en tant qu'**administrateur éditeur teebo**
   (`hello@teebo.africa`) → la console teebo s'ouvre.
2. Déconnectez-vous, puis connectez-vous en **administrateur IMF**
   (`direction@imf-obj.bf`) → l'espace IMF s'ouvre.
3. Ouvrez le module **Objectifs** : la liste des cibles s'affiche.
4. Test express : créez une cible, puis vérifiez le tableau de bord.

### Vérifier la prévisualisation de facture (module Paramètres IMF)

1. Connecté en **administrateur IMF**, ouvrez le module **Paramètres**.
2. Renseignez les mentions légales et, si applicable, le taux de **TVA**
   (laissé vide = TVA non applicable ; aucun taux n'est imposé par défaut).
3. Cliquez sur **Aperçu de la facture** : le PDF de facture s'affiche
   dynamiquement dans la page, avec le logo, les mentions légales et le calcul
   HT + TVA à jour selon vos paramètres.
4. Modifiez un paramètre (ex. le taux de TVA) puis relancez l'aperçu :
   le document se régénère immédiatement avec les nouvelles valeurs.

Si une page reste blanche : videz le cache du navigateur (Ctrl+Shift+R).

### Vérifier les nouvelles fonctionnalités (suppression d'IMF + enrôlement KYC)

1. **Suppression d'une IMF (super-admin teebo)** : connecté en administrateur
   éditeur teebo, ouvrez le module **Institutions**. Chaque ligne propose un
   bouton rouge **Supprimer**. Il ouvre une fenêtre de confirmation où vous
   choisissez **Archiver** (masquer sans effacer) ou **Supprimer
   définitivement** (purge en cascade), puis vous devez **ressaisir le code de
   l'IMF** pour confirmer. Le tenant système teebo (`TBO-SYS-000000`) est
   protégé et ne peut pas être supprimé.
2. **Nouveau client KYC BCEAO (collectrice)** : ouvrez l'application terrain,
   connectez-vous en collectrice, puis **Nouveau client (KYC BCEAO)**. Le
   formulaire reprend le socle d'identité BCEAO (état civil, pièce d'identité,
   profession, origine des fonds, PPE, bénéficiaire effectif). La position GPS
   du lieu est capturée automatiquement : le client doit être enregistré chez
   lui.
3. **Espace client pour tout client** : dans l'application terrain, **Créer un
   espace client** permet désormais de **rechercher un client existant** puis de
   lui ouvrir un accès en ligne (mode de connexion + format de relevé).

> Un guide de vérification détaillé en local est fourni :
> **`VERIFIER_FONCTIONNALITES_LOCAL.md`**.

---

## ÉTAPE 7 — Mise en production (recommandé)

1. **HTTPS** : servez l'application derrière un certificat SSL (Let's Encrypt).
2. **CORS** : dans `.env`, remplacez `CORS_ORIGIN=true` par votre domaine réel.
3. **Mots de passe** : changez tous les mots de passe de démonstration.
4. **2FA** : activez la double authentification pour tous les comptes à privilèges.
5. **Sauvegardes** : planifiez une sauvegarde quotidienne de la base PostgreSQL.
6. **Processus** : utilisez un gestionnaire de service (systemd, PM2,
   Docker) pour que l'API redémarre automatiquement après un redémarrage.

---

## En cas de problème

| Symptôme | Cause probable | Solution |
|---|---|---|
| « ECONNREFUSED » au démarrage | PostgreSQL arrêté | Démarrez PostgreSQL |
| « password authentication failed » | Mauvais `DATABASE_URL` | Corrigez le mot de passe dans `.env` |
| Page blanche dans le navigateur | Cache navigateur | Ctrl+Shift+R (rechargement forcé) |
| « relation … does not exist » | Schémas non appliqués | Rejouez l'ÉTAPE 2 |
| `npm run test:migrations` échoue sur un objet | Schémas incomplets | Rejouez l'ÉTAPE 2 puis relancez l'ÉTAPE 4 bis |
| L'aperçu de facture reste vide | Paramètres IMF incomplets | Renseignez les mentions légales (module Paramètres) |
| `ENOENT ... /app/frontend/index.html` (Render) | le dossier `frontend` n'était pas copié dans l'image | corrigé : le `Dockerfile` copie désormais `frontend` ; **re-déployez** (Manual Deploy > Clear build cache & deploy) |
| Impossible de se connecter après le mot de passe | enrôlement 2FA obligatoire à terminer | suivez l'écran « Activer la double authentification » (scan du QR + code à 6 chiffres) |

---

## Première connexion : double authentification (2FA)

La double authentification (code à 6 chiffres) est **obligatoire pour tous les
comptes**. À la toute première connexion, après avoir saisi l'identifiant et le
mot de passe, l'écran d'**enrôlement** s'affiche automatiquement :

1. Ouvrez une application d'authentification (Google Authenticator, Authy,
   FreeOTP…) sur votre téléphone.
2. **Scannez le QR code** affiché (ou saisissez la clé proposée manuellement).
3. Saisissez le **code à 6 chiffres** généré par l'application, puis validez.
4. **Notez vos codes de secours** (affichés une seule fois) : ils dépannent en
   cas de perte du téléphone. Vous êtes ensuite connecté directement.

Aux connexions suivantes, il suffira de saisir le code à 6 chiffres après le
mot de passe. Le QR code est généré **localement** par le serveur (image
`data:` intégrée) : aucun appel à un service externe, conforme à la politique
de sécurité (CSP) stricte.
| Accès refusé (403) sur une action | Profil non autorisé | Vérifiez `MATRICE_HABILITATIONS.md` |

---

## Activer l'envoi AUTOMATIQUE des codes (WhatsApp + e-mail)

Par défaut, l'application n'envoie PAS les codes toute seule : elle ouvre un
message pré-rempli (WhatsApp / messagerie) que l'administrateur n'a plus qu'à
envoyer. C'est le mode « manuel », il fonctionne sans aucune configuration.

Pour un envoi 100 % automatique (sans clic), il faut fournir à Render les accès
aux passerelles externes, puis redéployer le serveur :

**WhatsApp (API WhatsApp Business Cloud de Meta)**
- `WHATSAPP_TOKEN` : jeton d'accès permanent de l'app Meta
- `WHATSAPP_PHONE_ID` : identifiant du numéro expéditeur

**E-mail (SMTP de votre fournisseur : Gmail pro, OVH, votre domaine…)**
- `SMTP_HOST` (ex. `smtp.gmail.com`), `SMTP_PORT` (`587`)
- `SMTP_USER`, `SMTP_PASS` (mot de passe d'application)
- `SMTP_FROM` (ex. `teebo <no-reply@votre-domaine.com>`)

**Expéditeur vu par le destinataire.** L'adresse affichée dans la boîte de
l'agent est celle saisie dans « Paramètres IMF → Envoi des codes d'accès →
E-mail expéditeur » (repli : adresse officielle de l'IMF, puis `SMTP_FROM`).
Le compte technique `SMTP_USER` reste l'enveloppe d'envoi, mais l'en-tête
expéditeur et le « répondre à » portent l'adresse de l'IMF : les réponses
reviennent donc à l'institution.

Important : l'adresse expéditrice doit être **autorisée par votre fournisseur
d'e-mail** (adresse du même domaine que `SMTP_USER`, ou expédition vérifiée
chez OVH/Gmail/Google Workspace/Brevo…). Sinon le fournisseur refuse l'envoi
(erreur « sender not allowed » / SPF-DKIM) — le test intégré le signale.

**Vérifier en une minute :** Paramètres IMF → bouton « Envoyer un e-mail de
test à moi-même ». Le verdict s'affiche immédiatement (envoyé, passerelle
absente, ou motif exact du refus).

Tant qu'une passerelle n'est pas renseignée, le canal correspondant reste en
mode manuel : la modale « Code d'accès prêt à envoyer » l'indique clairement
(« passerelle non configurée — envoi manuel ci-dessous ») et propose les
boutons WhatsApp / e-mail. Vous pouvez y saisir ou corriger le numéro WhatsApp
et l'e-mail du destinataire ; le contact est alors enregistré pour les envois
suivants.

**Alerte « agents sans responsable ».** L'onglet Personnel affiche un bandeau
en haut de liste recensant les utilisateurs sans responsable hiérarchique
(rouge pour les agents de collecte — cas bloquant —, orange pour les autres) ;
la case « Non défini » de la colonne Responsable et le bouton « Définir »
ouvrent directement la fenêtre de rattachement. Le tableau de bord reprend la
même alerte.

## Contacts

- WhatsApp : **+226 50 32 14 32** (wa.me/22650321432)
- E-mail : **hello@teebo.africa**
- « La finance à visage humain »


---

# Créer une agence de bout en bout

Objectif : ouvrir une nouvelle agence **complète et opérationnelle** : l'unité
dans l'arborescence, son chef, son équipe, leurs accès, et la vérification que
rien ne manque. Comptez 15 à 20 minutes. Suivez les étapes dans l'ordre.

**Qui peut faire quoi :** la structure et le personnel se gèrent avec un compte
Administrateur IMF (ou Direction Générale). Un Chef d'agence peut ensuite créer
son équipe, mais pas une autre agence.

---

## Étape 0 — Vérifier que la structure de base existe

1. Connectez-vous, puis ouvrez **Organisation** dans le menu de gauche.
2. Si l'arbre est vide, un bouton **« Générer la structure de base »** apparaît :
   cliquez dessus. Les Directions, Départements et Services du référentiel
   sont créés d'un coup (vous pourrez les renommer ou les supprimer).
3. Si l'arbre contient déjà vos directions, passez à l'étape suivante.

> À quoi ça sert : une agence est toujours rattachée à un **Service**, lui-même
> rattaché à un **Département**, lui-même rattaché à une **Direction**. Cette
> chaîne est ce qui permet au tableau de bord de consolider les chiffres par
> niveau (Direction Générale → Direction → Département → Service → Agence).

---

## Étape 1 — Vérifier les postes (une seule fois)

1. Toujours dans **Organisation**, ouvrez l'onglet des postes / rôles.
2. Vérifiez que les 42 postes du référentiel sont présents (Directeur Général,
   Directeur Général Adjoint, Chef d'Agence, Chef de Caisse, Caissier, Agent de
   collecte, etc.).
3. Si votre institution a un poste « maison », ajoutez-le : il apparaîtra dans
   la liste des postes au moment de créer un agent.

> Chaque poste connaît **d'avance son responsable hiérarchique** : Directeur
> Général → Président du Conseil d'Administration, Directeur Général Adjoint →
> Directeur Général, Chef de Caisse → Chef d'Agence, Caissier → Chef de Caisse,
> Agent de collecte → Chef d'Agence, etc. C'est ce qui pré-remplit les fiches à
> l'étape 3.

### Le sommet de l'organisation

L'ordre de création des comptes de direction est donc :

1. **Président du Conseil d'Administration** (aucun responsable au-dessus).
2. **Directeur Général** → responsable pré-rempli : Président du Conseil
   d'Administration.
3. **Directeur Général Adjoint** → Directeur Général.
4. Puis les directions (Crédit, Opérations, Finance, RH, Audit, Conformité,
   Système d'information) → Directeur Général.

> Le Président du Conseil d'Administration est un poste de **supervision** : il
> voit les rapports et l'arborescence, mais n'encaisse pas, ne valide pas la
> comptabilité et ne peut pas s'approprier une opération de caisse (séparation
> des tâches).

---

## Étape 2 — Créer l'unité « Agence »

1. Dans **Organisation**, cliquez sur **Nouvelle unité**.
2. **Rattachement** : choisissez le Service qui portera l'agence (par exemple
   le service « Réseau / Opérations »). Pour une agence rattachée directement à
   un Département, choisissez ce Département.
3. **Type d'unité** : le type est déjà verrouillé sur **Agence** (on ne peut pas
   créer une agence sous une agence).
4. **Nom** : par exemple « Agence de Bobo-Dioulasso ».
5. **Ville** : renseignez la ville (facultatif mais utile pour la recherche).
6. Cliquez sur **Créer**. Un message confirme la création avec le **code de
   l'unité** (généré automatiquement, par exemple `AGC-003`) : notez-le, il
   apparaît sur les rapports et dans la consolidation.

> Astuce : le bouton **+ Sous-unité** sur une ligne de l'arbre fait la même
> chose, avec le rattachement déjà rempli.

---

## Étape 3 — Créer le Chef d'agence

1. Ouvrez **Personnel** → **Nouvel utilisateur**.
2. **Nom complet** : le titulaire du poste.
3. **Poste occupé** : choisissez « Chef d'Agence ». Dès ce choix, deux champs se
   remplissent tout seuls :
   - **Superviseur / Responsable hiérarchique** → le **Directeur des Opérations
     / Réseau** s'il existe déjà dans votre Personnel ; sinon le message précise
     que ce poste n'est pas encore pourvu.
   - **Unité de rattachement** → l'agence correspondante quand elle est
     identifiable.
4. Vérifiez ou changez le responsable : la liste propose tous les agents, ceux
   qui ne peuvent pas encadrer sont grisés « (non habilité) ». **Le champ reste
   toujours modifiable** : vous pouvez choisir quelqu'un d'autre ou
   « — Aucun — ».
5. **Unité de rattachement** : sélectionnez l'agence créée à l'étape 2.
6. **E-mail** et **Téléphone (WhatsApp)** : indispensables, c'est là que partent
   le code d'accès et les notifications.
7. Cliquez sur **Créer et envoyer le code**. Le compte est créé « À créer » et le
   code d'accès part par e-mail (et WhatsApp si configuré).

> Si l'envoi échoue, la page **Suivi des envois** indique le motif exact (e-mail
> non configuré, adresse invalide…) et le bouton **Renvoyer le code** permet de
> réessayer, par e-mail ou par WhatsApp.

---

## Étape 4 — Créer l'équipe de l'agence

Répétez l'opération pour chaque poste de l'agence, dans cet ordre (du haut vers
le bas de la hiérarchie) :

1. **Chef de Caisse** → responsable pré-rempli : **Chef d'Agence**.
2. **Caissier / Guichetier** → responsable pré-rempli : **Chef de Caisse**
   (le Chef d'Agence reste proposé en second choix).
3. **Gestionnaire de clientèle** → responsable pré-rempli : **Chef d'Agence**.
4. **Agent de crédit** → responsable pré-rempli : **Chef d'Agence**.
5. **Agent de collecte** → responsable pré-rempli : **Chef d'Agence** (ou Agent
   de crédit). Pour ce poste le responsable est **obligatoire**.

Pour chacun : poste, nom, agence en unité de rattachement, e-mail, téléphone,
puis **Créer et envoyer le code**.

> Ordre important : créez toujours le responsable **avant** ses subordonnés.
> Si vous créez un caissier avant le Chef de Caisse, la fiche indique « ce poste
dépend du Chef de Caisse, qui n'est pas encore créé » ; vous rattacherez
> l'agent ensuite en un clic (bouton **Responsable** dans Personnel).

---

## Étape 5 — Vérifier les rattachements

1. Dans **Personnel**, la colonne **Responsable** doit afficher un nom pour
   chaque agent. Les lignes en **⚠ Non défini** indiquent en dessous à quel
   poste l'agent doit être rattaché.
2. Cliquez sur **⚠ Non défini** (ou sur le bouton **Responsable**) : la fiche
   s'ouvre avec le bon responsable déjà sélectionné. Cliquez sur
   **Enregistrer**.
3. Le tableau de bord affiche en haut un bandeau **⚠ N agents sans
   responsable** tant qu'il en reste : il disparaît quand tout est rattaché.
4. Contrôles appliqués automatiquement :
   - un agent ne peut **jamais** être son propre responsable ;
   - pas de boucle (A responsable de B et B responsable de A) ;
   - un agent de collecte n'accepte qu'un Chef d'agence ou un Agent de crédit.

---

## Étape 6 — Envoyer les accès et activer les comptes

1. Chaque agent reçoit son code par e-mail. Il se connecte sur la page de
   connexion, saisit son e-mail et le code, puis choisit son mot de passe.
2. Un compte encore marqué **À créer** dans Personnel n'a pas encore activé son
   accès : utilisez **Renvoyer le code** si le message s'est perdu.
3. Pour tester l'envoi d'e-mails depuis l'application, utilisez le bouton de
   **test d'envoi** dans les Paramètres : le résultat s'affiche immédiatement
   (envoyé / simulation / motif de l'échec).

---

## Étape 7 — Vérifier dans le pilotage

1. **Tableau de bord** : l'agence apparaît dans les unités, avec son code.
2. **Consolidation** : les chiffres de l'agence remontent au Service, au
   Département et à la Direction. Une agence sans activité apparaît à zéro,
   jamais absente.
3. **Rapport National (PDF)** : l'agence figure dans la liste des agences, avec
   son Chef d'agence.
4. **Habilitations** : vérifiez que le Chef d'agence n'a que les droits de son
   périmètre (il ne voit pas les autres agences, ne valide pas la comptabilité
   et ne peut pas s'auto-approuver une opération de caisse).

---

## Récapitulatif en une page

| # | Action | Où |
|---|--------|----|
| 0 | Générer/contrôler la structure de base | Organisation |
| 1 | Vérifier les 42 postes | Organisation |
| 2 | Créer l'unité Agence (rattachée au bon Service) | Organisation → Nouvelle unité |
| 3 | Créer le Chef d'agence (responsable pré-rempli) | Personnel → Nouvel utilisateur |
| 4 | Créer Chef de Caisse, Caissiers, Clientèle, Crédit, Collecte | Personnel |
| 5 | Corriger les « ⚠ Non défini » | Personnel → Responsable |
| 6 | Faire activer les comptes (codes d'accès) | Page de connexion |
| 7 | Contrôler dans Tableau de bord, Consolidation, Rapport National | Pilotage |

Ordre de création de l'équipe de direction (une seule fois, au démarrage) :
Président du Conseil d'Administration → Directeur Général → Directeur Général
Adjoint → Directeurs métiers.

---

## En cas de problème

- **« Aucune unité »** : l'institution n'a pas encore de structure → étape 0.
- **Le responsable n'apparaît pas dans la liste** : le titulaire du poste n'est
  pas encore créé (ou est inactif). Créez-le d'abord, puis revenez.
- **« Ce poste n'est pas encore pourvu »** : c'est une information, pas une
  erreur. Rien n'est enregistré tant que le responsable n'existe pas.
- **« Non habilité »** : cet agent n'est pas encadrant ; seuls les postes de
  management et les Agents de crédit peuvent superviser des agents de collecte.
- **Après une mise à jour** : rechargez la page avec **Ctrl + Maj + R** (ou
  videz le cache) pour que la nouvelle version de l'application soit prise en
  compte.
