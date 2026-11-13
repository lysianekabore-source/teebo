// teebo — CHARGEMENT GROUPÉ DE LA PAGE « GOUVERNANCE & CONFORMITÉ »
// ---------------------------------------------------------------------------
// PROBLÈME RÉSOLU (14/11/2026) : à l'ouverture de la page, le navigateur
// lançait 15 à 20 requêtes API simultanées (institution, organes, membres,
// mandats, sessions, résolutions, tableau de bord, + le bloc conformité et
// l'actionnariat). Sur l'offre gratuite Render (0,1 vCPU, une seule instance,
// pool de 10 connexions), cette rafale saturait le proxy : réponses 502 Bad
// Gateway, page bloquée sur « Chargement… ».
//
// SOLUTION : UN SEUL appel /api/v1/governance/overview qui réunit toutes les
// données de la page. Le serveur exécute les lectures EN SÉRIE (jamais 20
// requêtes en parallèle), avec un cache mémoire très court (10 s) pour absorber
// les doubles clics et les allers-retours d'onglets.
//
// PRINCIPES :
//   - chaque section est calculée par SA propre fonction, isolée : si l'une
//     échoue, les autres sont quand même renvoyées (dégradation partielle, plus
//     jamais de page entièrement bloquée) ;
//   - les routes unitaires (/governance/organes, /membres…) restent en place :
//     l'endpoint groupé les réutilise directement (mêmes règles, même
//     cloisonnement par imf_id), donc aucune duplication de logique métier ;
//   - aucune donnée sensible n'est élargie : l'identité de l'utilisateur qui
//     appelle est transmise aux handlers, exactement comme sur un appel direct.
// ---------------------------------------------------------------------------

/** Requête HTTP interne, en mémoire, vers un handler de route déjà écrit. */
function callHandler(handler, user, query = {}) {
  return new Promise((resolve, reject) => {
    let status = 200;
    let settled = false;
    const req = {
      user,
      query,
      params: {},
      body: {},
      headers: {},
      method: 'GET',
      cookies: {},
      get: () => undefined
    };
    const res = {
      statusCode: 200,
      status(code) { status = code; this.statusCode = code; return this; },
      json(payload) {
        if (settled) return this;
        settled = true;
        if (status >= 400) {
          const err = new Error((payload && payload.error) || 'http_' + status);
          err.status = status;
          return reject(err);
        }
        return resolve(payload);
      },
      send(payload) { return this.json(payload); },
      setHeader() { return this; },
      set() { return this; },
      end() { if (!settled) { settled = true; resolve(null); } return this; }
    };
    Promise.resolve(handler(req, res, reject)).catch(reject);
    // Filet de sécurité : un handler ne doit JAMAIS bloquer la page entière.
    setTimeout(() => {
      if (!settled) { settled = true; const e = new Error('timeout'); e.status = 504; reject(e); }
    }, 20000).unref?.();
  });
}

/**
 * Construit le GET /governance/overview.
 * @param {Array} sources liste ordonnée de [nomSection, handler, options]
 */
export function buildGovernanceOverview(sources) {
  const CACHE_TTL_MS = 10000;
  const cache = new Map();

  return async function governanceOverview(req, res, next) {
    try {
      const imfId = req.user.imf_id;
      const key = imfId + ':' + req.user.id + ':' + (req.user.role || '');
      // ?refresh=1 : après une modification (création/retrait), l'écran doit
      // relire les données réelles. On ignore alors le cache court.
      const rafraichir = String((req.query && req.query.refresh) || '') === '1';
      const hit = rafraichir ? null : cache.get(key);
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Teebo-Cache', 'HIT');
        return res.json({ ...hit.data, cached: true });
      }

      const out = {};
      const failed = [];
      // SÉQUENTIEL, volontairement : c'est ce qui protège le proxy Render.
      // Plusieurs petites lectures qui se suivent valent mieux que 20 lectures
      // en parallèle sur une instance à 0,1 vCPU.
      for (const [name, handler, opts] of sources) {
        if (opts && opts.optional) {
          out[name] = { available: false };
          continue;
        }
        try {
          out[name] = await callHandler(handler, req.user, opts && opts.query);
        } catch (e) {
          // Une section en échec ne casse pas les autres.
          out[name] = { error: (e && e.message) || 'error', unavailable: true };
          failed.push({ section: name, error: (e && e.message) || 'error' });
        }
      }

      const data = { ok: true, loadedAt: new Date().toISOString(), sections: out, failed };
      // On ne met en cache que si TOUT est passé : une panne ne doit pas être
      // rejouée pendant 10 secondes.
      if (!failed.length) cache.set(key, { at: Date.now(), data });

      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Teebo-Cache', 'MISS');
      res.json(data);
    } catch (e) { next(e); }
  };
}
