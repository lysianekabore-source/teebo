// FAUX CONNECTEUR — uniquement pour les tests hors ligne.
export const pool = { query: async (t, p) => ({ rows: globalThis.__FAKE_QUERY__ ? globalThis.__FAKE_QUERY__(t, p) : [] }) };
export async function q(text, params) {
  const rows = globalThis.__FAKE_QUERY__ ? globalThis.__FAKE_QUERY__(text, params) : [];
  return { rows };
}
export async function tx(fn) { return fn(pool); }
