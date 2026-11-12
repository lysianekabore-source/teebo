
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
