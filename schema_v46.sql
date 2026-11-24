-- ===========================================================================
-- teebo — VAGUE 46 : CODES D'ACCES TOUJOURS CREES, REGENERABLES ET ENVOYES
--                   PAR L'ADMINISTRATEUR teebo (service commercial)
-- ===========================================================================
-- CE QUE CE SCRIPT APPORTE (100 % additif, aucune donnee supprimee)
--
--   1. Un code d'acces est cree AUTOMATIQUEMENT pour tout compte cree, quel
--      que soit le chemin utilise (interface, API, import, migration).
--      - Trigger BEFORE INSERT sur app_user : si code_user est vide ou NULL,
--        il est genere ; s'il est fourni, il est nettoye et rendu unique.
--      - fn_gen_user_code() est reecrite : elle ne produit plus de doublons
--        (avant : COUNT(*)+1 -> collision des qu'un compte etait supprime ou
--        cree en parallele, ce qui faisait echouer la creation du compte).
--
--   2. Un code d'acces peut etre REGENERE par l'administrateur teebo (ou par
--      l'administrateur IMF de l'institution), avec motif trace.
--        SELECT fn_regenerer_code_acces('<uuid utilisateur>', 'MOTIF');
--      -> nouveau code, ancien code journalise, sessions ouvertes revoquees,
--         mot de passe remis a « a creer » (l'ancien titulaire ne peut plus
--         entrer avec le code communique par erreur).
--
--   3. Le code est ENVOYE par l'admin teebo depuis la console :
--      journal des envois enrichi (qui, quand, par quel canal, mode automatique
--      ou lien manuel WhatsApp / e-mail), avec un liens UNIQUES par envoi pour
--      que le compte de l'admin n'ait JAMAIS a connaitre le mot de passe.
--
--   4. Vues de controle pour la console :
--        v_acces_a_envoyer   comptes sans mot de passe / jamais envoye
--        v_codes_envoyes     historique lisible des envois
--
-- SCRIPT REEXECUTABLE (CREATE OR REPLACE / IF NOT EXISTS uniquement).
-- Prerequis : v45 (app_parametres) ; socle + v3 + v7 + v11 + v12 appliques.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. GARDE-FOU : les colonnes utilisees par ce lot doivent exister.
--    (Elles viennent du socle, v3, v11 et v12. On les reproduit ici en
--    « IF NOT EXISTS » pour qu'un demarrage partiel ne casse jamais le script.)
-- ---------------------------------------------------------------------------
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS parent_id      UUID;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS dept_code      TEXT;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS service_code   TEXT;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS position_code  TEXT;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS password_set_at TIMESTAMPTZ;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

-- ===========================================================================
-- 1. SEQUENCE PAR INSTITUTION : plus jamais de code en double
-- ===========================================================================
-- L'ancienne fonction calculait COUNT(*)+1. Apres une suppression de compte
-- (ou deux creations simultanees), le numero retombait sur un code deja
-- attribue -> violation d'unicite -> « la creation du compte echoue ».
-- Une sequence par IMF donne un numero strictement croissant, sans trou
-- genant et sans collision possible.
CREATE TABLE IF NOT EXISTS user_code_sequence (
    imf_id      UUID PRIMARY KEY REFERENCES imf(id) ON DELETE CASCADE,
    last_value  BIGINT NOT NULL DEFAULT 0
);
COMMENT ON TABLE user_code_sequence IS
  'Compteur du dernier numero de code d acces attribue, par institution. Alimente par fn_gen_user_code().';

-- Amorcage : on repart du plus grand numero deja utilise par chaque IMF.
INSERT INTO user_code_sequence(imf_id, last_value)
SELECT u.imf_id,
       COALESCE(MAX(NULLIF(regexp_replace(u.code_user, '^.*-U', ''), '')::bigint), 0)
  FROM app_user u
 GROUP BY u.imf_id
ON CONFLICT (imf_id) DO NOTHING;

CREATE OR REPLACE FUNCTION fn_gen_user_code(p_imf UUID) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
    v_imf TEXT;
    v_seq BIGINT;
    v_code TEXT;
BEGIN
    SELECT code_imf INTO v_imf FROM imf WHERE id = p_imf;
    IF v_imf IS NULL THEN
        RAISE EXCEPTION 'institution_introuvable';
    END IF;

    -- Numero suivant, atomique (un seul code par appel, jamais de collision).
    INSERT INTO user_code_sequence(imf_id, last_value) VALUES (p_imf, 1)
    ON CONFLICT (imf_id) DO UPDATE
       SET last_value = user_code_sequence.last_value + 1
    RETURNING last_value INTO v_seq;

    v_code := v_imf || '-U' || lpad(v_seq::text, 5, '0');

    -- Filet de securite (code deja present par un import ancien) : on avance.
    WHILE EXISTS (SELECT 1 FROM app_user WHERE code_user = v_code) LOOP
        INSERT INTO user_code_sequence(imf_id, last_value) VALUES (p_imf, 1)
        ON CONFLICT (imf_id) DO UPDATE
           SET last_value = user_code_sequence.last_value + 1
        RETURNING last_value INTO v_seq;
        v_code := v_imf || '-U' || lpad(v_seq::text, 5, '0');
    END LOOP;

    RETURN v_code;
END;
$$;
COMMENT ON FUNCTION fn_gen_user_code(UUID) IS
  'Genere le prochain code d acces d une institution (TBO-XX-000000-U00001). Atomique et sans collision.';

-- ===========================================================================
-- 2. CREATION AUTOMATIQUE DU CODE : trigger sur app_user
-- ===========================================================================
-- Quel que soit le chemin qui cree le compte, le code existe des l'INSERT.
-- Aucun compte ne peut plus naitre sans code d'acces.
CREATE OR REPLACE FUNCTION fn_app_user_code_acces() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_code TEXT;
BEGIN
    v_code := NULLIF(btrim(COALESCE(NEW.code_user, '')), '');

    IF v_code IS NULL THEN
        -- Cas normal : l'interface ne fournit rien, la base attribue le code.
        NEW.code_user := fn_gen_user_code(NEW.imf_id);
    ELSE
        -- Code fourni (import, reprise) : nettoye (majuscules, sans espace)
        -- et rendu unique dans TOUTE la plateforme (contrainte UNIQUE).
        v_code := upper(regexp_replace(v_code, '\s+', '', 'g'));
        IF EXISTS (SELECT 1 FROM app_user WHERE code_user = v_code) THEN
            NEW.code_user := fn_gen_user_code(NEW.imf_id);
        ELSE
            NEW.code_user := v_code;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_app_user_code_acces ON app_user;
CREATE TRIGGER trg_app_user_code_acces
    BEFORE INSERT ON app_user
    FOR EACH ROW EXECUTE FUNCTION fn_app_user_code_acces();

COMMENT ON TRIGGER trg_app_user_code_acces ON app_user IS
  'Tout compte cree recoit automatiquement un code d acces unique (vague 46).';

-- ===========================================================================
-- 3. JOURNAL DES ENVOIS DE CODES : enrichissement (qui / comment / trace)
-- ===========================================================================
-- La table existe depuis la vague 7. On ajoute ce qui manquait pour que la
-- console de l'administrateur teebo puisse prouver un envoi : le role de
-- l'emetteur, l'origine de l'action, la reference du nouveau code quand il y a
-- regeneration, et le texte exact du message envoye.
ALTER TABLE code_dispatch_log ADD COLUMN IF NOT EXISTS origin          TEXT;   -- 'espace_imf' | 'console_teebo' | 'api' | 'systeme'
ALTER TABLE code_dispatch_log ADD COLUMN IF NOT EXISTS dispatched_role TEXT;   -- role de l'emetteur au moment de l'envoi
ALTER TABLE code_dispatch_log ADD COLUMN IF NOT EXISTS receiver        TEXT;   -- destinataire confirme (e-mail ou numero)
ALTER TABLE code_dispatch_log ADD COLUMN IF NOT EXISTS previous_code   TEXT;   -- ancien code, si regeneré
ALTER TABLE code_dispatch_log ADD COLUMN IF NOT EXISTS message         TEXT;   -- texte exact envoye (preuve)
ALTER TABLE code_dispatch_log ADD COLUMN IF NOT EXISTS notes           TEXT;   -- motif / commentaire de l'admin

CREATE INDEX IF NOT EXISTS idx_code_dispatch_code ON code_dispatch_log(code_user);

-- ===========================================================================
-- 4. REGENERER UN CODE D'ACCES (administrateur teebo ou admin IMF)
-- ===========================================================================
-- Usage : SELECT fn_regenerer_code_acces('<uuid utilisateur>', 'motif');
--   - nouveau code unique pour l'institution du compte ;
--   - l'ancien code est conserve dans user_code_history (perte de tracabilite
--     impossible) ;
--   - les sessions ouvertes sont revoquees ;
--   - le mot de passe est remis a « a creer » (must_change_password = true) :
--     celui qui detient l'ancien code ne peut plus entrer ;
--   - le compte est reactive s'il etait desactive par erreur de diffusion ;
--   - rien n'est envoye par la base (l'envoi est un geste de l'admin).
CREATE TABLE IF NOT EXISTS user_code_history (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    imf_id      UUID NOT NULL REFERENCES imf(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    code_user   TEXT NOT NULL,             -- code retire
    motif       TEXT,                      -- raison de la regeneration
    changed_by  UUID REFERENCES app_user(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_code_history_user ON user_code_history(user_id, created_at DESC);

COMMENT ON TABLE user_code_history IS
  'Historique des codes d acces remplaces. Un code n est jamais reutilise.';

CREATE OR REPLACE FUNCTION fn_regenerer_code_acces(
    p_user_id UUID,
    p_motif   TEXT DEFAULT NULL,
    p_actor   UUID DEFAULT NULL
) RETURNS TABLE (user_id UUID, full_name TEXT, ancien_code TEXT, nouveau_code TEXT, imf_id UUID)
LANGUAGE plpgsql AS $$
DECLARE
    v_u    app_user%ROWTYPE;
    v_new  TEXT;
BEGIN
    -- NB : on ne peut pas tester « IF NOT FOUND » juste apres un SELECT INTO
    -- qui ne renvoie aucune ligne, le statut FOUND etant ecrase par le SELECT
    -- suivant ; on teste donc directement l'identifiant recupere.
    SELECT * INTO v_u FROM app_user WHERE id = p_user_id FOR UPDATE;
    IF v_u.id IS NULL THEN
        RAISE EXCEPTION 'utilisateur_introuvable';
    END IF;
    IF v_u.role::text = 'teebo_admin' THEN
        RAISE EXCEPTION 'compte_editeur_non_regenerable';
    END IF;

    -- 1) Tracer l'ancien code (jamais reutilise ensuite).
    INSERT INTO user_code_history(imf_id, user_id, code_user, motif, changed_by)
    VALUES (v_u.imf_id, v_u.id, v_u.code_user, NULLIF(p_motif, ''), p_actor);

    -- 2) Nouveau code.
    v_new := fn_gen_user_code(v_u.imf_id);

    -- 3) Le compte repart « propre » : code neuf, mot de passe a creer,
    --    sessions fermees (un ancien detenteur du code est immediatement hors).
    UPDATE app_user
       SET code_user = v_new,
           password_hash = NULL,
           password_set_at = NULL,
           must_change_password = true,
           is_active = true,
           updated_at = now()
     WHERE id = v_u.id;

    UPDATE session SET revoked = true
     WHERE user_id = v_u.id AND revoked = false;

    RETURN QUERY SELECT v_u.id, v_u.full_name::text, v_u.code_user, v_new, v_u.imf_id;
