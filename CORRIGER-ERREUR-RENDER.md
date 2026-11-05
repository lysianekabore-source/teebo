# ⚠️ Corriger l'erreur Render que vous voyez à l'écran

> Message affiché :
> **« services[0].branch  branch principal could not be found »**

---

## Pourquoi cette erreur

Votre fichier `render.yaml` (sur GitHub) contient une ligne
`branch: principal`. **Cette branche n'existe pas** : votre dépôt utilise la
branche **`main`**. Render ne trouve donc pas « principal » et s'arrête.

---

## ✅ Solution la plus rapide (30 secondes, sur GitHub)

1. Sur GitHub, ouvrez votre dépôt puis cliquez sur le fichier **`render.yaml`**.
2. Cliquez sur l'icône **crayon** (éditer) en haut à droite du fichier.
3. Trouvez la ligne qui contient :
   ```
   branch: principal
   ```
4. **Supprimez entièrement cette ligne.**
   *(Sans ligne « branch », Render prend automatiquement la branche choisie : `main`.)*
5. En bas, cliquez **Commit changes**.
6. Retournez sur Render et relancez : **Manual Deploy** ou rechargez la page du Blueprint.

> Variante : au lieu de supprimer, remplacez `principal` par `main`.
> Les deux fonctionnent. **Supprimer est le plus sûr.**

---

## 🧹 Important : nettoyer aussi votre dépôt

Sur votre capture GitHub, je vois **deux problèmes** qui bloqueront la suite
**même après avoir corrigé la branche** :

1. **Les fichiers sont à plat à la racine** (`app.html`, `app.css`, `Dockerfile`…
   tous mélangés). Or le serveur a besoin des **dossiers** `backend/`, `db/`, `frontend/`.
2. **Il y a deux Dockerfile** (`Dockerfile` et `Dockerfile (1)`) : un doublon
   dû à un téléversement en double.

**La solution propre et rapide** est de repartir d'une structure correcte,
fournie dans l'archive **`teebo-production-render.zip`** (voir ci-dessous).

---

## 🚀 Repartir proprement (recommandé)

1. Sur GitHub, dans votre dépôt : **Settings** n'est pas nécessaire. Le plus simple :
   - Supprimez les fichiers en double (surtout `Dockerfile (1)`), **ou**
   - Créez un **nouveau dépôt propre** nommé `teebo`.
2. Téléchargez et décompressez **`teebo-production-render.zip`**.
3. Sur GitHub (nouveau dépôt) : **Add file > Upload files**, puis
   **glissez les DOSSIERS** `backend`, `db`, `frontend`, `tools`, `tests`
   ET les fichiers `render.yaml`, `README.md`, etc.
   > ⚠️ Glissez bien les **dossiers entiers**, pas leur contenu à plat.
   > Le fichier `render.yaml` doit rester **à la racine**.
4. **Commit changes.**
5. Sur Render : **New + > Blueprint**, choisissez ce dépôt, branche **`main`**, **Apply**.
6. Saisissez `TEEBO_ADMIN_PASSWORD` (mot de passe fort), laissez le reste par défaut.
7. Attendez le statut **Live** (~5 min). C'est en ligne. ✅

---

## Structure attendue du dépôt (pour vérifier)

```
(racine du dépôt)
├── render.yaml          ← A LA RACINE (sans ligne "branch")
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   └── src/...
├── db/
│   ├── schema.sql
│   └── schema_v3.sql
├── frontend/...
├── tools/...
└── tests/...
```

Un **seul** Dockerfile, dans `backend/`. Pas de `Dockerfile (1)`.

---

**teebo.africa** — La finance à visage humain.
WhatsApp : +226 50 32 14 32 (wa.me/22650321432) · hello@teebo.africa
