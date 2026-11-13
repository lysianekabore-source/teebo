# teebo — Relier le site Netlify au serveur Render (redirection `/api`)

> Ce paquet est **le site teebo pour Netlify**, déjà configuré pour envoyer
> tous les appels `/api/*` vers votre serveur **Render**.
>
> L'adresse de votre serveur est **déjà renseignée** :
> `https://teebo-api-p825.onrender.com`
>
> **Si c'est bien votre adresse, vous n'avez RIEN à modifier — passez directement à l'ÉTAPE 3 (publier).**

---

## Comment ça marche (en 1 image)

```
  Navigateur
     |
     v
  https://votre-site.netlify.app          (le site = ce paquet)
     |
     |  Les pages appellent  /api/v1/...
     v
  Netlify voit /api/*  ->  le transmet à  https://teebo-api.onrender.com/api/...
                                                    |
                                                    v
                                          Serveur teebo (Render) + PostgreSQL
```

Pour le navigateur, **tout se passe sur une seule adresse** (celle de Netlify).
Les cookies de connexion fonctionnent donc parfaitement : pas de problème CORS.

---

## ÉTAPE 1 — Confirmer l'adresse de votre serveur Render

L'adresse est déjà renseignée dans ce paquet :
```
https://teebo-api-p825.onrender.com
```
1. Allez sur https://dashboard.render.com
2. Ouvrez votre service web **`teebo-api`**.
3. Vérifiez que l'adresse en haut de la page est bien
   `teebo-api-p825.onrender.com`.
4. Si elle est **identique** : parfait, ne touchez à rien. ✅
   Si elle est **différente** : passez à l'ÉTAPE 2.

---

## ÉTAPE 2 — Mettre l'adresse dans les 2 fichiers (seulement si elle diffère)

Ce paquet est **déjà pré-rempli** avec `https://teebo-api-p825.onrender.com`.

- **Si votre adresse Render est exactement `teebo-api-p825.onrender.com`** :
  vous n'avez **rien à changer**, passez à l'étape 3. ✅
- **Si elle est différente**, ouvrez ces 2 fichiers et remplacez
  `teebo-api-p825.onrender.com` par votre adresse :
  1. le fichier **`_redirects`** (ligne commençant par `/api/*`)
  2. le fichier **`netlify.toml`** (bloc `from = "/api/*"`)

> ⚠️ Gardez bien le `https://` et la fin `/api/:splat`. Ne changez **que** le nom de domaine.

---

## ÉTAPE 3 — Publier sur Netlify

1. Sélectionnez **tout le contenu de ce dossier** et créez une **archive ZIP**
   (ou utilisez directement `teebo-netlify-avec-api.zip` si l'adresse n'a pas changé).
2. Sur https://app.netlify.com, ouvrez votre projet.
3. Onglet **Deploys**.
4. **Glissez-déposez l'archive ZIP** dans la zone de dépôt.
5. Attendez le statut **Published**.

---

## ÉTAPE 4 — Vérifier que la liaison fonctionne

1. Ouvrez votre site Netlify.
2. Allez sur la page **Connexion** (`/login`).
3. Connectez-vous avec le compte administrateur teebo :
   - Identifiant : `hello@teebo.africa`
   - Mot de passe : celui que vous avez défini dans Render (`TEEBO_ADMIN_PASSWORD`).
4. Si la connexion réussit : **la redirection fonctionne, tout est relié** ✅

### Test rapide dans le navigateur (facultatif)
Ouvrez dans un onglet :
```
https://votre-site.netlify.app/api/v1/health
```
(ou `/healthz`). Vous devez recevoir une réponse du serveur (pas une page 404 Netlify).

---

## En cas de problème

| Symptôme | Cause probable | Solution |
|---|---|---|
| Erreur **404** sur `/api/...` | Mauvaise adresse Render | Vérifiez l'adresse dans `_redirects` **ET** `netlify.toml` |
| Erreur **502 / 503** sur `/api/...` | Serveur Render endormi (plan gratuit) | Attendez ~1 min (réveil) et rechargez |
| Connexion refuse le cookie | Serveur pas en HTTPS | L'adresse Render doit être en `https://` |
| La page s'affiche mais boutons inactifs | API injoignable | Testez l'URL `/api/v1/health` directement |
| Lenteur au 1er appel | Réveil du plan gratuit Render | Normal ; envisagez un plan payant pour la production |

---

## Rappel important (ordre de déploiement)

1. **D'abord** : le serveur Render doit être **Live** (voir le guide
   `GUIDE-DEPLOIEMENT-RENDER.md` fourni avec l'archive serveur `teebo-production-render.zip`).
2. **Ensuite** : publiez ce paquet Netlify avec la bonne adresse.

---

**teebo.africa** — La finance à visage humain.
WhatsApp : +226 50 32 14 32 (wa.me/22650321432) · hello@teebo.africa
