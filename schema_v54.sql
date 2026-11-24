-- ===========================================================================
-- teebo — VAGUE 54 (19/11/2026)
-- « Une agence peut avoir un ou plusieurs POINTS DE SERVICE rattachés »
-- ===========================================================================
-- Un point de service est un lieu d'exercice d'une agence : guichet, caisse,
-- marché, point de collecte. Il dépend TOUJOURS d'une agence (jamais seul)
-- et peut recevoir des agents (caissier, collectrice) dans l'unité de
-- rattachement. Les agents d'un point de service remontent à l'agence
-- parente, donc aux états et à la collecte de cette agence.
--
-- Idempotent : peut être rejoué sans risque.
-- ===========================================================================

DO $do$
BEGIN
  ALTER TYPE unit_kind ADD VALUE IF NOT EXISTS 'point_service';
EXCEPTION WHEN others THEN
  -- valeur déjà présente (ou moteur qui refuse l'ajout dans une transaction)
  NULL;
END $do$;

-- Le code d'unité d'un point de service est de la forme ...-PDS-001, distinct
-- de celui de son agence (...-AGC-001).
CREATE OR REPLACE FUNCTION fn_gen_unit_code(p_imf UUID, p_kind unit_kind) RETURNS TEXT
LANGUAGE plpgsql AS $fn$
DECLARE v_imf TEXT; v_seq INT; v_prefix TEXT; v_code TEXT;
BEGIN
  SELECT code_imf INTO v_imf FROM imf WHERE id = p_imf;
  v_prefix := CASE p_kind WHEN 'direction' THEN '-DIR-' WHEN 'department' THEN '-DEP-'
                          WHEN 'service' THEN '-SRV-' WHEN 'agency' THEN '-AGC-'
                          WHEN 'point_service' THEN '-PDS-' END;
  SELECT COALESCE(MAX(NULLIF(regexp_replace(code_unit, '^.*' || v_prefix, ''), '')::int), 0)
    INTO v_seq FROM org_unit
   WHERE imf_id = p_imf AND kind = p_kind AND code_unit ~ (v_prefix || '[0-9]+$');
  LOOP
    v_seq := v_seq + 1;
    v_code := v_imf || v_prefix || lpad(v_seq::text, 3, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM org_unit WHERE code_unit = v_code);
  END LOOP;
  RETURN v_code;
END; $fn$;

-- Rattachement d'un point de service orphelin (import, changement de type) :
-- on ne touche à rien ici, le contrôle est fait par l'API.
