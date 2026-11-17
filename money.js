// =========================================================================
// teebo — MONTANTS EN FCFA : ARITHMÉTIQUE DÉCIMALE STRICTE
// =========================================================================
// RÈGLE ABSOLUE : aucun montant en FCFA ne doit transiter par un `Number`
// (flottant binaire) pour un calcul. 0,1 + 0,2 n'est pas exact en flottant ;
// sur des millions de FCFA cela produit des écarts d'un centime.
//
// Ici :
//   • toutes les entrées sont lues telles que PostgreSQL les renvoie
//     (NUMERIC -> chaîne de caractères, jamais converti en flottant) ;
//   • tous les calculs passent par big.js (décimal exact) ;
//   • tous les arrondis sont explicites (2 décimales, arrondi commercial
//     « demi vers le haut », identique au ROUND de PostgreSQL) ;
//   • la sortie est une CHAÎNE de caractères ('63750.00'), directement
//     utilisable en SQL via un cast ::numeric — jamais un flottant.
// =========================================================================
import Big from 'big.js';

// Arrondi commercial à 2 décimales, comme NUMERIC(12,2) / ROUND(x, 2).
Big.RM = Big.roundHalfUp;
Big.DP = 20;          // précision interne large, arrondi seulement à la fin

/** Convertit une entrée (chaîne SQL, nombre entier, Big) en Big validé. */
export function dec(v) {
  if (v === null || v === undefined || v === '') return new Big(0);
  if (v instanceof Big) return v;
  // Un flottant JS est REFUSÉ : un montant doit arriver sous forme de chaîne
  // (NUMERIC lu par pg) ou d'entier strictement représentable.
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) {
      throw new Error('Montant flottant interdit : ' + v
        + ' (utilisez la chaîne renvoyée par PostgreSQL).');
    }
    return new Big(v);
  }
  const s = String(v).trim().replace(/\s/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw new Error('Montant invalide : ' + v);
  }
  return new Big(s);
}

/** Arrondi à 2 décimales (centimes de FCFA). */
export function r2(v) {
  return dec(v).round(2, Big.roundHalfUp);
}

/** Somme décimale exacte (variadique). */
export function sum(...vals) {
  return vals.reduce((acc, v) => acc.plus(dec(v)), new Big(0));
}

/** a × b, arrondi à 2 décimales. */
export function mul(a, b) {
  return r2(dec(a).times(dec(b)));
}

/** a ÷ b, arrondi à 2 décimales (b doit être non nul). */
export function div(a, b) {
  if (dec(b).eq(0)) throw new Error('Division par zéro.');
  return r2(dec(a).div(dec(b)));
}

/**
 * Prorata au jour près : montant × joursFacturés ÷ joursDuMois.
 * Équivalent exact de ROUND(prix * jours / jours_du_mois, 2) en SQL.
 */
export function prorata(montant, joursFactures, joursDuMois) {
  if (!joursDuMois) throw new Error('Nombre de jours du mois manquant.');
  return div(r2(montant).times(dec(joursFactures)), dec(joursDuMois));
}

/** Pourcentage appliqué : montant × pct ÷ 100, arrondi à 2 décimales. */
export function pct(montant, pourcentage) {
  return div(r2(montant).times(dec(pourcentage)), 100);
}

/** Représentation SQL : chaîne à 2 décimales, prête pour un cast ::numeric. */
export function toSql(v) {
  return r2(v).toFixed(2);
}

/** Représentation d'affichage en FCFA (sans les centimes inutiles). */
export function formatFcfa(v) {
  const b = r2(v);
  const neg = b.lt(0);
  const abs = b.abs();
  const ent = abs.toFixed(0);
  const dec2 = abs.minus(new Big(ent)).toFixed(2).slice(2);
  const groupes = ent.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const reste = dec2 === '00' ? '' : ',' + dec2;
  return (neg ? '− ' : '') + groupes + reste + ' FCFA';
}

/** Comparaison décimale : -1, 0, 1. */
export function cmp(a, b) {
  return dec(a).cmp(dec(b));
}

export default { dec, r2, sum, mul, div, prorata, pct, toSql, formatFcfa, cmp, Big };
