# Vague 50 — contrôle avant livraison

## Ce qui a été corrigé

| # | Correctif | Preuve |
|---|---|---|
| 1 | L'approbation d'une demande d'accès crée le compte administrateur de l'IMF, lui attribue son code (`TBO-CC-NNNNNN-U00001`), matérialise la structure de départ et transmet le code par WhatsApp / e-mail avec le lien de connexion. | `src/routes/teebo.js` → `POST /teebo/requests/:id/approve` |
| 2 | Réponse d'approbation détaillée : compte créé ou déjà présent, code, résultat de l'envoi, message en français pour la suite. | idem |
| 3 | Un identifiant de demande illisible (pas un UUID) renvoie 404, plus jamais 500. | idem (`22P02`) |
| 4 | Test de non-régression du module Gouvernance (lectures, cloisonnement, refus 403, CRUD complet avec nettoyage). | `test/governance.test.mjs` |

## Contrôles à passer après déploiement

1. Ouvrir le site, attendre le réveil du service (offre gratuite Render), puis :
   `curl https://<serveur>/healthz` → `200`.
2. `curl https://<serveur>/ready` → `pret: true` et aucune table manquante.
3. Se connecter avec le compte éditeur, ouvrir **Demandes d'accès** :
   - une demande en attente affiche l'e-mail saisi par le prospect ;
   - bouton **Approuver** → le message confirme l'envoi du code et l'affiche.
4. Vérifier que le code se connecte : ouvrir `https://teebo-imf.netlify.app/login`,
   saisir le code + un mot de passe choisi → arrivée sur le tableau de bord.
5. Lancer la non-régression Gouvernance :
   ```
   TEEBO_URL=https://<serveur> IMF_EMAIL=... IMF_PASSWORD='...' node test/governance.test.mjs
   ```
   Attendu : `0 en echec`. Le nettoyage supprime tout ce qui a été créé.
6. Vérifier l'absence de résidu :
   ```sql
   SELECT count(*) FROM organes_gouvernance   WHERE libelle      LIKE '[TEST-TECHNIQUE]%';
   SELECT count(*) FROM membres_gouvernance   WHERE nom_complet  LIKE '[TEST-TECHNIQUE]%';
   SELECT count(*) FROM sessions_et_pv        WHERE numero_session LIKE '[TEST-TECHNIQUE]%';
   SELECT count(*) FROM resolutions_et_recommandations WHERE intitule LIKE '[TEST-TECHNIQUE]%';
   ```
   Les quatre compteurs doivent être à 0.
7. Après déploiement du site : **Ctrl + Maj + R** sur chaque poste (le service worker
   conserve l'ancienne version en cache).
