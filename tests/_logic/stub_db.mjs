export function q(){ return globalThis.__fake.query.apply(globalThis.__fake, arguments); }
export function tx(fn){ return fn(globalThis.__fake); }
export const __set = (f) => { globalThis.__fake = f; };
export default { q, tx };
