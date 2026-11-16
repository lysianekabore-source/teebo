// Faux PostgreSQL pour tester la logique de la vague 36 sans serveur de base.
// Chaque requête reçoit une réponse de la forme { rows }.
export const base = {
  imf: [], institution_features: [], institution_module_subscriptions: [],
  saas_invoice_lines: [], audit_log: [], imf_access_restrictions: []
};

export const jour = (d) => new Date(d).toISOString().slice(0, 10);
export const decale = (n) => jour(Date.now() + n * 86400000);

export function reinit(id) {
  base.imf = [{ id, code_imf: 'IMF001', name: 'IMF Test', type: 'scoops',
    country_code: 'CI', city: 'Abidjan', status: 'trial',
    trial_started_at: decale(-5), trial_ends_at: decale(25) }];
  base.institution_features = [{ institution_id: id, module_collecte_tontine: true,
    module_dossier_credit: false, module_compliance_kyc: false,
    module_comptabilite_avancee: false, options: {}, updated_by: null,
    updated_at: new Date().toISOString() }];
  base.institution_module_subscriptions = [];
  base.saas_invoice_lines = [];
  base.audit_log = [];
  base.imf_access_restrictions = [];
}

export function query(text, params = []) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  const p = params;

  /* --- packages ---------------------------------------------------- */
  if (/fn_restrict_imf_to_collecte/.test(t)) {
    let coupes = 0;
    for (const l of base.institution_module_subscriptions) {
      if (l.module_key === 'MODULE_COLLECTE_TONTINE') {
        l.is_active = true; l.is_trial = true;
        l.deactivated_reason = null; l.restriction_code = null;
        if (!l.trial_end_date) l.trial_end_date = decale(30);
      } else if (l.is_active === true) {
        l.is_active = false; l.deactivated_at = jour(new Date());
        l.deactivated_reason = 'RESTRICTION_COLLECTE_ONLY';
        l.restriction_code = 'RESTRICTION_COLLECTE_ONLY';
        coupes += 1;
      }
    }
    const deja = base.imf_access_restrictions.some((x) => x.institution_id === p[0] && x.is_active);
    if (!deja) {
      base.imf_access_restrictions.push({ institution_id: p[0], is_active: true,
        restriction_code: 'COLLECTE_ONLY', restricted_at: new Date().toISOString() });
    }
    return { rows: [{ r: { restriction: 'COLLECTE_ONLY', modules_coupes: coupes } }] };
  }
  if (/fn_lift_imf_restriction/.test(t)) {
    for (const x of base.imf_access_restrictions) if (x.institution_id === p[0]) x.is_active = false;
    return { rows: [{ r: { restriction: 'LEVEE' } }] };
  }

  /* --- imf --------------------------------------------------------- */
  if (/SELECT id, code_imf, name, type, country_code, city, status FROM imf/.test(t)
      || /SELECT id, code_imf, name, status::text AS status/.test(t)) {
    const r = base.imf.find((x) => x.id === p[0]);
    return { rows: r ? [r] : [] };
  }

  /* --- institution_features ---------------------------------------- */
  if (t.startsWith('INSERT INTO institution_features')) {
    let c = base.institution_features.find((x) => x.institution_id === p[0]);
    if (!c) {
      c = { institution_id: p[0], module_collecte_tontine: false, module_dossier_credit: false,
        module_compliance_kyc: false, module_comptabilite_avancee: false,
        options: {}, updated_at: new Date().toISOString() };
      base.institution_features.push(c);
    }
    if (/TRUE, FALSE, FALSE, FALSE/.test(t)) {
      c.module_collecte_tontine = true; c.module_dossier_credit = false;
      c.module_compliance_kyc = false; c.module_comptabilite_avancee = false;
    }
    const m = t.match(/\(institution_id, (module_[a-z_]+)/);
    if (m) c[m[1]] = true;
    c.updated_at = new Date().toISOString();
    return { rows: [c] };
  }
  if (t.startsWith('UPDATE institution_features SET')) {
    const c = base.institution_features.find((x) => x.institution_id === p[0]);
    ['module_collecte_tontine', 'module_dossier_credit', 'module_compliance_kyc',
      'module_comptabilite_avancee'].forEach((col, i) => { c[col] = p[i + 1] === true; });
    return { rows: [c] };
  }
  if (/FROM institution_features WHERE institution_id=\$1/.test(t)) {
    const r = base.institution_features.find((x) => x.institution_id === p[0]);
    return { rows: r ? [r] : [] };
  }

  /* --- souscriptions ------------------------------------------------ */
  if (t.startsWith('INSERT INTO institution_module_subscriptions')) {
    const id = p[0]; const key = p[1];
    let l = base.institution_module_subscriptions
      .find((x) => x.institution_id === id && x.module_key === key);
    const estEssai = /VALUES \(\$1,\$2,TRUE,CURRENT_DATE,TRUE/.test(t);
    if (!l) {
      l = { institution_id: id, module_key: key, is_active: true,
        activated_at: jour(new Date()), is_trial: estEssai,
        trial_end_date: estEssai ? p[2] : null, trial_used: !estEssai,
        deactivated_reason: null, restriction_code: null };
      base.institution_module_subscriptions.push(l);
    } else {
      l.is_active = true;
      l.is_trial = estEssai;
      l.trial_end_date = estEssai ? (l.trial_end_date || p[2]) : null;
      l.deactivated_at = null; l.deactivated_reason = null; l.restriction_code = null;
    }
    return { rows: [l] };
  }

  // État complet, pour l'écran (SELECT module_key, is_active, is_trial, ...)
  if (/SELECT (is_active, is_trial, trial_end_date, deactivated_reason, restriction_code,|module_key, is_active, is_trial)/.test(t)) {
    const auj = jour(new Date());
    if (t.includes('module_key, is_active')) {
      return { rows: base.institution_module_subscriptions
        .filter((x) => x.institution_id === p[0])
        .map((x) => ({ ...x, is_usable: x.is_active === true &&
          !(x.is_trial === true && x.trial_end_date && jour(x.trial_end_date) < auj) }))
        .sort((a, b) => a.module_key.localeCompare(b.module_key)) };
    }
    const r = base.institution_module_subscriptions
      .find((x) => x.institution_id === p[0] && x.module_key === p[1]);
    return { rows: r ? [r] : [] };
  }
  if (/FROM institution_module_subscriptions WHERE institution_id = \$1 AND module_key = \$2/.test(t)) {
    const r = base.institution_module_subscriptions
      .find((x) => x.institution_id === p[0] && x.module_key === p[1]);
    return { rows: r ? [r] : [] };
  }
  if (/SELECT \* FROM institution_module_subscriptions/.test(t)) {
    const r = base.institution_module_subscriptions
      .find((x) => x.institution_id === p[0] && x.module_key === p[1]);
    return { rows: r ? [r] : [] };
  }
  if (/SELECT is_active, is_trial, trial_end_date, activated_at/.test(t)) {
    const r = base.institution_module_subscriptions
      .find((x) => x.institution_id === p[0] && x.module_key === p[1]);
    return { rows: r ? [r] : [] };
  }
  if (/SELECT module_key FROM institution_module_subscriptions/.test(t)) {
    return { rows: base.institution_module_subscriptions
      .filter((x) => x.institution_id === p[0] && x.is_active === true)
      .map((x) => ({ module_key: x.module_key })) };
  }

  /* --- restriction active ? ----------------------------------------- */
  if (/FROM imf_access_restrictions/.test(t)) {
    const n = base.imf_access_restrictions
      .filter((x) => x.institution_id === p[0] && x.is_active === true).length;
    return { rows: n ? [{ exist: 1 }] : [] };
  }

  /* --- essai déjà consommé ? ---------------------------------------- */
  if (/FROM saas_invoice_lines/.test(t)) {
    const d = base.saas_invoice_lines.some((x) => x.institution_id === p[0]
      && x.module_key === p[1]
      && (x.statut_ligne === 'essai_gratuit' || x.trial_end_date));
    return { rows: [{ d }] };
  }

  /* --- audit -------------------------------------------------------- */
  if (/INSERT INTO audit_log/.test(t)) {
    base.audit_log.push({ imf_id: p[0], actor_id: p[1], action: p[2],
      entity_id: p[3], payload: p[4] });
    return { rows: [] };
  }

  return { rows: [] };
}

export default { query, base, reinit, jour, decale };
