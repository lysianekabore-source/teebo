=====================================================================
 teebo — CORRECTIF DU DEPLOIEMENT RENDER (VAGUE 51)
 18/11/2026 — « Deploy failed : sh: 0: cannot open ./start.sh »
=====================================================================

CE QUI SE PASSAIT
-----------------
Le service lancait le fichier start.sh au demarrage, mais ce fichier
n'etait JAMAIS copié dans l'image : il manquait la ligne de copie.
Le conteneur s'arretait donc aussitot (code 2) et Render affichait
« Deploy failed ».

CE QUI A ETE CORRIGE
--------------------
1. Le fichier start.sh est desormais copié dans l'image.
2. Le serveur ne depend plus de ce fichier : il demarre directement.
   Meme si un fichier manquait encore, le service demarrerait.
3. L'image sait s'adapter aux deux dispositions possibles du dossier
   (Dockerfile a cote du code, ou a cote du dossier backend).
   Les erreurs precedentes venaient justement de la.
4. Le message de fabrication affiche le contenu reel de l'image
   (dossier du code, nombre de migrations SQL) : en cas d'echec, la
   cause est lisible immediatement dans le journal de build.
5. Le fichier de configuration Render (render.yaml) indiquait un
   emplacement de Dockerfile inexistant ; il est corrige.

REGLAGE A VERIFIER SUR RENDER (point n°1 des echecs)
-----------------------------------------------------
Le service utilise Docker. Render doit donc trouver le Dockerfile.
Deux reglages possibles, tous les deux desormais acceptes :

  A) Root Directory = backend
     Dockerfile Path = Dockerfile
  B) Root Directory = vide
     Dockerfile Path = backend/Dockerfile

Regardez dans Settings > Build & Deploy. Si le Root Directory
contient autre chose que ce qui est prevu (par exemple « . » alors
que le Dockerfile est dans backend), corrigez-le.

POINT DE VERIFICATION APRES MISE EN LIGNE
-----------------------------------------
Ouvrir l'adresse du serveur suivie de /healthz
  -> reponse attendue : {"ok":true}
Puis /ready
  -> « pret » : true et aucune table manquante

REMARQUE SUR LE SECOND SERVICE EN ECHEC
---------------------------------------
teebo-habilitations-api-p825 est aussi en « Failed deploy ».
Il n'est pas utilise par le site ni par l'application : le serveur
teebo-api-p825 contient deja tout le module habilitations.
Vous pouvez le SUPPRIMER — mais uniquement apres avoir verifie
que teebo-api-p825 est bien « Live ».
=====================================================================
