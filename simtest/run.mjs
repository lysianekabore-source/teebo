import { DB } from './db.js';
import { effectivePermissionKeys, userHasPermission } from './auth.js';

const CHEF = new Set(['users.read','clients.read','clients.enroll','clients.manage','clients.freeze',
 'round.view','round.manage','cash.declare','cash.validate','cash.approve','collecte.assign','collecte.supervise',
 'operations.read','operations.write','operations.validate','accounts.manage','savings.read','reports.read',
 'reports.export','objectives.read','objectives.set','objectives.dashboard','org.read']);
DB.pos.POS_CHEF_AGENCE = CHEF;

const chef = { id: 'u2', imf_id: 'imf1', role: 'agency', position_code: 'POS_CHEF_AGENCE' };
const admin = { id: 'u1', imf_id: 'imf1', role: 'admin_imf', position_code: 'POS_ADMIN_SYS' };

const p = await effectivePermissionKeys(chef);
console.log('CHEF d agence ->', p.sort().join(','));
for (const k of ['settings.manage','access.manage','audit.read','credit.validate_final','users.manage','org.manage','devices.read','visibility.manage'])
  console.log('  ', k, '=', await userHasPermission(chef, k));
console.log('ADMIN settings.manage =', await userHasPermission(admin, 'settings.manage'));
console.log('ADMIN users.manage =', await userHasPermission(admin, 'users.manage'));

// surcharge abusive : on accorde settings.manage + access.manage au chef
DB.over.u2 = { 'settings.manage': true, 'access.manage': true, 'users.manage': true };
const p2 = await effectivePermissionKeys(chef);
console.log('CHEF avec surcharge -> contient settings?', p2.includes('settings.manage'), '| access?', p2.includes('access.manage'), '| users.manage?', p2.includes('users.manage'));
console.log('  requirePermission settings.manage =', await userHasPermission(chef, 'settings.manage'));

// caissier sans poste renseigne
const c = { id: 'u3', imf_id: 'imf1', role: 'caissier', position_code: null };
const p3 = await effectivePermissionKeys(c);
console.log('CAISSIER ->', p3.join(','));
