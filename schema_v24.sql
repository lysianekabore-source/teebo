-- =========================================================================
-- VAGUE 24 — Génération de code d'unité robuste aux suppressions.
--
-- L'ancienne version calculait le numéro de séquence avec COUNT(*)+1 sur les
-- unités du même type. Après une suppression puis une nouvelle création, ce
-- numéro pouvait retomber sur un code déjà émis -> violation de la contrainte
-- UNIQUE(code_unit) -> l'INSERT echouait et l'ajout d'unité « ne fonctionnait
-- pas ». On repart desormais du plus grand suffixe deja utilise pour ce type et
-- on incremente jusqu'a trouver un code reellement libre.
-- =========================================================================
CREATE OR REPLACE FUNCTION fn_gen_unit_code(p_imf UUID, p_kind unit_kind) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE v_imf TEXT; v_seq INT; v_prefix TEXT; v_code TEXT;
BEGIN
    SELECT code_imf INTO v_imf FROM imf WHERE id = p_imf;
    v_prefix := CASE p_kind
        WHEN 'direction'  THEN '-DIR-'
        WHEN 'department' THEN '-DEP-'
        WHEN 'service'    THEN '-SRV-'
        WHEN 'agency'     THEN '-AGC-'
    END;
    -- Plus grand suffixe numerique deja attribue a ce type pour cette IMF
    -- (0 si aucun). On ignore les codes du semis par defaut ('CODE::uuid').
    SELECT COALESCE(MAX(NULLIF(regexp_replace(code_unit, '^.*' || v_prefix, ''), '')::int), 0)
      INTO v_seq
      FROM org_unit
     WHERE imf_id = p_imf AND kind = p_kind
       AND code_unit ~ (v_prefix || '[0-9]+$');
    -- Incremente jusqu'a un code libre : robuste aux suppressions/trous.
    LOOP
        v_seq := v_seq + 1;
        v_code := v_imf || v_prefix || lpad(v_seq::text, 3, '0');
        EXIT WHEN NOT EXISTS (SELECT 1 FROM org_unit WHERE code_unit = v_code);
    END LOOP;
    RETURN v_code;
END;
$$;