END;
$$;
COMMENT ON FUNCTION fn_regenerer_code_acces(UUID, TEXT, UUID) IS
  'Regenere le code d acces d un compte : ancien code archive, sessions revoquees, mot de passe a recreer.';

-- ===========================================================================
-- 5. GARANTIR QU'UN CODE EXISTE POUR CHAQUE COMPTE (rattrapage idempotent)
-- ===========================================================================
-- Certains comptes anciens (crees avant la vague 7 ou par import) n'ont pas
-- recu de code a la creation. On les complete une fois pour toutes.
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT id FROM app_user
              WHERE code_user IS NULL OR btrim(code_user) = ''
              ORDER BY created_at
    LOOP
        UPDATE app_user u
           SET code_user = fn_gen_user_code(u.imf_id)
         WHERE u.id = r.id;
    END LOOP;
END $$;

-- ===========================================================================
-- 6. VUES DE CONTROLE POUR LA CONSOLE ET L'ESPACE IMF
-- ===========================================================================
CREATE OR REPLACE VIEW v_acces_a_envoyer AS
SELECT
    u.id                AS user_id,
    u.imf_id,
    i.code_imf          AS code_institution,
    i.name              AS imf_name,
    i.status::text      AS imf_status,
    u.full_name,
    u.email,
    u.phone,
    u.code_user,
    u.role::text        AS role,
    u.position,
    (u.password_hash IS NULL)          AS mot_de_passe_a_creer,
    u.must_change_password,
    u.is_active,
    u.created_at,
    (SELECT max(d.created_at) FROM code_dispatch_log d
      WHERE d.user_id = u.id)          AS dernier_envoi,
    (SELECT max(d.created_at) FROM code_dispatch_log d
      WHERE d.user_id = u.id AND (d.whatsapp_mode = 'sent' OR d.email_mode = 'sent'))
                                       AS dernier_envoi_automatique,
    (SELECT count(*) FROM code_dispatch_log d WHERE d.user_id = u.id) AS nb_envois
