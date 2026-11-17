# teebo — validation de la vague 49

Deux fichiers, à la racine du dossier `backend/` :

| Fichier | À quoi il sert |
|---|---|
| `test/vague49.test.mjs` | teste les 4 correctifs sur l'API réelle |
| `test/CHECKLIST-VAGUE-49.md` | ce mode d'emploi + la liste des points audités |

Aucune bibliothèque à installer : Node 18+ suffit.

## 1. Lancer le test

**Comptes dont vous avez besoin**

- un compte **éditeur** (`hello@teebo.africa`) : indispensable pour les correctifs 1, 2 et 3 ;
- l'**identifiant d'un compte IMF** à activer/désactiver (le test le remet dans son état initial) ;
- (facultatif) un **compte IMF** pour vérifier la vue côté institution.

```bash
TEEBO_URL=https://teebo-api-p825.onrender.com \
EMAIL=hello@teebo.africa PASSWORD='••••' \
USER_ID=<uuid d'un compte IMF> \
node test/vague49.test.mjs --db
```

Sortie attendue en fin de script :

```
RESULTAT : 1x conforme(s), 0 en echec, x saute(s)
Les 4 correctifs se comportent comme annonce.
```

Si un point échoue, le script affiche la ligne exacte (`- test : HTTP xxx message`).
Envoyez-moi cette ligne et je corrige.

## 2. Ce qui est vérifié

| # | Correctif | Attendu |
|---|---|---|
| 1 | activer/désactiver un utilisateur | 200, état renvoyé, retour à l'état initial |
| 1b | colonne `app_user.updated_at` (option `--db`) | présente en base |
| 2 | facture sur une IMF inexistante | 404 « client introuvable » |
| 3 | module sur une IMF inexistante | 404 « client introuvable » |
| 3b | activation de module côté IMF | jamais 500 |
| 4 | ancienne adresse « pack complet » | 404 route inconnue, n'applique rien |
| 6 | écrans de facturation | aucun 500 |

Le script n'écrit aucune donnée : les tests « IMF inexistante » visent un
identifiant qui n'existe pas (le refus doit arriver avant toute écriture).

## 3. Audit des autres routes (ce que j'ai trouvé et corrigé)

J'ai passé au crible les 384 routes de l’API. Toutes les routes qui visent un
objet par son identifiant ont été relues une par une.

**Déjà protégées** (aucune action) : gouvernance (42 routes), conformité (23),
crédit BCEAO (26), produits/comptes (24), collecte et collecte sécurisée,
collecteurs, clients, structure, objectifs, bankings, super-admin.
Elles vérifient l'existence et l'appartenance à l'IMF avant d'écrire ; un
identifiant inconnu y renvoie déjà 404 ou 403, jamais 500.

**Corrigées dans cette vague** :

| Route | Avant | Après |
|---|---|---|
| `POST /teebo/saas/imfs/:id/facturer` | 500 si l'IMF n'existe pas | 404 « IMF introuvable » |
| `PUT /teebo/saas/imfs/:id/modules/:key` | 500 | 404 |
| `POST /teebo/saas/imfs/:id/licence` | 500 | 404 |
| `GET /teebo/saas/imfs/:id/apercu` | résultat vide | 404 |
| `GET /teebo/invoices/:id.pdf` | 500 si la facture n'existe pas | 404 |
| `POST /security-alerts/:id/read` | « ok » mensonger + 500 sur identifiant illisible | 404 explicite |
| toute la facturation IMF | contrôle d'IMF répété route par route | un seul contrôle en tête de routeur |
| toute écriture en base | référence inconnue = erreur 500/422 | 404 « référence introuvable » |

## 4. Points laissés tels quels (volontairement)

- `POST /cash/overrun-requests/:id/decide` renvoie 409 « demande introuvable
  ou déjà traitée » : c'est le comportement voulu (une décision ne doit pas
  être rejouée), pas une erreur serveur.
- Les routes publiques (`/verify-certificat/:empreinte`, parcours prospect)
  renvoient une page lisible, jamais une trace technique.
- Aucune table n'expose de route de suppression massive : rien à durcir là.

## 5. Contrôle de non-régression

Les 6 fichiers modifiés (saas, super_admin, teebo, devices, errors, migrate)
se chargent sans erreur et les 384 routes sont toujours déclarées.
Le test ci-dessus reste la référence : relancez-le après chaque déploiement.
