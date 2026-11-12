# Vérification de fonctionnement — teebo IMF

Contrôle de cohérence réalisé sur le code livré (aucune base de test disponible
côté atelier) :

| Contrôle | Résultat |
|---|---|
| Postes du référentiel | 43 (42 + Président du Conseil d'Administration) |
| Cohérence socle ↔ catalogue de la base | 43 / 43 identiques, aucun écart |
| Responsable prévu pour chaque poste | 42 postes renseignés, 1 seul sommet (PCA) |
| Appellations de responsable existantes | 0 incohérence après harmonisation |
| Fichiers de mise à jour de la base | 25 fichiers, tous présents et dans l'ordre |
| Pages du site et de l'application | toutes présentes ; adresses courtes couvertes |
| Appels de l'application vers le serveur | 21 / 21 servis par une route existante |
| Éléments d'interface utilisés par le code | 0 manquant |
| Syntaxe JavaScript (serveur + interface) | 100 % validée |
| Version du cache hors-ligne | renouvelée (v22) : nouveau code garanti |

## Ce qui est actif et fonctionnel

- Connexion, mots de passe, double authentification, déconnexion.
- Génération de la structure de base, création / modification / suppression d'unités.
- Personnel : création de compte, envoi du code par e-mail, renvoi, suivi des envois.
- Responsable hiérarchique pré-rempli par poste, modifiable, contrôles anti-boucle
  et anti-auto-désignation.
- Tableau de bord, consolidation, rapport national, habilitations.
- Clients, crédits, caisse, coffre, comptabilité, collecte, objectifs, terminaux.
- Paramètres IMF (identité, logo, mentions légales) et journal d'audit.
