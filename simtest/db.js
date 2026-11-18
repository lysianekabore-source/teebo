export const DB = { pos: {}, over: {} };
export async function q(sql, params) {
  const s = String(sql).replace(/\s+/g, ' ').trim();
  if (/FROM permission_catalog/.test(s)) {
    const all = Object.keys(DB.pos.__all || {}).map(k => ({ permission_key: k }));
    return { rows: all };
  }
  if (/SELECT allowed FROM user_permission/.test(s)) {
    const key = params[2];
    const m = DB.over[params[0]] || {};
    return { rows: Object.prototype.hasOwnProperty.call(m, key) ? [{ allowed: m[key] }] : [] };
  }
  if (/SELECT 1 FROM fn_position_default_perms/.test(s)) {
    const set = DB.pos[params[1]] || new Set();
    return { rows: set.has(params[2]) ? [{ '?column?': 1 }] : [] };
  }
  if (/SELECT permission_key FROM fn_position_default_perms/.test(s)) {
    const set = DB.pos[params[1]] || new Set();
    return { rows: [...set].map(k => ({ permission_key: k })) };
  }
  if (/SELECT permission_key, allowed FROM user_permission/.test(s)) {
    const m = DB.over[params[0]] || {};
    return { rows: Object.entries(m).map(([k, v]) => ({ permission_key: k, allowed: v })) };
  }
  return { rows: [] };
}
export async function tx(fn) { return fn({ query: q }); }
