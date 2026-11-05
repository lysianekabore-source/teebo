# teebo — Corriger l'erreur `ENOTFOUND dpg-...` (base de données introuvable)

## ✅ Bonne nouvelle d'abord

L'erreur `branch: principal` est **terminée** : Render construit maintenant votre
serveur et le démarre correctement. Il reste **une seule étape** : relier le
serveur à sa base de données.

## Ce que dit l'erreur

```
Error: getaddrinfo ENOTFOUND dpg-dblsn9ijnfac73dcna0g-a
   at .../pg-pool/index.js
   at async main (.../src/migrate.js)
==> Exited with status 1
```

**Traduction simple :** au démarrage, le serveur essaie de se connecter à la
base PostgreSQL à l'adresse `dpg-dblsn9ijnfac73dcna0g-a`, mais **cette adresse
n'existe pas / n'est pas trouvable**. Autrement dit, la variable `DATABASE_URL`
de votre serveur pointe vers une base qui n'est pas (ou plus) la bonne.

Causes habituelles :
- la base a été **recréée ou supprimée** (son adresse `dpg-...` a changé), mais
  l'ancienne adresse est restée dans `DATABASE_URL` ;
- la base et le serveur **ne sont pas reliés** (adresse collée à la main) ;
- la base et le serveur ne sont **pas dans la même région**.

---

## 🔧 LA SOLUTION LA PLUS SIMPLE (3 minutes, sans technique)

### Étape 1 — Récupérer la vraie adresse de la base

1. Sur https://dashboard.render.com, ouvrez votre **base de données**
   (dans la barre de gauche, le service de type *PostgreSQL*, ex. `teebo-db`).
   > ⚠️ Si vous ne voyez **aucune** base PostgreSQL : il faut d'abord en créer
   > une (voir « Si la base n'existe pas » plus bas).
2. Dans la page de la base, descendez jusqu'à la section **Connections**.
3. Vous voyez deux adresses. Copiez **External Database URL**
   (celle qui finit par `...render.com`), elle ressemble à :
   ```
   postgresql://teebo:MOTDEPASSE@dpg-xxxxxxxx-a.frankfurt-postgres.render.com/teebo
   ```
   > Cliquez sur l'icône « copier » à côté (évite les fautes de frappe).

### Étape 2 — Coller cette adresse dans le serveur

1. Toujours sur Render, ouvrez votre **service web `teebo-api`**.
2. Barre de gauche : **Environment** (Variables d'environnement).
3. Trouvez la variable **`DATABASE_URL`**.
4. Cliquez pour l'éditer, **effacez l'ancienne valeur**, et **collez** l'adresse
   externe copiée à l'étape 1.
5. Cliquez sur **Save Changes**.

### Étape 3 — Relancer le déploiement

1. Onglet **Deploys** du service `teebo-api`.
2. Bouton **Manual Deploy** > **Deploy latest commit** (ou **Clear build cache & deploy**).
3. Regardez les logs : vous devez voir défiler
   ```
   Schéma appliqué : schema.sql
   Schéma appliqué : schema_v3.sql
   ```
   puis le serveur qui démarre, et enfin le statut **Live** ✅

> 🔌 Cette archive contient déjà la correction côté code pour accepter la
> connexion externe chiffrée (SSL). Vous n'avez donc rien d'autre à modifier
> dans le code.

---

## Si la base de données n'existe pas (ou a été supprimée)

1. Sur Render : **New +** > **PostgreSQL**.
2. Name : `teebo-db` · Database : `teebo` · User : `teebo` · Region : **Frankfurt**
   (la **même région** que le serveur `teebo-api`) · Plan : **Free**.
3. Créez-la, attendez le statut **Available**.
4. Reprenez les étapes 1 à 3 ci-dessus avec son adresse **External Database URL**.

---

## Vérification finale

Quand `teebo-api` est **Live**, ouvrez dans un onglet :
```
https://<adresse-de-votre-service>.onrender.com/healthz
```
Vous devez obtenir une réponse du serveur (et non une erreur). Ensuite, publiez
le paquet Netlify et connectez-vous avec `hello@teebo.africa`.

---

## Récapitulatif de l'ordre des choses

1. **Base PostgreSQL** créée et **Available** (région Frankfurt).
2. **`DATABASE_URL`** du serveur = **External Database URL** de cette base.
3. **Redeploy** `teebo-api` → statut **Live**.
4. **Netlify** : publier le paquet `teebo-netlify-avec-api.zip`.
5. Tester la **connexion** sur le site.

---

**teebo.africa** — La finance à visage humain.
WhatsApp : +226 50 32 14 32 (wa.me/22650321432) · hello@teebo.africa
