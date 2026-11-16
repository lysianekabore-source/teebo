-- =========================================================================
-- teebo — VAGUE 36 — RESTRICTION IMMÉDIATE « COLLECTE SEULE »
-- =========================================================================
-- OBJECTIF (demande de l'administrateur teebo)
--   Forcer une IMF en période d'essai à n'utiliser QUE la brique
--   Collecte & tontines, et couper INSTANTANÉMENT le reste (crédit,
--   comptabilité, conformité).
--
-- MOYENS
--   1. Un état de restriction porté par la base, pour ne jamais dépendre
--      d'un simple réglage de menu (un menu masqué ne protège rien).
--   2. Une fonction fn_restrict_imf_to_collecte(imf, acteur) qui fait tout
--      dans UNE SEULE transaction : tous les modules coupés, la collecte
--      rétablie en ESSAI, l'historique d'essai préservé, la trace d'audit
--      écrite, puis synchronisation de institution_features (la config
--      renvoyée à l'écran, donc les menus, change dans la seconde).
--   3. Des vues de lecture immédiate (sans cache) : le middleware et
--      l'écran d'abonnement lisent toujours l'état réel.
--   4. Un journal des restrictions (qui a restreint, quand, pourquoi).
--
-- SCRIPT ADDITIF ET RÉEXÉCUTABLE : il ne supprime aucune donnée et peut
-- être rejoué sans risque (contrôles IF NOT EXISTS / CREATE OR REPLACE).
-- Convention montants : NUMERIC(12,2), jamais de flottant.
-- =========================================================================

BEGIN;

-- -------------------------------------------------------------------------
-- 1. TABLE DE SUIVI DES RESTRICTIONS
--    Une ligne = une décision de restriction (ou de levée) prise sur une IMF.
--    On garde tout l'historique : le contrôleur BCEAO doit pouvoir savoir
--    qui a coupé quoi, et quand.
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS imf_access_restrictions (
    id                  BIGSERIAL PRIMARY KEY,
    institution_id      UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    restriction_code    VARCHAR(50) NOT NULL DEFAULT 'COLLECTE_ONLY',
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    reason              TEXT,
    applied_by          UUID,
    applied_by_role     VARCHAR(30),
    applied_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    lifted_by           UUID,
    lifted_at           TIMESTAMPTZ,
    lifted_reason       TEXT,
    -- Photographie des modules coupés, pour pouvoir les rétablir à l'identique.
    snapshot_modules    JSONB
);
CREATE INDEX IF NOT EXISTS idx_iar_imf
  ON imf_access_restrictions (institution_id, is_active);

COMMENT ON TABLE imf_access_restrictions IS
  'Historique des restrictions d’accès imposées à une IMF par l’administrateur teebo (ex. essai limité à la collecte).';

-- -------------------------------------------------------------------------
-- 2. COLONNES DE TRAÇABILITÉ SUR LES SOUSCRIPTIONS
--    restricted_at / restriction_code : posés par la restriction, retirés
--    lors d'une réactivation volontaire du module.
-- -------------------------------------------------------------------------
ALTER TABLE institution_module_subscriptions
  ADD COLUMN IF NOT EXISTS restricted_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS restriction_code   VARCHAR(50),
  ADD COLUMN IF NOT EXISTS deactivated_reason VARCHAR(50);

COMMENT ON COLUMN institution_module_subscriptions.deactivated_reason IS
  'Pourquoi le module est coupé : RESTRICTION_TEEBO (décision éditeur), IMF_CHOICE (désactivé par l’IMF), TRIAL_EXPIRED.';

-- -------------------------------------------------------------------------
-- 3. VUES DE LECTURE IMMÉDIATE
--    Elles ne mettent rien en cache : chaque appel relit la table. Le
--    middleware « checkModuleActivation » et /institution/config voient donc
--    l'effet de la restriction à la requête suivante, sans redéploiement.
-- -------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_imf_module_access AS
SELECT s.institution_id,
       s.module_key,
       s.is_active,
       s.is_trial,
       s.trial_end_date,
       s.deactivated_reason,
       s.restricted_at,
       -- Un module est UTILISABLE si actif, et si son essai n'est pas échu.
       (s.is_active
        AND NOT (s.is_trial AND s.trial_end_date IS NOT NULL
                 AND s.trial_end_date < CURRENT_DATE)) AS is_usable
  FROM institution_module_subscriptions s;

CREATE OR REPLACE VIEW v_imf_access_state AS
SELECT im.id AS institution_id,
       im.code_imf,
       im.name,
       im.status AS imf_status,
       COALESCE(r.is_active, FALSE)          AS restricted_collecte_only,
       r.applied_at,
       r.reason,
       r.applied_by_role,
       COALESCE((
         SELECT array_agg(a.module_key ORDER BY a.module_key)
           FROM v_imf_module_access a
          WHERE a.institution_id = im.id AND a.is_usable) , ARRAY[]::varchar[]) AS modules_utilisables
  FROM imf im
  LEFT JOIN imf_access_restrictions r
         ON r.institution_id = im.id AND r.is_active = TRUE;

-- -------------------------------------------------------------------------
-- 4. FONCTION DE RESTRICTION (le cœur de la vague)
--    fn_restrict_imf_to_collecte(p_imf_id, p_actor_id, p_actor_role, p_reason)
--      • coupe TOUS les modules sauf MODULE_COLLECTE_TONTINE ;
--      • maintient/crée la collecte avec is_active = TRUE et is_trial = TRUE ;
--      • n'écrase PAS trial_used / trial_started_at (historique d'essai) ;
--      • écrit la trace dans audit_log (action IMF_RESTRICTION_COLLECTE_ONLY)
--        + une ligne dans imf_access_restrictions ;
--      • synchronise institution_features (menus de l'écran) ;
--      • renvoie un compte rendu JSON.
--    Tout échec annule l'ensemble (la fonction est appelée dans une
--    transaction par le serveur ; ici BEGIN ... EXCEPTION protège le cas
--    d'un appel SQL direct).
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_restrict_imf_to_collecte(
    p_imf_id      UUID,
    p_actor_id    UUID DEFAULT NULL,
    p_actor_role  TEXT DEFAULT NULL,
    p_reason      TEXT DEFAULT 'Essai limité au module Collecte & tontines'
) RETURNS JSONB AS $$
DECLARE
    v_collecte      CONSTANT VARCHAR := 'MODULE_COLLECTE_TONTINE';
    v_nb_coupes     INTEGER := 0;
    v_avant         JSONB;
    v_snapshot      JSONB;
    v_imf_status    TEXT;
    v_modules_ok    JSONB;
BEGIN
    -- 0. L'IMF doit exister : aucune écriture orpheline.
    SELECT im.status::text INTO v_imf_status FROM imf im WHERE im.id = p_imf_id;
    IF v_imf_status IS NULL THEN
        RAISE EXCEPTION 'Institution introuvable : %', p_imf_id
          USING ERRCODE = 'no_data_found';
    END IF;

    -- Photographie AVANT (pour l'audit et une éventuelle levée de restriction).
    SELECT COALESCE(jsonb_object_agg(module_key, jsonb_build_object(
             'is_active', is_active, 'is_trial', is_trial,
             'trial_end_date', trial_end_date)), '{}'::jsonb)
      INTO v_avant
      FROM institution_module_subscriptions
     WHERE institution_id = p_imf_id;

    -- 1. Couper tous les modules SAUF la collecte.
    UPDATE institution_module_subscriptions s
       SET is_active          = FALSE,
           is_trial           = FALSE,
           trial_end_date     = NULL,
           deactivated_at     = COALESCE(s.deactivated_at, CURRENT_DATE),
           restricted_at      = now(),
           restriction_code   = 'COLLECTE_ONLY',
           deactivated_reason = COALESCE(s.deactivated_reason, 'RESTRICTION_TEEBO'),
           updated_at         = now()
     WHERE s.institution_id = p_imf_id
       AND s.module_key <> v_collecte
       AND (s.is_active = TRUE OR s.restricted_at IS NULL);
    GET DIAGNOSTICS v_nb_coupes = ROW_COUNT;

    -- 2. La collecte reste active et marquée en essai (ligne créée si absente).
    --    ON CONFLICT ne touche volontairement NI trial_used NI trial_started_at :
    --    la restriction ne consomme pas et ne réinitialise pas l'historique.
    INSERT INTO institution_module_subscriptions
        (institution_id, module_key, is_active, activated_at,
         is_trial, trial_end_date, created_by, deactivated_reason)
    VALUES
        (p_imf_id, v_collecte, TRUE, CURRENT_DATE,
         TRUE, GREATEST(CURRENT_DATE + 30, CURRENT_DATE), p_actor_id, NULL)
    ON CONFLICT (institution_id, module_key) DO UPDATE SET
        is_active          = TRUE,
        is_trial           = TRUE,
        trial_end_date     = COALESCE(institution_module_subscriptions.trial_end_date,
                                      GREATEST(CURRENT_DATE + 30, CURRENT_DATE)),
        deactivated_at     = NULL,
        deactivated_reason = NULL,
        restricted_at      = NULL,
        restriction_code   = NULL,
        updated_at         = now();

    -- 3. Recalage des menus (institution_features) : la config renvoyée au
    --    navigateur est recalée sur la vérité des souscriptions, sinon un
    --    module coupé resterait visible à l'écran de l'IMF.
    BEGIN
        UPDATE institution_features f
           SET module_collecte_tontine     = TRUE,
               module_dossier_credit       = FALSE,
               module_compliance_kyc       = FALSE,
               module_comptabilite_avancee = FALSE,
               updated_at                  = now(),
               updated_by                  = COALESCE(p_actor_id, f.updated_by)
         WHERE f.institution_id = p_imf_id;
        IF NOT FOUND THEN
            INSERT INTO institution_features
                (institution_id, module_collecte_tontine, module_dossier_credit,
                 module_compliance_kyc, module_comptabilite_avancee, updated_by)
            VALUES (p_imf_id, TRUE, FALSE, FALSE, FALSE, p_actor_id)
            ON CONFLICT (institution_id) DO UPDATE SET
                module_collecte_tontine     = TRUE,
                module_dossier_credit       = FALSE,
                module_compliance_kyc       = FALSE,
                module_comptabilite_avancee = FALSE,
                updated_at                  = now();
        END IF;
    EXCEPTION WHEN undefined_table OR undefined_column THEN
        -- Base plus ancienne que la vague 32 : on n'échoue pas pour autant,
        -- le middleware lit de toute façon les souscriptions.
        RAISE WARNING 'institution_features absente ou incomplète : menus non recalés.';
    END;

    -- 4. Historique des restrictions (une seule ligne active par IMF).
    UPDATE imf_access_restrictions
       SET is_active = FALSE, lifted_at = now(),
           lifted_reason = 'Remplacée par une nouvelle restriction'
     WHERE institution_id = p_imf_id AND is_active = TRUE;

    INSERT INTO imf_access_restrictions
        (institution_id, restriction_code, is_active, reason,
         applied_by, applied_by_role, snapshot_modules)
    VALUES
        (p_imf_id, 'COLLECTE_ONLY', TRUE, p_reason,
         p_actor_id, p_actor_role, v_avant)
    RETURNING jsonb_build_object(
        'restriction_id', id,
        'modules_avant', COALESCE(v_avant, '{}'::jsonb)
    ) INTO v_snapshot;

    -- 5. Journal d'événement (table audit_log de la base).
    INSERT INTO audit_log (imf_id, actor_id, action, entity, entity_id, payload)
    VALUES (p_imf_id, p_actor_id, 'IMF_RESTRICTION_COLLECTE_ONLY',
            'institution_module_subscriptions', p_imf_id::text,
            jsonb_build_object(
                'reason', p_reason,
                'actor_role', p_actor_role,
                'modules_coupes', v_nb_coupes,
                'module_autorise', v_collecte,
                'imf_status', v_imf_status,
                'restriction_id', (v_snapshot->>'restriction_id'),
                'modules_avant', (v_snapshot->'modules_avant')));

    -- 6. Compte rendu : ce que l'API renvoie à la console.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'module_key', module_key, 'is_usable', is_usable)), '[]'::jsonb)
      INTO v_modules_ok
      FROM v_imf_module_access
     WHERE institution_id = p_imf_id;

    RETURN jsonb_build_object(
        'institution_id', p_imf_id,
        'imf_status', v_imf_status,
        'restriction', 'COLLECTE_ONLY',
        'modules_coupes', v_nb_coupes,
        'module_autorise', v_collecte,
        'modules', v_modules_ok,
        'applied_at', now());
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION fn_restrict_imf_to_collecte(UUID, UUID, TEXT, TEXT) IS
  'Coupe tous les modules d’une IMF sauf la collecte, qui reste en essai. Écrit l’audit et recalcule les menus.';

-- -------------------------------------------------------------------------
-- 5. FONCTION DE LEVÉE (retour arrière)
--    fn_lift_imf_restriction(imf, acteur…) réactive les modules coupés par
--    la restriction et remet l'état d'avant (photo prise à la restriction).
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_lift_imf_restriction(
    p_imf_id     UUID,
    p_actor_id   UUID DEFAULT NULL,
    p_reason     TEXT DEFAULT 'Restriction levée'
) RETURNS JSONB AS $$
DECLARE
    v_rest   imf_access_restrictions%ROWTYPE;
    v_key    TEXT;
    v_info   JSONB;
    v_nb     INTEGER := 0;
BEGIN
    SELECT * INTO v_rest
      FROM imf_access_restrictions
     WHERE institution_id = p_imf_id AND is_active = TRUE
     ORDER BY applied_at DESC LIMIT 1;

    IF v_rest.id IS NULL THEN
        RETURN jsonb_build_object('lifted', FALSE,
            'message', 'Aucune restriction active sur cette IMF.');
    END IF;

    -- Réactivation des modules présents dans la photo d'avant.
    FOR v_key, v_info IN
        SELECT key, value FROM jsonb_each(COALESCE(v_rest.snapshot_modules, '{}'::jsonb))
    LOOP
        IF (v_info->>'is_active')::boolean IS TRUE THEN
            UPDATE institution_module_subscriptions
               SET is_active          = TRUE,
                   restricted_at      = NULL,
                   restriction_code   = NULL,
                   deactivated_reason = NULL,
                   deactivated_at     = NULL,
                   updated_at         = now()
             WHERE institution_id = p_imf_id AND module_key = v_key;
            v_nb := v_nb + 1;
        END IF;
    END LOOP;

    UPDATE imf_access_restrictions
       SET is_active = FALSE, lifted_at = now(),
           lifted_by = p_actor_id, lifted_reason = p_reason
     WHERE id = v_rest.id;

    INSERT INTO audit_log (imf_id, actor_id, action, entity, entity_id, payload)
    VALUES (p_imf_id, p_actor_id, 'IMF_RESTRICTION_LIFTED',
            'institution_module_subscriptions', p_imf_id::text,
            jsonb_build_object('reason', p_reason, 'modules_reactives', v_nb,
                               'restriction_id', v_rest.id));

    RETURN jsonb_build_object('lifted', TRUE, 'modules_reactives', v_nb,
                              'restriction_id', v_rest.id);
END;
$$ LANGUAGE plpgsql;

COMMIT;

-- =========================================================================
-- REMARQUES D'EXPLOITATION
-- =========================================================================
-- 1. Le serveur applique ce fichier automatiquement au démarrage, dans sa
--    propre transaction : un échec n'empêche pas les schémas suivants.
-- 2. Application manuelle à toutes les IMF en essai (si besoin) :
--      SELECT fn_restrict_imf_to_collecte(im.id, NULL, 'teebo_admin',
--               'Essai limité au module Collecte & tontines')
--        FROM imf im
--       WHERE im.status = 'trial';
-- 3. Pour vérifier l'état après coup :
--      SELECT * FROM v_imf_access_state ORDER BY restricted_collecte_only DESC;
-- 4. Le déclencheur d'essai unique (trg_module_trial_once, vague 35)
--    s'applique aussi ici : si la collecte a DÉJÀ consommé son essai, la
--    base refusera de la REMETTRE en essai et la passera en payant. C'est
--    le comportement voulu : on ne redonne jamais un deuxième essai.
-- =========================================================================
