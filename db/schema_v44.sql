-- ===========================================================================
-- teebo — VAGUE 44 : BASCULE AUTOMATIQUE DES IMF EN ESSAI
-- ===========================================================================
-- CE QUE CE SCRIPT AJOUTE (rien n'est supprimé, rien n'est renommé)
--
--   1. LA RÈGLE, ÉCRITE DANS LA BASE :
--      une IMF dont le statut global est « Essai » (imf.status = 'trial')
--      n'a accès QU'AU module Collecte & tontines. Ce module est ouvert en
--      essai gratuit ; tous les autres sont coupés.
--
--   2. LE DÉCLENCHEUR DU PROCHAIN ACCÈS :
--      fn_appliquer_essai_collecte(p_imf, p_par, p_origine) est appelée
--      AUTOMATIQUEMENT par le serveur à chaque connexion réussie (et à
--      l'activation du compte). Elle est IDEMPOTENTE : si l'IMF est déjà sur
--      Collecte seule et déjà en essai sur ce module, elle ne fait RIEN.
--      Relancer la connexion dix fois de suite ne crée aucun doublon.
--
--   3. LE RESPECT DE LA RÈGLE « UN SEUL ESSAI PAR MODULE » (vague 35) :
--      si la Collecte a déjà consommé son essai gratuit, le module est laissé
--      en PAYANT (jamais de second essai offert). Le reste est quand même
--      coupé : l'IMF garde exactement un module ouvert.
--
--   4. LA TRACE : une ligne d'audit ESSAI_BASCULE_COLLECTE est écrite
--      uniquement quand quelque chose change réellement.
--
--   5. fn_imfs_en_essai_a_basculer() : la liste des IMF en essai encore
--      ouvertes sur d'autres modules (pour contrôle avant/après déploiement).
--
-- SCRIPT ADDITIF ET RÉEXÉCUTABLE (CREATE OR REPLACE uniquement).
-- Prérequis : v32 (institution_features), v33 (souscriptions), v35 (colonne
-- trial_used), v36 (fonction de restriction). Si la vague 36 n'est pas passée,
-- la règle s'applique quand même (repli interne, sans dépendre du v36).
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. LA RÈGLE — APPLIQUER L'ESSAI « COLLECTE & TONTINES » À UNE IMF
-- ---------------------------------------------------------------------------
-- p_par     : auteur de l'action (NULL = automatique, au nom du système)
-- p_origine : 'LOGIN' | 'ACTIVATION' | 'MIGRATION' | 'MANUEL' (traçabilité)
-- Renvoie : { applique: bool, deja: bool, essai_collecte: bool,
--             modules_coupes: int, motif: text }
CREATE OR REPLACE FUNCTION fn_appliquer_essai_collecte(
    p_imf     UUID,
    p_par     UUID DEFAULT NULL,
    p_origine TEXT DEFAULT 'LOGIN')
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_collecte   CONSTANT TEXT := 'MODULE_COLLECTE_TONTINE';
    v_status     TEXT;
    v_fin_essai  DATE;
    v_coupes     INT  := 0;
    v_essai      BOOLEAN := FALSE;
    v_deja       BOOLEAN := FALSE;
    v_trial_used BOOLEAN := FALSE;
    v_finis      INT  := 0;
BEGIN
    -- Verrou sur la ligne IMF : deux connexions simultanées de la même IMF
    -- passent l'une après l'autre, jamais en même temps (aucun doublon).
    PERFORM 1 FROM imf WHERE id = p_imf FOR UPDATE;

    -- L'IMF doit exister.
    SELECT status::text,
           GREATEST(COALESCE(trial_ends_at::date, CURRENT_DATE + 30), CURRENT_DATE)
      INTO v_status, v_fin_essai
      FROM imf WHERE id = p_imf;

    IF v_status IS NULL THEN
        RETURN jsonb_build_object('applique', FALSE, 'deja', FALSE,
            'motif', 'imf_introuvable');
    END IF;

    -- Seule une IMF EN ESSAI est basculée. Une IMF active, suspendue ou
    -- en attente garde exactement ses droits actuels : aucune surprise.
    IF v_status <> 'trial' THEN
        RETURN jsonb_build_object('applique', FALSE, 'deja', FALSE,
            'motif', 'pas_en_essai', 'statut', v_status);
    END IF;

    -- Déjà basculée ? (collecte active + un seul module utilisable)
    SELECT COUNT(*) = 1
           AND COUNT(*) FILTER (WHERE module_key = v_collecte) = 1
      INTO v_deja
      FROM institution_module_subscriptions
     WHERE institution_id = p_imf AND is_active = TRUE;

    -- Essai de la Collecte déjà consommé ? (règle v35 : un seul essai)
    SELECT COALESCE(bool_or(
             (module_key = v_collecte
              AND (trial_used = TRUE OR (is_trial = FALSE AND trial_end_date IS NOT NULL)))
           ), FALSE)
      INTO v_trial_used
      FROM institution_module_subscriptions
     WHERE institution_id = p_imf;

    -- 1. Le module Collecte & tontines : ouvert en essai (ou en payant).
    INSERT INTO institution_module_subscriptions
        (institution_id, module_key, is_active, activated_at, is_trial,
         trial_end_date, trial_started_at, created_by)
    VALUES (p_imf, v_collecte, TRUE, CURRENT_DATE,
            NOT v_trial_used, CASE WHEN v_trial_used THEN NULL ELSE v_fin_essai END,
            CURRENT_DATE, p_par)
    ON CONFLICT (institution_id, module_key) DO UPDATE SET
        is_active        = TRUE,
        activated_at     = CASE WHEN institution_module_subscriptions.is_active = FALSE
                                THEN CURRENT_DATE
                                ELSE institution_module_subscriptions.activated_at END,
        is_trial         = (NOT v_trial_used),
        trial_end_date   = CASE WHEN v_trial_used THEN institution_module_subscriptions.trial_end_date
                                ELSE COALESCE(institution_module_subscriptions.trial_end_date, v_fin_essai) END,
        trial_started_at = COALESCE(institution_module_subscriptions.trial_started_at, CURRENT_DATE),
        deactivated_at   = NULL,
        deactivated_reason = NULL,
        updated_at       = now();

    SELECT is_trial INTO v_essai
      FROM institution_module_subscriptions
     WHERE institution_id = p_imf AND module_key = v_collecte;

    -- 2. Tous les AUTRES modules sont coupés (sans rien effacer : on datte et
    --    on motive, la souscription reste consultable et réactivable).
    WITH coupes AS (
        UPDATE institution_module_subscriptions
           SET is_active        = FALSE,
               deactivated_at   = COALESCE(deactivated_at, CURRENT_DATE),
               deactivated_reason = COALESCE(NULLIF(deactivated_reason, ''),
                                             'Essai : accès limité au module Collecte & tontines'),
               restriction_code = COALESCE(restriction_code, 'RESTRICTION_COLLECTE_ONLY'),
               updated_at       = now()
         WHERE institution_id = p_imf
           AND module_key <> v_collecte
           AND is_active = TRUE
        RETURNING 1
    )
    SELECT COUNT(*) INTO v_coupes FROM coupes;

    -- 3. Les essais des autres modules sont clôturés (fin d'essai = aujourd'hui),
    --    pour que la facturation ne calcule aucune ligne d'essai en cours sur
    --    un module que l'IMF n'utilise plus. Les montants déjà facturés ne
    --    bougent pas : les factures générées sont verrouillées (vague 35).
    WITH finis AS (
        UPDATE institution_module_subscriptions
           SET trial_end_date = LEAST(COALESCE(trial_end_date, CURRENT_DATE), CURRENT_DATE),
               updated_at     = now()
         WHERE institution_id = p_imf
           AND module_key <> v_collecte
           AND is_trial = TRUE
        RETURNING 1
    )
    SELECT COUNT(*) INTO v_finis FROM finis;

    -- 4. Les menus de l'écran : une seule brique visible (vague 32).
    IF to_regclass('public.institution_features') IS NOT NULL THEN
        INSERT INTO institution_features
            (institution_id, module_collecte_tontine, module_dossier_credit,
             module_compliance_kyc, module_comptabilite_avancee, updated_by)
        VALUES (p_imf, TRUE, FALSE, FALSE, FALSE, p_par)
        ON CONFLICT (institution_id) DO UPDATE SET
            module_collecte_tontine     = TRUE,
            module_dossier_credit       = FALSE,
            module_compliance_kyc       = FALSE,
            module_comptabilite_avancee = FALSE,
            updated_by                  = COALESCE(p_par, institution_features.updated_by),
            updated_at                  = now();
    END IF;

    -- 5. Trace : uniquement si la situation a réellement changé.
    IF v_coupes > 0 OR NOT v_deja OR v_finis > 0 THEN
        INSERT INTO audit_log (imf_id, actor_id, action, entity, entity_id, payload)
        VALUES (p_imf, p_par, 'ESSAI_BASCULE_COLLECTE',
                'institution_module_subscriptions', p_imf::text,
                jsonb_build_object(
                    'origine', COALESCE(p_origine, 'LOGIN'),
                    'module_ouvert', v_collecte,
                    'en_essai', v_essai,
                    'fin_essai', v_fin_essai,
                    'modules_coupes', v_coupes,
                    'essais_clotures', v_finis,
                    'deja_en_place', v_deja,
                    'essai_collecte_deja_utilise', v_trial_used));
    END IF;

    RETURN jsonb_build_object(
        'applique', TRUE,
        'deja', v_deja AND v_coupes = 0 AND v_finis = 0,
        'essai_collecte', v_essai,
        'fin_essai', v_fin_essai,
        'modules_coupes', v_coupes,
        'essais_clotures', v_finis,
        'essai_deja_utilise', v_trial_used);
END;
$$;

COMMENT ON FUNCTION fn_appliquer_essai_collecte(UUID, UUID, TEXT) IS
  'Essai : bascule une IMF (statut trial) sur le seul module Collecte & tontines. Appelée à chaque connexion, idempotente, sans effet sur une IMF active.';

-- ---------------------------------------------------------------------------
-- 2. LA MÊME RÈGLE POUR TOUTES LES IMF EN ESSAI (déploiement / rattrapage)
-- ---------------------------------------------------------------------------
-- Utile une seule fois après déploiement, puis en contrôle. Ne touche QUE les
-- IMF dont le statut est « trial ».
CREATE OR REPLACE FUNCTION fn_basculer_imfs_en_essai(
    p_par UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_imf   RECORD;
    v_out   JSONB;
    v_n     INT := 0;
    v_coupes INT := 0;
BEGIN
    FOR v_imf IN SELECT id, code_imf FROM imf WHERE status = 'trial' ORDER BY code_imf LOOP
        BEGIN
            v_out := fn_appliquer_essai_collecte(v_imf.id, p_par, 'MIGRATION');
            v_n := v_n + 1;
            v_coupes := v_coupes + COALESCE((v_out->>'modules_coupes')::int, 0);
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'IMF % ignorée : %', v_imf.code_imf, SQLERRM;
        END;
    END LOOP;
    RETURN jsonb_build_object('imfs_traitees', v_n, 'modules_coupes', v_coupes);
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. CONTRÔLE : IMF EN ESSAI ENCORE OUVERTE SUR PLUSIEURS MODULES
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_imfs_essai_a_basculer AS
SELECT i.id,
       i.code_imf,
       i.name,
       i.status::text                                   AS statut_imf,
       i.trial_ends_at,
       COUNT(s.subscription_id) FILTER (WHERE s.is_active) AS modules_ouverts,
       COALESCE(array_agg(s.module_key ORDER BY s.module_key)
                FILTER (WHERE s.is_active), '{}')             AS modules_actifs
  FROM imf i
  LEFT JOIN institution_module_subscriptions s ON s.institution_id = i.id
 WHERE i.status = 'trial'
 GROUP BY i.id, i.code_imf, i.name, i.status, i.trial_ends_at
HAVING COUNT(s.subscription_id) FILTER (WHERE s.is_active) <> 1
    OR COALESCE(bool_or(s.module_key = 'MODULE_COLLECTE_TONTINE'
                        AND s.is_active), FALSE) = FALSE;

COMMENT ON VIEW v_imfs_essai_a_basculer IS
  'IMF en essai qui ne sont pas (encore) sur le seul module Collecte & tontines. Après connexion, cette liste doit être vide.';

COMMIT;

-- ===========================================================================
-- UTILISATION (à lancer à la main, dans cet ordre, si besoin)
-- ===========================================================================
--  a) Voir avant :   SELECT * FROM v_imfs_essai_a_basculer;
--  b) Appliquer à toutes les IMF en essai (une seule fois) :
--                     SELECT fn_basculer_imfs_en_essai(NULL);
--  c) Une IMF précise : SELECT fn_appliquer_essai_collecte('<uuid>', NULL, 'MANUEL');
--  d) Vérifier après : SELECT * FROM v_imfs_essai_a_basculer;  -- doit être vide
--  e) Qui a été basculé :
--     SELECT created_at, imf_id, payload FROM audit_log
--      WHERE action = 'ESSAI_BASCULE_COLLECTE' ORDER BY created_at DESC LIMIT 50;
-- ===========================================================================
