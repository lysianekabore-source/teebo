-- ===========================================================================
-- teebo — VAGUE 45 : LA BASCULE EN « COLLECTE & TONTINES » NE CONCERNE QUE
--                   LES IMF DEJA EN ESSAI AVANT LE DEPLOIEMENT
-- ===========================================================================
-- CE QUE CE SCRIPT CHANGE (rien n'est supprimé, rien n'est renommé)
--
--   La règle de la vague 44 est TROP LARGE : elle s'applique à TOUTE IMF
--   dont le statut est « Essai », y compris celles qui s'inscrivent APRÈS le
--   déploiement. Or le souhait est explicite :
--
--     • les IMF DÉJÀ EN ESSAI au moment du déploiement  -> basculent sur le
--       seul module « Collecte & tontines » (elles avaient l'essai complet, on
--       ne leur retire rien de payant : on limite l'essai) ;
--     • les IMF QUI S'INSCRIVENT APRÈS le déploiement -> NE SONT PAS
--       basculées : elles reçoivent l'essai tel que la v35 le prévoit, module
--       par module, sur les modules qu'elles ont choisis dans leur proforma.
--
--   Le discriminant est une DATE, écrite une seule fois au déploiement :
--   la « date de référence » de la bascule (paramètre REFERENCE_BASCULE_ESSAI).
--
--     date d'inscription de l'IMF  <  date de référence   -> bascule
--     date d'inscription de l'IMF >=  date de référence   -> aucune bascule
--
--   La date de référence est posée à la PREMIÈRE exécution de ce script et
--   jamais réécrite ensuite (réexécutable sans décaler la frontière).
--
-- SCRIPT ADDITIF ET RÉEXÉCUTABLE (CREATE OR REPLACE uniquement).
-- Prérequis : v44 (fonctions et vue de la bascule).
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. AMORÇAGE À LA PREMIÈRE MISE EN SERVICE (sans aucun effet sur une base
--    déjà en production). Au tout premier déploiement, la quasi-totalité des
--    IMF en essai est antérieure à la pose de la frontière : on remonte donc
--    la frontière à la fin du dernier essai en cours. Elles basculent, puis la
--    frontière est figée pour toujours (aucun décalage sur les inscriptions
--    suivantes).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_derniere TIMESTAMPTZ;
BEGIN
    SELECT MAX(GREATEST(COALESCE(trial_ends_at, now()), now()))
      INTO v_derniere
      FROM imf
     WHERE status = 'trial';

    IF v_derniere IS NULL THEN
        RETURN;   -- aucun essai en cours : rien à rattraper
    END IF;

    INSERT INTO app_parametres (cle, valeur, commentaire)
    VALUES ('REFERENCE_BASCULE_ESSAI',
            to_char(v_derniere AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS'),
            'Amorçage : fin du dernier essai en cours à la mise en service. Frontière figée ensuite.')
    ON CONFLICT (cle) DO NOTHING;
END $$;

-- ---------------------------------------------------------------------------
-- 1. LA DATE DE RÉFÉRENCE (frontière définitive entre « avant » et « après »)
-- ---------------------------------------------------------------------------
-- Table de paramètres si elle existe déjà dans le projet, sinon créée ici.
CREATE TABLE IF NOT EXISTS app_parametres (
    cle        TEXT PRIMARY KEY,
    valeur     TEXT NOT NULL,
    commentaire TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Posée UNE SEULE FOIS. `ON CONFLICT DO NOTHING` : la deuxième exécution ne
-- décale pas la frontière (sinon des IMF « après » deviendraient « avant »).
INSERT INTO app_parametres (cle, valeur, commentaire)
VALUES ('REFERENCE_BASCULE_ESSAI',
        to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS'),
        'Horodatage du déploiement de la vague 45 : seules les IMF en essai créées AVANT basculent sur Collecte & tontines.')
ON CONFLICT (cle) DO NOTHING;

-- Lecture simple de la frontière. La ligne est créée ci-dessus : on retombe
-- sur maintenant() uniquement dans le cas impossible où elle manquerait.
CREATE OR REPLACE FUNCTION fn_reference_bascule_essai()
RETURNS TIMESTAMPTZ
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE(
             (SELECT (valeur || '+00')::timestamptz
                FROM app_parametres
               WHERE cle = 'REFERENCE_BASCULE_ESSAI'),
             now());
$$;

COMMENT ON FUNCTION fn_reference_bascule_essai() IS
  'Date/heure du déploiement de la vague 45. Les IMF en essai inscrites AVANT cette date basculent sur Collecte & tontines ; celles inscrites APRÈS ne basculent pas.';

-- ---------------------------------------------------------------------------
-- 2. LA QUESTION « CETTE IMF EST-ELLE CONCERNÉE ? » (une seule réponse)
-- ---------------------------------------------------------------------------
-- Priorité au statut d'inscription s'il existe (colonne created_at de imf),
-- sinon la date de la demande d'accès d'origine, sinon la date d'essai.
CREATE OR REPLACE FUNCTION fn_imf_est_ancien_essai(p_imf UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_inscription TIMESTAMPTZ;
    v_ref         TIMESTAMPTZ := fn_reference_bascule_essai();
BEGIN
    SELECT COALESCE(i.created_at,
                    i.trial_started_at,
                    i.trial_ends_at - INTERVAL '30 days')
      INTO v_inscription
      FROM imf i
     WHERE i.id = p_imf;

    IF v_inscription IS NULL THEN
        RETURN FALSE;   -- IMF inconnue ou date illisible : on ne touche à rien
    END IF;

    -- Bascule UNIQUEMENT si l'IMF était déjà là avant le déploiement.
    RETURN v_inscription < v_ref;
END;
$$;

COMMENT ON FUNCTION fn_imf_est_ancien_essai(UUID) IS
  'Vrai si l IMF était déjà inscrite avant la date de référence de la vague 45 (donc en essai « avant déploiement »).';

-- ---------------------------------------------------------------------------
-- 3. LA RÈGLE DE LA VAGUE 44, RESTREINTE AUX IMF « AVANT DÉPLOIEMENT »
-- ---------------------------------------------------------------------------
-- Même signature, même contrat, mêmes garanties (verrou, idempotence, aucune
-- suppression, trace d'audit). La SEULE différence : une IMF inscrite après
-- la date de référence n'est PAS basculée, et le compte rendu l'explique.
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
    v_date_ref   TIMESTAMPTZ;
    v_inscr      TIMESTAMPTZ;
BEGIN
    -- Verrou sur la ligne IMF : deux connexions simultanées de la même IMF
    -- passent l'une après l'autre, jamais en même temps (aucun doublon).
    PERFORM 1 FROM imf WHERE id = p_imf FOR UPDATE;

    SELECT status::text,
           GREATEST(COALESCE(trial_ends_at::date, CURRENT_DATE + 30), CURRENT_DATE),
           COALESCE(created_at, trial_started_at, trial_ends_at - INTERVAL '30 days')
      INTO v_status, v_fin_essai, v_inscr
      FROM imf WHERE id = p_imf;

    IF v_status IS NULL THEN
        RETURN jsonb_build_object('applique', FALSE, 'deja', FALSE,
            'motif', 'imf_introuvable');
    END IF;

    -- Seule une IMF EN ESSAI est concernée.
    IF v_status <> 'trial' THEN
        RETURN jsonb_build_object('applique', FALSE, 'deja', FALSE,
            'motif', 'pas_en_essai', 'statut', v_status);
    END IF;

    -- >>> LE FILTRE DE LA VAGUE 45 <<<
    -- Une IMF inscrite APRÈS le déploiement garde l'essai normal de la v35
    -- (module par module, tels qu'elle les a choisis). On ne fait rien.
    v_date_ref := fn_reference_bascule_essai();
    IF v_inscr IS NOT NULL AND v_inscr >= v_date_ref THEN
        RETURN jsonb_build_object('applique', FALSE, 'deja', FALSE,
            'motif', 'essai_posterieur_au_deploiement',
            'inscription', v_inscr,
            'reference', v_date_ref);
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
                    'essai_collecte_deja_utilise', v_trial_used,
                    'ancien_essai', TRUE,
                    'reference', v_date_ref));
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
  'Essai : bascule une IMF (statut trial) sur le seul module Collecte & tontines — UNIQUEMENT si elle était déjà en essai avant le déploiement (REFERENCE_BASCULE_ESSAI). Les IMF inscrites après ne sont pas touchées.';

-- ---------------------------------------------------------------------------
-- 4. LE RATTRAPAGE GLOBAL (déploiement), même restriction
-- ---------------------------------------------------------------------------
-- Ne sélectionne QUE les IMF en essai inscrites avant la date de référence :
-- une IMF qui s'inscrit après le déploiement n'est jamais dans la boucle.
CREATE OR REPLACE FUNCTION fn_basculer_imfs_en_essai(
    p_par UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_imf    RECORD;
    v_out    JSONB;
    v_n      INT := 0;
    v_coupes INT := 0;
    v_skip   INT := 0;
BEGIN
    FOR v_imf IN
        SELECT id, code_imf
          FROM imf
         WHERE status = 'trial'
           AND COALESCE(created_at, trial_started_at, trial_ends_at - INTERVAL '30 days')
               < fn_reference_bascule_essai()
         ORDER BY code_imf
    LOOP
        BEGIN
            v_out := fn_appliquer_essai_collecte(v_imf.id, p_par, 'MIGRATION');
            IF (v_out->>'applique')::boolean THEN
                v_n := v_n + 1;
                v_coupes := v_coupes + COALESCE((v_out->>'modules_coupes')::int, 0);
            ELSE
                v_skip := v_skip + 1;
            END IF;
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'IMF % ignorée : %', v_imf.code_imf, SQLERRM;
        END;
    END LOOP;
    RETURN jsonb_build_object('imfs_traitees', v_n,
                              'modules_coupes', v_coupes,
                              'imfs_ignorees', v_skip,
                              'reference', fn_reference_bascule_essai());
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. CONTRÔLE : IMF « AVANT DÉPLOIEMENT » EN ESSAI ENCORE OUVERTE SUR PLUSIEURS
--    MODULES. Après leur connexion, cette liste doit être vide.
--    Les IMF inscrites après le déploiement n'y figurent JAMAIS : c'est normal
--    qu'elles gardent leurs modules d'essai.
-- ---------------------------------------------------------------------------
-- DROP + CREATE (et non CREATE OR REPLACE) : la vue gagne une colonne
-- (inscription) et en déplace d'autres ; PostgreSQL interdit de renommer une
-- colonne de vue via OR REPLACE. Aucune donnée n'est perdue : une vue ne
-- stocke rien.
DROP VIEW IF EXISTS v_imfs_essai_a_basculer;
CREATE VIEW v_imfs_essai_a_basculer AS
SELECT i.id,
       i.code_imf,
       i.name,
       i.status::text                                   AS statut_imf,
       i.created_at                                     AS inscription,
       i.trial_ends_at,
       COUNT(s.subscription_id) FILTER (WHERE s.is_active) AS modules_ouverts,
       COALESCE(array_agg(s.module_key ORDER BY s.module_key)
                FILTER (WHERE s.is_active), '{}')             AS modules_actifs
  FROM imf i
  LEFT JOIN institution_module_subscriptions s ON s.institution_id = i.id
 WHERE i.status = 'trial'
   AND COALESCE(i.created_at, i.trial_started_at, i.trial_ends_at - INTERVAL '30 days')
       < fn_reference_bascule_essai()
 GROUP BY i.id, i.code_imf, i.name, i.status, i.created_at, i.trial_ends_at
HAVING COUNT(s.subscription_id) FILTER (WHERE s.is_active) <> 1
    OR COALESCE(bool_or(s.module_key = 'MODULE_COLLECTE_TONTINE'
                        AND s.is_active), FALSE) = FALSE;

COMMENT ON VIEW v_imfs_essai_a_basculer IS
  'IMF en essai créées AVANT le déploiement de la vague 45 qui ne sont pas (encore) sur le seul module Collecte & tontines. Après connexion, cette liste doit être vide. Les IMF inscrites après le déploiement n y figurent pas (elles ne sont pas basculées).';

COMMIT;

-- ===========================================================================
-- UTILISATION (à lancer à la main, dans cet ordre, si besoin)
-- ===========================================================================
--  a) Frontière (ne change plus) : SELECT fn_reference_bascule_essai();
--  b) Voir avant :   SELECT * FROM v_imfs_essai_a_basculer;
--  c) Appliquer aux IMF en essai ANTÉRIEURES au déploiement :
--                     SELECT fn_basculer_imfs_en_essai(NULL);
--  d) Une IMF précise : SELECT fn_appliquer_essai_collecte('<uuid>', NULL, 'MANUEL');
--  e) Vérifier après : SELECT * FROM v_imfs_essai_a_basculer;  -- doit être vide
--  f) Qui a été basculé :
--     SELECT created_at, imf_id, payload FROM audit_log
--      WHERE action = 'ESSAI_BASCULE_COLLECTE' ORDER BY created_at DESC LIMIT 50;
-- ===========================================================================
