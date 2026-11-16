-- =========================================================================
-- teebo — migration_restrict_essai.sql
-- RESTRICTION « COLLECTE SEULE » POUR LES IMF EN ESSAI
-- =========================================================================
-- SCRIPT AUTONOME ET ADDITIF — peut être lancé plusieurs fois.
-- Prérequis : schémas de base + v33 (abonnements) + v32 (institution_features).
--             La vague 36 (schema_v36.sql) doit avoir créé les deux
--             fonctions fn_restrict_imf_to_collecte / fn_lift_imf_restriction.
--             Le serveur applique v36 tout seul ; sinon lancez v36 d'abord.
--
-- CE QUE FAIT CE SCRIPT
--   Pour CHAQUE IMF dont le statut global est « Essai » (imf.status = 'trial',
--   ou subscription.status = 'trial' quand la table existe) :
--     1. le module MODULE_COLLECTE_TONTINE est maintenu — ou créé — avec
--        is_active = TRUE et is_trial = TRUE ;
--     2. TOUS les autres modules passent à is_active = FALSE ;
--     3. les menus de l'écran sont recalés (une seule brique visible) ;
--     4. une trace d'audit IMF_RESTRICTION_COLLECTE_ONLY est écrite.
--
-- ⚠ PRUDENCE — LIRE AVANT D'EXÉCUTER
--   • La colonne « is_trial » n'est PAS remise à TRUE pour un module qui a
--     déjà consommé son essai : la règle « un seul essai par module »
--     (vague 35) reste prioritaire. Le script signale ces cas en NOTICE.
--   • Mode vérification : passez la variable v_dry_run à TRUE (défaut) pour
--     VOIR ce qui serait modifié, sans rien écrire. Mettez FALSE pour
--     appliquer réellement.
-- =========================================================================

BEGIN;

DO $$
DECLARE
    v_dry_run   BOOLEAN := TRUE;        -- ← FALSE pour appliquer réellement
    v_collecte  CONSTANT VARCHAR := 'MODULE_COLLECTE_TONTINE';
    v_imf       RECORD;
    v_nb_imf    INTEGER := 0;
    v_nb_coupes INTEGER := 0;
    v_nb_crees  INTEGER := 0;
    v_essai_refuse JSONB := '[]'::jsonb;
    v_essai_deja   JSONB;
BEGIN
    -- Sécurité : la fonction du lot v36 doit exister.
    IF to_regprocedure('fn_restrict_imf_to_collecte(uuid,uuid,text,text)') IS NULL THEN
        RAISE EXCEPTION
          'Fonction fn_restrict_imf_to_collecte absente : appliquez d’abord db/schema_v36.sql.';
    END IF;

    FOR v_imf IN
        SELECT im.id, im.code_imf, im.name, im.status::text AS status
          FROM imf im
         WHERE im.status = 'trial'
            OR (to_regclass('public.subscription') IS NOT NULL
                AND EXISTS (SELECT 1 FROM subscription s
                             WHERE s.imf_id = im.id AND s.status = 'trial'))
         ORDER BY im.code_imf
    LOOP
        v_nb_imf := v_nb_imf + 1;

        IF v_dry_run THEN
            -- ---- MODE SIMULATION : on compte, on n'écrit rien ----
            SELECT count(*) INTO v_nb_coupes
              FROM institution_module_subscriptions s
             WHERE s.institution_id = v_imf.id
               AND s.module_key <> v_collecte AND s.is_active = TRUE;
            RAISE NOTICE '[SIMULATION] % (%) : % module(s) seraient coupés, collecte maintenue en essai.',
                v_imf.code_imf, v_imf.name, v_nb_coupes;
        ELSE
            -- ---- MODE RÉEL : une transaction par IMF ----
            BEGIN
                -- 1. + 2. coupe générale sauf collecte, collecte maintenue en essai.
                PERFORM fn_restrict_imf_to_collecte(
                    v_imf.id, NULL, 'teebo_admin',
                    'Essai : accès limité au module Collecte & tontines (migration)'
                );

                -- 3. Vérification : l'essai de la collecte n'a pas été refusé
                --    (cas d'un module dont l'essai était déjà consommé).
                SELECT to_jsonb(array_agg(s.module_key)) INTO v_essai_deja
                  FROM institution_module_subscriptions s
                 WHERE s.institution_id = v_imf.id
                   AND s.module_key = v_collecte
                   AND s.is_trial = FALSE AND s.trial_used = TRUE;
                IF v_essai_deja IS NOT NULL AND jsonb_array_length(v_essai_deja) > 0 THEN
                    v_essai_refuse := v_essai_refuse || jsonb_build_object(
                        'imf', v_imf.code_imf,
                        'raison', 'essai de la collecte déjà consommé : module laissé en payant');
                END IF;

                GET DIAGNOSTICS v_nb_coupes = ROW_COUNT;
                v_nb_crees := v_nb_crees + 1;
                RAISE NOTICE '[APPLIQUÉ] % (%) : restriction collecte seule posée.',
                    v_imf.code_imf, v_imf.name;
            EXCEPTION WHEN OTHERS THEN
                -- Aucune IMF ne bloque les autres : l'échec est signalé et la
                -- boucle continue (le bloc est un point de reprise PL/pgSQL).
                RAISE WARNING '[ÉCHEC] % (%) : % — IMF ignorée.',
                    v_imf.code_imf, v_imf.name, SQLERRM;
            END;
        END IF;
    END LOOP;

    IF v_dry_run THEN
        RAISE NOTICE '=== SIMULATION TERMINÉE : % IMF en essai analysée(s). Rien n’a été écrit. Passez v_dry_run := FALSE pour appliquer. ===',
            v_nb_imf;
    ELSE
        RAISE NOTICE '=== APPLIQUÉ : % IMF traitée(s). Essais refusés : % ===',
            v_nb_crees, v_essai_refuse::text;
    END IF;
END $$;

COMMIT;

-- =========================================================================
-- CONTRÔLE APRÈS EXÉCUTION (à lancer séparément)
-- =========================================================================
--  a) État de chaque IMF :
--     SELECT code_imf, name, imf_status, restricted_collecte_only,
--            modules_utilisables
--       FROM v_imf_access_state
--      ORDER BY restricted_collecte_only DESC, code_imf;
--
--  b) Détail des modules d'une IMF :
--     SELECT module_key, is_active, is_trial, trial_end_date,
--            deactivated_reason, is_usable
--       FROM v_imf_module_access
--      WHERE institution_id = '<identifiant-de-l-imf>'
--      ORDER BY module_key;
--
--  c) Journal des restrictions :
--     SELECT institution_id, restriction_code, is_active, reason,
--            applied_at, lifted_at
--       FROM imf_access_restrictions
--      ORDER BY applied_at DESC;
--
--  d) Traces d'audit :
--     SELECT created_at, imf_id, action, payload
--       FROM audit_log
--      WHERE action IN ('IMF_RESTRICTION_COLLECTE_ONLY','IMF_RESTRICTION_LIFTED')
--      ORDER BY created_at DESC LIMIT 50;
--
--  e) LEVER la restriction d'une IMF (retour à l'état d'avant) :
--     SELECT fn_lift_imf_restriction('<identifiant-de-l-imf>', NULL,
--              'Retour à l’essai complet accordé par teebo');
-- =========================================================================
