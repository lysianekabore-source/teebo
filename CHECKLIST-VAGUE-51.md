# Vague 51 — contrôle avant livraison

## Ce qui a été ajouté

| # | Élément | Preuve |
|---|---|---|
| 1 | Test de non-régression **Personnel & Habilitations** : création d'un agent, code d'accès, modification, rattachement, renvoi / régénération du code, droits par poste et par personne, refus propres, cloisonnement, refus 403 d'un agent, nettoyage. | `test/personnel.test.mjs` |
| 2 | Le script couvre aussi les règles de blocage de la création : nom / e-mail manquant, e-mail invalide, poste inexistant, agent de collecte sans responsable ou avec un responsable non habilité, auto-supervision. | idem, section 3 |
| 3 | Vérification qu'un agent ordinaire ne reçoit jamais les droits de gestion de l'administrateur (personnel, droits, structure, paramètres). | idem, section 4 |
| 4 | Tout ce qui est créé est supprimé et tout ce qui est modifié est remis en état, **même en cas d'échec**. | idem, `nettoyer()` / `restaurer()` |

Aucune règle métier du serveur n'a été modifiée dans cette vague : il s'agit d'un
outil de contrôle. Les comportements vérifiés sont ceux livrés en vagues 47 à 50.

## Comment lancer le test

```
TEEBO_URL=https://<serveur> IMF_EMAIL=... IMF_PASSWORD='...' node test/personnel.test.mjs
```

Options utiles :

- `--sans-ecriture` : lectures et refus seulement, aucune création (utile en production
  si l'on veut un contrôle sans trace).
- `STAFF_EMAIL` / `STAFF_PASSWORD` : compte d'un agent ordinaire, pour vérifier que la
  création de personnel et la modification des droits lui sont refusées (403).
- `POSTE_TEST` : imposer le code du poste utilisé pour l'agent de test.

Attendu : `0 en echec` et code de sortie `0`. En cas d'écart, le script liste
précisément les points à traiter.

## Contrôles à passer après déploiement

1. Ouvrir le site, attendre le réveil du service (offre gratuite Render), puis :
   `curl https://<serveur>/healthz` → `200`.
2. `curl https://<serveur>/ready` → `pret: true` et aucune table manquante.
3. Se connecter à l'espace IMF, ouvrir **Personnel** : la liste s'affiche avec le code
   d'accès de chaque agent.
4. Créer un agent de test à la main : le code d'accès s'affiche à l'écran, l'agent
   apparaît dans la liste.
5. Ouvrir **Habilitations** : décocher un droit, recharger, le droit reste décoché ;
   recocher. Le réglage doit être conservé.
6. Lancer la non-régression Personnel & Habilitations (commande ci-dessus).
7. Vérifier l'absence de résidu :
   ```sql
   SELECT count(*) FROM app_user        WHERE full_name LIKE '[TEST-TECHNIQUE]%';
   SELECT count(*) FROM org_unit        WHERE name      LIKE '[TEST-TECHNIQUE]%';
   ```
   Les deux compteurs doivent être à 0.
8. Après déploiement du site : **Ctrl + Maj + R** sur chaque poste (le service worker
   conserve l'ancienne version en cache).