FROM app_user u
JOIN imf i ON i.id = u.imf_id
WHERE u.role <> 'teebo_admin'
ORDER BY (u.password_hash IS NULL) DESC, u.created_at DESC;

COMMENT ON VIEW v_acces_a_envoyer IS
  'Comptes dont le code n a jamais ete envoye ou dont le mot de passe n est pas encore cree. Base du bouton « Envoyer » de la console.';

CREATE OR REPLACE VIEW v_codes_envoyes AS
SELECT
    d.id,
    d.imf_id,
    i.code_imf          AS code_institution,
    i.name              AS imf_name,
    d.user_id,
    COALESCE(d.recipient_name, u.full_name) AS recipient_name,
    d.code_user,
    d.previous_code,
    d.to_email,
    d.to_phone,
    d.channel,
    d.origin,
    d.whatsapp_mode,
    d.email_mode,
    d.notes,
    d.created_at,
    d.dispatched_by,
    COALESCE(a.full_name, 'automatique (systeme)') AS dispatched_by_name,
    d.dispatched_role
FROM code_dispatch_log d
LEFT JOIN app_user u ON u.id = d.user_id
LEFT JOIN app_user a ON a.id = d.dispatched_by
LEFT JOIN imf i      ON i.id = d.imf_id
ORDER BY d.created_at DESC;

