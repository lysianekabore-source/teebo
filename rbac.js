// teebo — Contrôle d'accès (deny-by-default) basé sur la session vérifiée.
// À utiliser quand USE_SESSION=1. Suppose req.session déjà posé par attachSession.
const TEEBO_ROLE = process.env.TEEBO_ROLE || 'TEEBO_ADMIN';

// Exige un rôle plateforme teebo (côté super-admin).
export function requireTeeboRole(req, res, next) {
  const roles = (req.session && req.session.roles) || [];
  if (!roles.includes(TEEBO_ROLE)) return res.status(403).json({ error: 'reserve_a_teebo' });
  next();
}

// Exige une permission précise côté IMF (ex. 'rbac.manage') ET un imf_id en session.
// Deny-by-default : si la permission n'est pas présente, on refuse.
export function requirePermission(code) {
  return (req, res, next) => {
    const s = req.session || {};
    if (!s.imfId) return res.status(400).json({ error: 'imf_id_absent_session' });
    const perms = s.permissions || [];
    const roles = s.roles || [];
    // Un admin IMF (via rôle) ou la permission explicite donnent l'accès.
    if (perms.includes(code) || roles.includes('IMF_ADMIN')) return next();
    return res.status(403).json({ error: 'permission_refusee', requise: code });
  };
}
