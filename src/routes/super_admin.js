// ===========================================================================
// teebo — VAGUE 47 : CONSOLE DU SUPER-ADMINISTRATEUR SAAS
// ---------------------------------------------------------------------------
// Reserve au role SUPER_ADMIN_SAAS (teebo_admin). Toutes les routes sont
// montees sous /api/v1/super-admin/* : elles ne peuvent pas etre confondues
// avec un ecran IMF.
//
// CE QUE L'EDITEUR PEUT FAIRE :
//   - ouvrir un nouveau client (IMF) : institution + contrat + premier
//     administrateur IMF avec son code d'acces + agences de depart + plan
//     comptable SFD. Un seul appel, une seule transaction.
//   - activer / desactiver un module a chaud (effet immediat, sans
//     redeploiement), modifier le prix catalogue.
//   - voir le tableau de bord : nombre de clients, MRR/ARR, impayes.
//   - suspendre / reactiver / resilier un contrat (grace de 7 jours).
//   - emettre une facture d'abonnement, l'imprimer en PDF, enregistrer un
//     paiement.
//
// CE QUE L'EDITEUR NE PEUT PAS FAIRE (souverainete des donnees) :
//   lire un client, un solde d'epargne, un dossier de credit, une declaration
//   CENTIF ou une piece comptable. Seuls des COMPTEURS et des MONTANTS
//   AGREES sont exposes (voir super_admin.js / PERIMETRE_EDITEUR).
// ===========================================================================
import { Router } from 'express';
import { q, tx } from '../db.js';
import { authenticate, requireFreshPassword, requireRole } from '../auth.js';
import { setDocumentCsp } from '../documents.js';
import { chargerFacture, renderFactureSaas } from '../saas_invoice_pdf.js';
import {
  ROLE_EDITEUR, PERIMETRE_EDITEUR, statistiquesTenant, volumesTenant, syncTenant,
  revenusRecurrents, encoursFacturation, tableauDeBordEditeur, tracerActionEditeur
} from '../super_admin.js';
import { MODULES_SAAS, invaliderCache, CODE_TO_MODULE } from '../saas_engine.js';
import { semerPlanComptable, PLAN_COMPTABLE_INFO } from '../plan_comptable_sfd.js';
import { envoyerCodeAcces } from '../codes_acces.js';

const r = Router();
const gardien = [authenticate, requireFreshPassword, requireRole(ROLE_EDITEUR)];
// VAGUE 47 : l'en-tete X-Site-URL ne sert QU'A memoriser l'adresse du site pour
// les messages. Ici, aucune bascule d'IMF n'est possible : on retire l'en-tete
// pour que tenantContext ne resolve jamais une autre institution et qu'aucune
// requete de la console ne puisse viser les donnees d'un client.
r.use((req, _res, next) => { delete req.headers['x-teebo-institution']; next(); });

/* ------------------------------------------------------------------ */
/*  Utilitaires                                                        */
/* ------------------------------------------------------------------ */
const PAYS_UEMOA = ['CI', 'SN', 'BF', 'ML', 'BJ', 'TG', 'NE', 'GW'];

function txt(v, max = 200) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

function montant(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0;
}