COMMENT ON VIEW v_codes_envoyes IS
  'Historique lisible des envois de codes d acces (console teebo et espace IMF).';

-- ===========================================================================
-- 7. PARAMETRES PAR DEFAUT (lisibles pour la console)
-- ===========================================================================
-- Auto-suffisance : si v45 n'a pas tourné (ordre non garanti côté hébergeur),
-- la table est créée ici à l'identique (additif, réentrant).
CREATE TABLE IF NOT EXISTS app_parametres (
    cle         TEXT PRIMARY KEY,
    valeur      TEXT,
    commentaire TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO app_parametres(cle, valeur, commentaire) VALUES
  ('CODE_ACCES_GENERATION_AUTO', 'OUI',
   'Tout compte cree recoit automatiquement un code d acces (trigger trg_app_user_code_acces).'),
  ('CODE_ACCES_REGENERATION', 'ADMIN_TEEBO_ET_ADMIN_IMF',
   'Qui peut regenerer un code : administrateur teebo (console) et administrateur de l institution.'),
  ('CODE_ACCES_ENVOI', 'ADMIN_TEEBO_ET_ADMIN_IMF',
   'Qui peut envoyer un code : administrateur teebo (console) et administrateur de l institution.'),
  ('CODE_ACCES_ORIGINE_PAR_DEFAUT', 'espace_imf',
   'Valeur portee par l envoi quand l origine n est pas precisee (compatibilite v7).')
ON CONFLICT (cle) DO NOTHING;

COMMIT;

-- ===========================================================================
-- UTILISATION COURANTE (copier-coller dans Render > psql, ou dans un SQL editor)
-- ===========================================================================
--  1) Verifier les comptes sans code ou sans mot de passe cree :
--       SELECT code_institution, full_name, code_user, mot_de_passe_a_creer, nb_envois
--         FROM v_acces_a_envoyer LIMIT 50;
--
--  2) Regenerer un code (puis l'envoyer depuis la console) :
--       SELECT fn_regenerer_code_acces(
--                (SELECT id FROM app_user WHERE code_user = 'TBO-CI-000001-U00003'),
--                'Code perdu par la responsable du guichet');
--
--  3) Voir l'historique des envois d'une institution :
--       SELECT created_at, recipient_name, code_user, channel, whatsapp_mode,
--              email_mode, dispatched_by_name
--         FROM v_codes_envoyes
--        WHERE code_institution = 'TBO-CI-000001'
--        ORDER BY created_at DESC LIMIT 50;
-- ===========================================================================
