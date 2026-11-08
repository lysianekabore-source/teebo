#!/usr/bin/env node
// teebo — Outil : générer le hachage d'un mot de passe pour app_user.password_hash
// Usage :  node scripts/hash-password.mjs "MonMotDePasse"
// Copiez la chaîne affichée dans la colonne password_hash (UPDATE app_user ...).
import { hashPassword } from '../password.js';

const plain = process.argv[2];
if (!plain) {
  console.error('Usage : node scripts/hash-password.mjs "MonMotDePasse"');
  process.exit(1);
}
console.log(hashPassword(plain));
