import { query } from './sim.mjs';
export const q = (t, p) => query(t, p);
export const tx = async (fn) => fn({ query: (t, p) => query(t, p) });
export const pool = { query: (t, p) => query(t, p) };
export default { q, tx, pool };
