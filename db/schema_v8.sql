-- ===========================================================================
-- teebo — Schéma VAGUE 11
-- ---------------------------------------------------------------------------
-- 1) Mentions légales de facturation côté IMF : RCCM et IFU/NIF.
--    Ces colonnes existent déjà depuis la vague 7 (imf_branding) ; on les
--    sécurise ici sur toute base antérieure. Elles sont renseignées dès le
--    dépôt de la demande d'accès et reprises sur la proforma et la facture.
--
-- 2) OFFRE UNIQUE : remplacement des 3 anciennes formules (starter / business /
--    enterprise) par une seule offre standardisée « teeBo ».
--      • Abonnement mensuel de base : 75 000 FCFA = 7 500 000 centimes.
--      • Licence unique d'activation : 250 000 FCFA (gérée côté application).
--      • Cycle annuel : remise de 15 % sur l'abonnement (63 750 FCFA / mois).
--
-- Toutes les instructions sont idempotentes (rejouables sans effet de bord).
-- ===========================================================================

-- --- 1. Mentions légales de facturation (RCCM / IFU) -----------------------
ALTER TABLE imf_branding ADD COLUMN IF NOT EXISTS trade_register_no TEXT; -- RCCM / registre du commerce
ALTER TABLE imf_branding ADD COLUMN IF NOT EXISTS tax_id            TEXT; -- IFU / NIF / identifiant fiscal

-- --- 2. Offre unique standardisée -----------------------------------------
-- Création (ou mise à jour) de l'offre unique « standard » à 75 000 FCFA/mois.
INSERT INTO plan (code, label, price_cents, billing_cycle, max_agencies, max_users, features, sort_order)
VALUES (
  'standard',
  'teeBo',
  7500000,
  'mensuel',
  NULL,
  NULL,
  '["Agences illimitées","Utilisateurs illimités","Collecte de proximité & synchronisation terrain","Gestion multi-agences","Rapports prudentiels DSC-SFD","Sécurité bancaire & cloisonnement des données","Support inclus"]'::jsonb,
  1
)
ON CONFLICT (code) DO UPDATE SET
  label         = EXCLUDED.label,
  price_cents   = EXCLUDED.price_cents,
  billing_cycle = EXCLUDED.billing_cycle,
  max_agencies  = EXCLUDED.max_agencies,
  max_users     = EXCLUDED.max_users,
  features      = EXCLUDED.features,
  sort_order    = EXCLUDED.sort_order;

-- Retrait des 3 anciennes formules de l'offre proposée. Les demandes déjà
-- enregistrées conservent leur libellé (le code est stocké en texte sur la
-- demande, sans clé étrangère) : l'historique de facturation reste lisible.
DELETE FROM plan WHERE code IN ('starter', 'business', 'enterprise');

COMMIT;