function jour(v) {
  const s = String(v || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function refus(res, code, message, status = 400) {
  return res.status(status).json({ error: code, code, message });
}

/** Trace l'action dans le journal dedie ET dans la piste d'audit. */
async function tracer(req, action, tenantId, cible, details) {
  try {
    await q(
      `INSERT INTO editeur_acces_log(editeur_id, action, tenant_id, cible, details, ip)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
      [req.user.id, action, tenantId || null, cible || null,
       JSON.stringify(details || {}), req.ip || null]);
  } catch (e) { /* table absente : on garde au moins audit_log */ }
  try {
    await tracerActionEditeur(req.user, action,
      { tenant_id: tenantId, entity: cible || 'saas' }, details);
  } catch (e) { /* jamais bloquant */ }
}

/* ------------------------------------------------------------------ */
/*  TABLEAU DE BORD                                                    */
/* ------------------------------------------------------------------ */
r.get('/tableau-de-bord', ...gardien, async (req, res, next) => {
  try {
    const tableau = await tableauDeBordEditeur();
    res.json({
      ...tableau,
      modules_catalogue: MODULES_SAAS,
      perimetre: { autorise: PERIMETRE_EDITEUR.autorise, interdit: PERIMETRE_EDITEUR.interdit },
      message_perimetre: "Votre acces SUPER_ADMIN_SAAS couvre l'administration de la plateforme : "
        + "contrats, modules, facturation. Les donnees des adherents (clients, soldes, "
        + "credits, declarations) restent strictement chez chaque IMF."
    });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  LISTE DES TENANTS (clients de la plateforme)                       */
/* ------------------------------------------------------------------ */
r.get('/tenants', ...gardien, async (req, res, next) => {
  try {
    const { search } = req.query || {};
    const s = txt(search, 80);
    const { rows } = await q(
      `SELECT t.id AS tenant_id, t.imf_id, t.nom_imf, t.sigle, t.pays, t.plan_code,
              t.statut_compte, t.date_debut, t.date_expiration_essai, t.date_suspension,
              t.jours_grace, t.valeur_contrat_xof, t.periodicite,
              t.contact_email, t.contact_phone, t.contact_nom, t.notes_internes,
              i.status::text AS imf_status, i.city,
              (SELECT count(*) FROM app_user u WHERE u.imf_id = t.imf_id
                 AND u.role <> 'teebo_admin') AS nb_utilisateurs,
              (SELECT count(*) FROM tenant_modules_actifs m
                 WHERE m.tenant_id = t.id AND m.est_actif = TRUE) AS nb_modules,
              (SELECT string_agg(m.code_module, ',' ORDER BY m.code_module)
                 FROM tenant_modules_actifs m
                WHERE m.tenant_id = t.id AND m.est_actif = TRUE) AS modules,
              COALESCE((SELECT SUM(f.montant_ttc_xof) FROM factures_saas f
                         WHERE f.tenant_id = t.id
                           AND f.statut_paiement IN ('EN_ATTENTE','EN_RETARD')), 0) AS impaye_xof
         FROM tenants t
         JOIN imf i ON i.id = t.imf_id
        WHERE ($1::text IS NULL OR t.nom_imf ILIKE '%'||$1||'%' OR t.sigle ILIKE '%'||$1||'%')
        ORDER BY t.created_at DESC
        LIMIT 500`, [s]);
    res.json({ tenants: rows });
  } catch (e) {
    // Base pas encore migree : on renvoie une liste vide plutot qu'une erreur.
    if (/relation .* does not exist/.test(String(e && e.message))) {
      return res.json({ tenants: [], avertissement: 'Migration 47 non appliquee.' });
    }
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/*  FICHE D'UN TENANT : metadonnees techniques seulement               */
/* ------------------------------------------------------------------ */
r.get('/tenants/:tenantId', ...gardien, async (req, res, next) => {
  try {
    const t = (await q(
      `SELECT * FROM tenants WHERE id = $1`, [req.params.tenantId])).rows[0];
    if (!t) return refus(res, 'TENANT_INTROUVABLE', 'Ce client est introuvable.', 404);

    const [abon, modules, factures, stats, volumes, sync] = await Promise.all([
      q(`SELECT * FROM abonnements_tenants WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1`,
        [t.id]),
      q(`SELECT m.code_module, m.est_actif, m.en_essai, m.active_le, m.desactive_le,
                m.expires_at, m.prix_applique_xof, m.motif,
                c.nom, c.prix_mensuel_xof
           FROM tenant_modules_actifs m
           JOIN catalogue_modules c ON c.code_module = m.code_module
          WHERE m.tenant_id=$1 ORDER BY c.ordre`, [t.id]),
      q(`SELECT id, numero_facture, periode_debut, periode_fin, montant_ttc_xof,
                statut_paiement, date_emission, date_echeance, date_paiement, mode_paiement
           FROM factures_saas WHERE tenant_id=$1 ORDER BY periode_debut DESC LIMIT 24`, [t.id]),
      statistiquesTenant(t.imf_id),
      volumesTenant(t.imf_id),
      syncTenant(t.imf_id)
    ]);

    res.json({
      tenant: t,
      abonnement: abon.rows[0] || null,
      modules: modules.rows,
      factures: factures.rows,
      metadonnees: { ...stats, volumes, synchronisation: sync },
      perimetre: PERIMETRE_EDITEUR.autorise
    });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  ONBOARDING D'UNE NOUVELLE IMF                                      */
/* ------------------------------------------------------------------ */
// Corps attendu :
// { nom_imf, sigle, pays, ville, type ('SA'|'SCOOP'), bceao_agreement_no,
//   phone_main, whatsapp, email,
//   admin: { full_name, email, phone },
//   modules: ['COLLECTE','CREDIT',...], essai_jours: 30,
//   agences: [{ nom, ville }],
//   envoyer_code: true }
// Tout est fait dans UNE transaction : soit l'IMF est entierement prete, soit
// rien n'est cree (jamais de client a moitie configure).
r.post('/onboarding', ...gardien, async (req, res, next) => {
  try {
    const b = req.body || {};
    const nomImf = txt(b.nom_imf, 160);
    const emailImf = txt(b.email, 160);
    const pays = String(b.pays || '').toUpperCase().slice(0, 2);
    const type = String(b.type || 'SA').toUpperCase();
    const admin = b.admin || {};
    const adminNom = txt(admin.full_name, 120);
    const adminEmail = txt(admin.email, 160);

    if (!nomImf) return refus(res, 'NOM_MANQUANT', "Indiquez le nom de l'institution.");
    if (!PAYS_UEMOA.includes(pays)) {
      return refus(res, 'PAYS_INVALIDE', 'Choisissez un pays de l UEMOA : ' + PAYS_UEMOA.join(', ') + '.');
    }
    if (!['SA', 'SCOOP'].includes(type)) return refus(res, 'TYPE_INVALIDE', 'Type attendu : SA ou SCOOP.');
    if (!emailImf || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailImf)) {
      return refus(res, 'EMAIL_INVALIDE', "L'e-mail de l'institution est obligatoire et doit etre valide.");
    }
    if (!adminNom || !adminEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(adminEmail)) {
      return refus(res, 'ADMIN_INVALIDE', "Renseignez le nom complet et l'e-mail du premier administrateur IMF.");
    }

    const essaiJours = Number.isFinite(Number(b.essai_jours))
      ? Math.max(0, Math.min(365, Number(b.essai_jours))) : 30;
    const modulesDemandes = Array.isArray(b.modules) && b.modules.length
      ? b.modules.map((m) => String(m).toUpperCase()).filter((m) => CODE_TO_MODULE[m] !== undefined)
      : ['COLLECTE'];
    const agences = Array.isArray(b.agences) ? b.agences.filter((a) => txt(a && a.nom, 120)).slice(0, 15) : [];

    const out = await tx(async (c) => {
      // 1. L'institution
      const codeImf = (await c.query('SELECT fn_gen_imf_code($1) AS c', [pays])).rows[0].c;
      const statutImf = essaiJours > 0 ? 'trial' : 'active';
      const imf = (await c.query(
        `INSERT INTO imf(code_imf, name, type, country_code, city, capital_cents,
             bceao_agreement_no, phone_main, whatsapp, email, status,
             trial_started_at, trial_ends_at)
         VALUES ($1,$2,$3::imf_type,$4,$5,0,$6,$7,$8,$9,$10::imf_status,
                 CASE WHEN $11::int > 0 THEN now() END,
                 CASE WHEN $11::int > 0 THEN now() + ($11::int || ' days')::interval END)
         RETURNING id, code_imf`,
        [codeImf, nomImf, type, pays, txt(b.ville, 120) || 'N/D',
         txt(b.bceao_agreement_no, 80) || 'EN COURS',
         txt(b.phone_main, 40) || 'N/D', txt(b.whatsapp, 40) || 'N/D',
         emailImf, statutImf, essaiJours])).rows[0];

      // 2. Le contrat SaaS (tenant)
      const tenant = (await c.query(
        `INSERT INTO tenants (imf_id, nom_imf, sigle, pays, plan_code, statut_compte,
             date_debut, date_expiration_essai, jours_grace, contact_nom,
             contact_email, contact_phone, notes_internes, cree_par)
         VALUES ($1,$2,$3,$4,'STANDARD',$5,CURRENT_DATE,$6,
                 COALESCE((SELECT valeur::int FROM app_parametres
                            WHERE cle='SAAS_JOURS_GRACE_DEFAUT'),7),
                 $7,$8,$9,$10,$11)
         RETURNING id`,
        [imf.id, nomImf, imf.code_imf, pays,
         essaiJours > 0 ? 'ESSAI_GRATUIT' : 'ACTIF',
         essaiJours > 0 ? (new Date(Date.now() + essaiJours * 86400000).toISOString().slice(0, 10)) : null,
         adminNom, adminEmail, txt(admin.phone, 40), txt(b.notes, 500), req.user.id])).rows[0];

      // 3. Modules souscrits (a chaud, sans redeploiement)
      let valeur = 0;
      for (const code of modulesDemandes) {
        const cat = (await c.query(
          'SELECT prix_mensuel_xof FROM catalogue_modules WHERE code_module=$1', [code])).rows[0];
        const prix = cat ? Number(cat.prix_mensuel_xof) : 0;
        valeur += prix;
        await c.query(
          `INSERT INTO tenant_modules_actifs (tenant_id, code_module, est_actif, en_essai,
               prix_applique_xof, active_par, motif)
           VALUES ($1,$2,TRUE,$3,$4,$5,'onboarding')
           ON CONFLICT (tenant_id, code_module)
           DO UPDATE SET est_actif=TRUE, desactive_le=NULL, en_essai=EXCLUDED.en_essai`,
          [tenant.id, code, essaiJours > 0, prix, req.user.id]);
        // Coherence avec la table historique : les ecrans existants continuent
        // de fonctionner avec les anciennes cles MODULE_*.
        const legacy = CODE_TO_MODULE[code];
        if (legacy) {
          await c.query(
            `INSERT INTO institution_module_subscriptions
               (institution_id, module_key, is_active, is_trial, trial_end_date, created_by)
             VALUES ($1,$2,TRUE,$3,$4,$5)
             ON CONFLICT (institution_id, module_key)
             DO UPDATE SET is_active=TRUE, is_trial=EXCLUDED.is_trial,
                           trial_end_date=EXCLUDED.trial_end_date, updated_at=now()`,
            [imf.id, legacy, essaiJours > 0,
             essaiJours > 0 ? (new Date(Date.now() + essaiJours * 86400000).toISOString().slice(0, 10)) : null,
             req.user.id]).catch(() => {});
        }
      }

      // 4. Abonnement
      await c.query(
        `INSERT INTO abonnements_tenants (tenant_id, plan_code, montant_total_periodique_xof,
             periodicite, date_debut, statut, cree_par)
         VALUES ($1,'STANDARD',$2,'MENSUEL',CURRENT_DATE,'ACTIF',$3)`,
        [tenant.id, valeur, req.user.id]);
      await c.query('UPDATE tenants SET valeur_contrat_xof=$2 WHERE id=$1', [tenant.id, valeur]);

      // 5. Structure organisationnelle (8 departements + services)
      let structure = null;
      try {
        await c.query('SELECT fn_seed_org_structure($1)', [imf.id]);
        structure = 'socle_8_departements';
      } catch (e) { structure = 'differe'; }

      // 6. Agences de depart
      const agencesCreees = [];
      for (const a of agences) {
        try {
          const code = (await c.query('SELECT fn_gen_unit_code($1,$2::unit_kind) AS c',
            [imf.id, 'agency'])).rows[0].c;
          const row = (await c.query(
            `INSERT INTO org_unit(imf_id, kind, code_unit, name, city)
             VALUES ($1,'agency',$2,$3,$4) RETURNING id, name`,
            [imf.id, code, txt(a.nom, 120), txt(a.ville, 120)])).rows[0];
          agencesCreees.push({ id: row.id, nom: row.name, code });
        } catch (e) { /* une agence en echec ne bloque pas l'ouverture */ }
      }

      // 7. Plan comptable de demarrage
      const plan = await semerPlanComptable(c, imf.id);

      // 8. Premier administrateur IMF (code d'acces, jamais de mot de passe)
      let codeUser = null;
      let adminId = null;
      const dejaLa = (await c.query(
        'SELECT id FROM app_user WHERE imf_id=$1 AND lower(email)=lower($2)',
        [imf.id, adminEmail])).rows[0];
      if (!dejaLa) {
        codeUser = (await c.query('SELECT fn_gen_user_code($1) AS c', [imf.id])).rows[0].c;
        adminId = (await c.query(
          `INSERT INTO app_user(imf_id, code_user, full_name, email, phone, role,
               position, position_code, must_change_password, is_active)
           VALUES ($1,$2,$3,$4,$5,'admin_imf',$6,'POS_DG',true,true)
           RETURNING id`,
          [imf.id, codeUser, adminNom, adminEmail, txt(admin.phone, 40),
           'Administrateur IMF'])).rows[0].id;
        // Les habilitations de l'administrateur IMF viennent de la matrice :
        // il dispose de tout dans SA seule institution (cloisonnement SQL).
      }

      return { imf, tenant, valeur, agences: agencesCreees, plan, structure,
               adminId, codeUser, modules: modulesDemandes };
    });

    invaliderCache(out.imf.id);
    await tracer(req, 'ONBOARDING_IMF', out.tenant.id, 'imf',
      { nom_imf: nomImf, pays, modules: out.modules, valeur_xof: out.valeur });

    // Envoi du code d'acces (facultatif : l'editeur peut aussi le copier).
    let envoi = null;
    if (b.envoyer_code !== false && out.codeUser && out.adminId) {
      try {
        envoi = await envoyerCodeAcces(out.imf.id, {
          id: out.adminId, full_name: adminNom, email: adminEmail,
          phone: txt(admin.phone, 40), code_user: out.codeUser
        }, { channel: 'creation', dispatchedBy: req.user.id, req,
             origin: 'onboarding_saas', dispatchedRole: req.user.role });
      } catch (e) { envoi = { ok: false, message: 'Envoi differe : ' + (e && e.message) }; }
    }

    res.status(201).json({
      ok: true,
      imf_id: out.imf.id,
      code_imf: out.imf.code_imf,
      tenant_id: out.tenant.id,
      statut_compte: out.structure === 'differe' ? 'ESSAI_GRATUIT' : 'ESSAI_GRATUIT',
      modules_actifs: out.modules,
      agences: out.agences,
      plan_comptable: out.plan,
      administrateur: out.codeUser
        ? { email: adminEmail, code_user: out.codeUser, mot_de_passe_a_creer: true }
        : { email: adminEmail, deja_present: true },
      envoi,
      message: "L'institution est ouverte. Transmettez le code d'acces au premier "
        + "administrateur : il creera lui-meme son mot de passe et sa double authentification."
    });
  } catch (e) {
    if (e && e.code === '23505') {
      return refus(res, 'DOUBLON', 'Un compte avec cet e-mail existe deja pour cette institution.');
    }
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/*  VAGUE 48 — REFUS PROPRE QUAND LE CLIENT (IMF) N'EXISTE PAS         */
// Les appels de test visaient des IMF fictives : la base refusait alors
// l'ecriture (cle etrangere) et la console recevait une erreur 500 au lieu
// d'un refus clair. Une seule porte, utilisee par tous les ecrans qui
// ecrivent pour un client : facture, module.
function refusClientIntrouvable(res) {
  return res.status(404).json({
    error: 'TENANT_INTROUVABLE', code: 'TENANT_INTROUVABLE',
    message: 'Ce client est introuvable : verifiez son identifiant.'
  });
}

/** Repond « client introuvable » ; renvoie null si le client existe. */
async function clientExiste(tenantId) {
  if (!tenantId) return null;
  try {
    const { rows } = await q(
      'SELECT id, imf_id, nom_imf, statut_compte FROM tenants WHERE id=$1', [tenantId]);
    return rows[0] || null;
  } catch (e) {
    // Identifiant d'une forme invalide (pas un uuid) : meme refus.
    if (String(e && e.code) === '22P02') return null;
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/*  BASCULE A CHAUD D'UN MODULE                                        */
/* ------------------------------------------------------------------ */
r.put('/tenants/:tenantId/modules/:code', ...gardien, async (req, res, next) => {
  try {
    const code = String(req.params.code || '').toUpperCase();
    if (CODE_TO_MODULE[code] === undefined) {
      return refus(res, 'MODULE_INCONNU', 'Module inconnu : ' + MODULES_SAAS.map((m) => m.code).join(', ') + '.');
    }
    const actif = req.body && (req.body.actif === false || req.body.est_actif === false) ? false : true;
    const t = await clientExiste(req.params.tenantId);
    if (!t) return refusClientIntrouvable(res);

    const prix = (await q('SELECT prix_mensuel_xof FROM catalogue_modules WHERE code_module=$1',
      [code])).rows[0];

    if (actif) {
      await q(
        `INSERT INTO tenant_modules_actifs (tenant_id, code_module, est_actif, active_le,
             desactive_le, prix_applique_xof, active_par, motif)
         VALUES ($1,$2,TRUE,now(),NULL,$3,$4,$5)
         ON CONFLICT (tenant_id, code_module)
         DO UPDATE SET est_actif=TRUE, active_le=now(), desactive_le=NULL,
                       active_par=EXCLUDED.active_par, motif=EXCLUDED.motif`,
        [t.id, code, prix ? prix.prix_mensuel_xof : null, req.user.id,
         txt(req.body && req.body.motif, 300) || 'activation_editeur']);
      const legacy = CODE_TO_MODULE[code];
      if (legacy) {
        await q(
          `INSERT INTO institution_module_subscriptions
             (institution_id, module_key, is_active, activated_at, created_by)
           VALUES ($1,$2,TRUE,CURRENT_DATE,$3)
           ON CONFLICT (institution_id, module_key)
           DO UPDATE SET is_active=TRUE, deactivated_at=NULL, updated_at=now()`,
          [t.imf_id, legacy, req.user.id]).catch(() => {});
      }
    } else {
      await q(
        `UPDATE tenant_modules_actifs SET est_actif=FALSE, desactive_le=now(),
                active_par=$3, motif=$4
          WHERE tenant_id=$1 AND code_module=$2`,
        [t.id, code, req.user.id, txt(req.body && req.body.motif, 300) || 'desactivation_editeur']);
      const legacy = CODE_TO_MODULE[code];
      if (legacy) {
        await q(
          `UPDATE institution_module_subscriptions SET is_active=FALSE,
                  deactivated_at=CURRENT_DATE, updated_at=now()
            WHERE institution_id=$1 AND module_key=$2`, [t.imf_id, legacy]).catch(() => {});
      }
    }

    // Recapitulatif du nouveau contrat (la facturation suit le catalogue).
    const somme = (await q(
      `SELECT COALESCE(SUM(c.prix_mensuel_xof),0) AS v
         FROM tenant_modules_actifs m JOIN catalogue_modules c ON c.code_module=m.code_module
        WHERE m.tenant_id=$1 AND m.est_actif=TRUE`, [t.id])).rows[0];
    await q(`UPDATE tenants SET valeur_contrat_xof=$2, updated_at=now() WHERE id=$1`,
      [t.id, somme.v]);
    await q(`UPDATE abonnements_tenants SET montant_total_periodique_xof=$2, updated_at=now()
              WHERE tenant_id=$1 AND statut='ACTIF'`, [t.id, somme.v]).catch(() => {});

    // EFFET IMMEDIAT : on vide le cache de la garde SaaS de cette IMF.
    invaliderCache(t.imf_id);
    await tracer(req, actif ? 'MODULE_ACTIVE' : 'MODULE_DESACTIVE', t.id, 'catalogue_modules',
      { code, actif });

    res.json({
      ok: true, code_module: code, est_actif: actif,
      valeur_contrat_xof: Number(somme.v),
      message: 'Module ' + code + (actif ? ' active' : ' desactive')
        + '. Effet immediat pour cette institution (sans redeploiement).'
    });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  STATUT DU CONTRAT : suspendre / reactiver / resilier               */
/* ------------------------------------------------------------------ */
r.put('/tenants/:tenantId/statut', ...gardien, async (req, res, next) => {
  try {
    const statut = String((req.body && req.body.statut) || '').toUpperCase();
    const VALIDES = ['ACTIF', 'ESSAI_GRATUIT', 'SUSPENDU_IMPAYE', 'RESILIE'];
    if (!VALIDES.includes(statut)) {
      return refus(res, 'STATUT_INVALIDE', 'Statut attendu : ' + VALIDES.join(', ') + '.');
    }
    const t = await clientExiste(req.params.tenantId);
    if (!t) return refusClientIntrouvable(res);

    await q(
      `UPDATE tenants SET statut_compte=$2,
              date_suspension = CASE WHEN $2='SUSPENDU_IMPAYE' THEN COALESCE(date_suspension, now()) ELSE NULL END,
              date_resiliation = CASE WHEN $2='RESILIE' THEN now() ELSE NULL END,
              date_expiration_essai = CASE WHEN $2='ESSAI_GRATUIT' THEN date_expiration_essai ELSE date_expiration_essai END,
              updated_at=now()
        WHERE id=$1`, [t.id, statut]);
    await q(`UPDATE abonnements_tenants SET statut=$2, updated_at=now() WHERE tenant_id=$1 AND statut<>'RESILIE'`,
      [t.id, statut === 'ACTIF' || statut === 'ESSAI_GRATUIT' ? 'ACTIF'
        : statut === 'RESILIE' ? 'RESILIE' : 'SUSPENDU']).catch(() => {});
    try {
      await q(`UPDATE imf SET status=$2::imf_status, updated_at=now() WHERE id=$1`,
        [t.imf_id, statut === 'RESILIE' ? 'suspended' : statut === 'ACTIF' ? 'active'
          : statut === 'ESSAI_GRATUIT' ? 'trial' : 'suspended']);
    } catch (e) { /* enum differente : l'etat SaaS suffit */ }

    invaliderCache(t.imf_id);
    await tracer(req, 'STATUT_TENANT', t.id, 'tenants', { statut });
    const messages = {
      ACTIF: "Compte actif : l'institution retrouve l'acces complet a ses modules.",
      ESSAI_GRATUIT: "Periode d'essai : acces limite aux modules d'essai.",
      SUSPENDU_IMPAYE: "Compte suspendu pour impaye : acces complet maintenu pendant 7 jours de grace, "
        + 'puis lecture seule (consultation et export toujours possibles).',
      RESILIE: 'Contrat resilie : consultation seule. Les donnees restent exportables.'
    };
    res.json({ ok: true, statut_compte: statut, message: messages[statut] });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  CATALOGUE DES MODULES & PRIX                                       */
/* ------------------------------------------------------------------ */
r.get('/catalogue', ...gardien, async (req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT code_module, nom, description, prix_mensuel_xof, prix_annuel_xof,
              module_historique, inclus_essai, ordre, est_actif
         FROM catalogue_modules ORDER BY ordre, code_module`);
    res.json({ modules: rows, plan_comptable: PLAN_COMPTABLE_INFO });
  } catch (e) { next(e); }
});

r.put('/catalogue/:code/prix', ...gardien, async (req, res, next) => {
  try {
    const code = String(req.params.code || '').toUpperCase();
    const mensuel = montant(req.body && req.body.prix_mensuel_xof);
    const annuel = req.body && req.body.prix_annuel_xof != null
      ? montant(req.body.prix_annuel_xof) : Math.round(mensuel * 10);
    const { rows } = await q(
      `UPDATE catalogue_modules SET prix_mensuel_xof=$2, prix_annuel_xof=$3, updated_at=now()
        WHERE code_module=$1 RETURNING code_module, prix_mensuel_xof, prix_annuel_xof`,
      [code, mensuel, annuel]);
    if (!rows.length) return refus(res, 'MODULE_INCONNU', 'Module introuvable.', 404);
    await tracer(req, 'PRIX_MODULE', null, 'catalogue_modules', { code, mensuel, annuel });
    res.json({ ok: true, module: rows[0],
      message: 'Prix enregistre. Il s applique aux prochaines factures (les factures deja emises ne changent pas).' });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/*  FACTURATION                                                        */
/* ------------------------------------------------------------------ */
r.get('/factures', ...gardien, async (req, res, next) => {
  try {
    const statut = txt(req.query && req.query.statut, 20);
    const { rows } = await q(
      `SELECT f.id, f.numero_facture, f.periode_debut, f.periode_fin,
              f.montant_ttc_xof, f.statut_paiement, f.date_emission, f.date_echeance,
              f.date_paiement, f.mode_paiement, t.nom_imf, t.sigle
         FROM factures_saas f JOIN tenants t ON t.id=f.tenant_id
        WHERE ($1::text IS NULL OR f.statut_paiement=$1)
        ORDER BY f.periode_debut DESC, f.date_emission DESC
        LIMIT 300`, [statut]);
    res.json({ factures: rows });
  } catch (e) { next(e); }
});

// Emission : une facture par mois pour un client, calculee sur ses modules
// actifs (prix catalogue). Les factures deja emises pour la periode sont
// renvoyees telles quelles (jamais de double facturation).
r.post('/factures', ...gardien, async (req, res, next) => {
  try {
    const b = req.body || {};
    const tenantId = b.tenant_id;
    // VAGUE 48 : refus propre (404) si le client n'existe pas, avant toute
    // ecriture : le test de reference visait une IMF fictive et recevait un 500.
    const t = await clientExiste(tenantId);
    if (!t) return refusClientIntrouvable(res);

    const debut = jour(b.periode_debut) || new Date().toISOString().slice(0, 8) + '01';
    const fin = jour(b.periode_fin) || debut;
    const existante = (await q(
      `SELECT id, numero_facture FROM factures_saas
        WHERE tenant_id=$1 AND periode_debut=$2`, [t.id, debut])).rows[0];
    if (existante) {
      return res.json({ ok: true, deja_emise: true, facture_id: existante.id,
        numero_facture: existante.numero_facture,
        message: 'Une facture existe deja pour cette periode.' });
    }

    const modules = (await q(
      `SELECT c.code_module, c.nom, COALESCE(m.prix_applique_xof, c.prix_mensuel_xof) AS prix
         FROM tenant_modules_actifs m JOIN catalogue_modules c ON c.code_module=m.code_module
        WHERE m.tenant_id=$1 AND m.est_actif=TRUE ORDER BY c.ordre`, [t.id])).rows;
    const lignes = modules.map((m) => ({
      libelle: m.nom, module: m.code_module, montant_xof: Number(m.prix) }));
    const ht = lignes.reduce((s, l) => s + l.montant_xof, 0);
    const tvaPct = (await q(`SELECT valeur FROM app_parametres WHERE cle='SAAS_TVA_PCT'`))
      .rows[0];
    const tva = tvaPct ? Number(tvaPct.valeur) : 18;
    const ttc = Math.round((ht * (1 + tva / 100)) * 100) / 100;

    const numero = (await q('SELECT fn_numero_facture_saas() AS n')).rows[0].n;
    const f = (await q(
      `INSERT INTO factures_saas (tenant_id, numero_facture, periode_debut, periode_fin,
           montant_ht_xof, tva_pct, montant_ttc_xof, statut_paiement,
           date_emission, date_echeance, lignes, emise_par)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'EN_ATTENTE',CURRENT_DATE,
               (CURRENT_DATE + INTERVAL '30 days')::date, $8::jsonb, $9)
       RETURNING id, numero_facture, montant_ttc_xof`,
      [t.id, numero, debut, fin, ht, tva, ttc, JSON.stringify(lignes), req.user.id])).rows[0];

    await tracer(req, 'FACTURE_EMISE', t.id, 'factures_saas', { numero, ttc });
    res.status(201).json({ ok: true, facture: f, lignes, ht_xof: ht, tva_pct: tva, ttc_xof: ttc,
      message: 'Facture ' + numero + ' emise : ' + ttc.toLocaleString('fr-FR') + ' XOF TTC.' });
  } catch (e) { next(e); }
});

r.post('/factures/:id/paiement', ...gardien, async (req, res, next) => {
  try {
    const b = req.body || {};
    const mode = String(b.mode_paiement || 'VIREMENT').toUpperCase();
    const MODES = ['VIREMENT', 'MOBILE_MONEY', 'CHEQUE', 'ESPECES'];
    if (!MODES.includes(mode)) return refus(res, 'MODE_INVALIDE', 'Mode attendu : ' + MODES.join(', ') + '.');
    const f = (await q(
      `UPDATE factures_saas SET statut_paiement='PAYEE', date_paiement=CURRENT_DATE,
              mode_paiement=$2, reference_paiement=$3, updated_at=now()
        WHERE id=$1 AND statut_paiement IN ('EN_ATTENTE','EN_RETARD')
        RETURNING id, tenant_id, numero_facture, montant_ttc_xof`,
      [req.params.id, mode, txt(b.reference, 80)])).rows[0];
    if (!f) return refus(res, 'FACTURE_NON_PAYABLE', 'Facture introuvable ou deja reglee.', 404);

    // Un impaye regle peut lever automatiquement la suspension : c'est la
    // regle commerciale (on ne laisse pas une IMF en lecture seule apres
    // encaissement). Seules les suspensions pour impaye sont concernees.
    const t = (await q('SELECT id, imf_id, statut_compte FROM tenants WHERE id=$1',
      [f.tenant_id])).rows[0];
    let reprise = null;
    if (t && t.statut_compte === 'SUSPENDU_IMPAYE' && b.reactiver !== false) {
      await q(`UPDATE tenants SET statut_compte='ACTIF', date_suspension=NULL, updated_at=now()
                WHERE id=$1`, [t.id]);
      await q(`UPDATE abonnements_tenants SET statut='ACTIF', updated_at=now()
                WHERE tenant_id=$1 AND statut='SUSPENDU'`, [t.id]).catch(() => {});
      invaliderCache(t.imf_id);
      reprise = "L'institution est reactivee automatiquement (acces complet retrouve).";
    }
    await tracer(req, 'PAIEMENT_ENCAISSE', f.tenant_id, 'factures_saas',
      { numero: f.numero_facture, montant: f.montant_ttc_xof, mode });
    res.json({ ok: true, facture: f, reprise, message: 'Paiement enregistre.' });
  } catch (e) { next(e); }
});

// Facture imprimable (PDF navigateur) : gabarit document existant.
r.get('/factures/:id.pdf', ...gardien, async (req, res, next) => {
  try {
    const row = (await q(
      `SELECT id, tenant_id FROM factures_saas WHERE id=$1`, [req.params.id])).rows[0];
    if (!row) return refus(res, 'FACTURE_INTROUVABLE', 'Facture introuvable.', 404);

    // La facture_saas contient ses propres lignes (JSONB) : le document est
    // rendu a partir de ces lignes, sans jamais toucher aux donnees de l'IMF.
    const f = (await q(
      `SELECT f.*, t.nom_imf, t.sigle, im.code_imf, im.email, im.phone_main
         FROM factures_saas f JOIN tenants t ON t.id=f.tenant_id
         JOIN imf im ON im.id=t.imf_id WHERE f.id=$1`, [row.id])).rows[0];
    if (!f) return refus(res, 'FACTURE_INTROUVABLE', 'Facture introuvable.', 404);
    setDocumentCsp(res);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(factureHtml(f));
  } catch (e) { next(e); }
});

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function xof(v) {
  return Number(v || 0).toLocaleString('fr-FR', { minimumFractionDigits: 0 }) + ' XOF';
}

function dateFr(v) {
  const s = String(v || '').slice(0, 10);
  const [a, m, j] = s.split('-');
  return j ? j + '/' + m + '/' + a : '';
}

/** Document imprimable d'une facture d'abonnement (HTML autonome). */
function factureHtml(f) {
  let lignes = [];
  try { lignes = Array.isArray(f.lignes) ? f.lignes : JSON.parse(f.lignes || '[]'); }
  catch (e) { lignes = []; }
  const rows = lignes.map((l) =>
    '<tr><td>' + esc(l.libelle || l.module || '') + '</td><td class="n">' + xof(l.montant_xof) + '</td></tr>').join('');
  return '<!doctype html><html lang="fr"><head><meta charset="utf-8">'
    + '<title>Facture ' + esc(f.numero_facture) + '</title>'
    + '<style>@page{size:A4;margin:16mm}body{font:12px/1.5 Georgia,serif;color:#12203a}'
    + 'h1{font-size:19px;margin:0 0 2px}.muted{color:#5b6b86}table{width:100%;border-collapse:collapse;margin-top:14px}'
    + 'th,td{padding:7px 8px;border-bottom:1px solid #d7dee9;text-align:left}'
    + 'th{background:#f3f6fa;font-size:11px;text-transform:uppercase;letter-spacing:.4px}'
    + '.n{text-align:right;white-space:nowrap}.tot{font-size:14px;font-weight:bold}'
    + '.band{display:flex;justify-content:space-between;gap:20px;margin-bottom:14px}'
    + '.box{border:1px solid #d7dee9;border-radius:8px;padding:10px 12px}'
    + 'footer{margin-top:26px;font-size:10px;color:#5b6b86}</style></head><body>'
    + '<div class="band"><div><h1>teebo</h1><div class="muted">Plateforme SaaS de gestion IMF / SFD</div>'
    + '<div class="muted">Zone UEMOA — montants en XOF</div></div>'
    + '<div style="text-align:right"><div class="tot">FACTURE D\'ABONNEMENT</div>'
    + '<div>' + esc(f.numero_facture) + '</div>'
    + '<div class="muted">Emise le ' + dateFr(f.date_emission) + '</div>'
    + '<div class="muted">Echeance le ' + dateFr(f.date_echeance) + '</div></div></div>'
    + '<div class="box"><strong>Client</strong><br>' + esc(f.nom_imf)
    + '<br><span class="muted">Code IMF : ' + esc(f.code_imf) + '</span>'
    + '<br><span class="muted">' + esc(f.email || '') + '</span></div>'
    + '<p class="muted">Periode facturee : du ' + dateFr(f.periode_debut)
    + ' au ' + dateFr(f.periode_fin) + '</p>'
    + '<table><thead><tr><th>Designation</th><th class="n">Montant</th></tr></thead><tbody>'
    + (rows || '<tr><td colspan="2" class="muted">Aucune ligne</td></tr>')
    + '<tr><td>Total HT</td><td class="n">' + xof(f.montant_ht_xof) + '</td></tr>'
    + '<tr><td>TVA ' + esc(f.tva_pct) + ' %</td><td class="n">'
    + xof(Number(f.montant_ttc_xof) - Number(f.montant_ht_xof)) + '</td></tr>'
    + '<tr class="tot"><td>Total TTC</td><td class="n">' + xof(f.montant_ttc_xof) + '</td></tr>'
    + '</tbody></table>'
    + '<p>Statut : <strong>' + esc(f.statut_paiement) + '</strong>'
    + (f.date_paiement ? ' — reglee le ' + dateFr(f.date_paiement) : '') + '</p>'
    + '<footer>teebo — facture d\'abonnement generee automatiquement. '
    + 'TVA appliquee selon le taux configure (a ajuster par pays).</footer>'
    + '</body></html>';
}

/* ------------------------------------------------------------------ */
/*  JOURNAL DE L'EDITEUR                                              */
/* ------------------------------------------------------------------ */
r.get('/journal', ...gardien, async (req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT l.id, l.action, l.tenant_id, l.cible, l.details, l.ip, l.created_at,
              u.full_name AS editeur, t.nom_imf
         FROM editeur_acces_log l
         LEFT JOIN app_user u ON u.id=l.editeur_id
         LEFT JOIN tenants t ON t.id=l.tenant_id
        ORDER BY l.created_at DESC LIMIT 200`);
    res.json({ journal: rows });
  } catch (e) {
    res.json({ journal: [] });
  }
});

/* ------------------------------------------------------------------ */
/*  Ce que l'editeur n'a PAS le droit de voir (rappel dans l'API)      */
/* ------------------------------------------------------------------ */
r.get('/perimetre', ...gardien, (_req, res) => {
  res.json({
    role: 'SUPER_ADMIN_SAAS',
    autorise: PERIMETRE_EDITEUR.autorise,
    interdit: PERIMETRE_EDITEUR.interdit,
    tables_interdites: PERIMETRE_EDITEUR.tables_interdites,
    message: "Le role editeur administre la plateforme (contrats, modules, factures). "
      + "Aucune donnee d'adherent n'est lisible : ni client, ni solde, ni dossier de "
      + "credit, ni declaration CENTIF. Ce cloisonnement est verifie automatiquement."
  });
});

export default r;
