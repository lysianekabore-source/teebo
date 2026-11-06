import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { q } from '../db.js';
import { requireRole } from '../auth.js';
import { notifySecurityAlert } from '../notify.js';

const r = Router();

/** Détection de l'appareil courant depuis la requête (en-têtes du terminal mobile). */
export function deviceFromReq(req) {
  const imei = String(req.headers['x-device-imei'] || req.body?.imei || '').replace(/\D/g, '');
  const mac = String(req.headers['x-device-mac'] || req.body?.mac_address || '').toUpperCase();
  return { imei, mac };
}

/* ------------------------------------------------------------------ *
 *  Console admin IMF : gestion des terminaux + alertes de sécurité   *
 * ------------------------------------------------------------------ */

/** Liste des terminaux enrôlés (couplage téléphone <-> collectrice). */
r.get('/devices', requireRole('admin_imf', 'direction', 'department', 'service'), async (req, res) => {
  const { rows } = await q(
    `SELECT d.*, u.full_name AS user_name
       FROM device d LEFT JOIN app_user u ON u.id = d.user_id
      WHERE d.imf_id = $1 ORDER BY d.created_at DESC`, [req.user.imf_id]);
  res.json({ devices: rows });
});

/** Enrôlement obligatoire : nom collectrice, date de naissance, IMEI 15, MAC, PIN. */
r.post('/devices', requireRole('admin_imf', 'direction', 'department', 'service'), async (req, res) => {
  const b = req.body || {};
  const imei = String(b.imei || '').replace(/\D/g, '');
  const mac = String(b.mac_address || '').toUpperCase().trim();
  const pin = String(b.pin || '');
  if (!b.user_id || !b.holder_name || !b.holder_birth)
    return res.status(400).json({ error: 'collectrice (utilisateur, nom, date de naissance) requise' });
  if (!/^\d{15}$/.test(imei))
    return res.status(400).json({ error: 'IMEI invalide : 15 chiffres requis' });
  if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac))
    return res.status(400).json({ error: 'Adresse MAC invalide (format AA:BB:CC:DD:EE:FF)' });
  if (!/^\d{4,8}$/.test(pin))
    return res.status(400).json({ error: 'PIN numérique de 4 à 8 chiffres requis' });

  const dup = await q('SELECT id FROM device WHERE imei=$1 OR mac_address=$2', [imei, mac]);
  if (dup.rows.length) return res.status(409).json({ error: 'Ce terminal (IMEI ou MAC) est déjà enrôlé' });

  const pin_hash = await bcrypt.hash(pin, 10);
  const { rows } = await q(
    `INSERT INTO device(imf_id,user_id,holder_name,holder_birth,pin_hash,imei,mac_address,phone_number,device_model,enrolled_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, user_id, holder_name, imei, mac_address, status, created_at`,
    [req.user.imf_id, b.user_id, b.holder_name, b.holder_birth, pin_hash, imei, mac,
     b.phone_number || null, b.device_model || null, req.user.id]);
  res.status(201).json({ device: rows[0] });
});

/** Révocation à distance : terminal perdu/volé -> déconnexion forcée. */
r.post('/devices/:id/revoke', requireRole('admin_imf', 'direction', 'department', 'service'), async (req, res) => {
  const { rows } = await q(
    `UPDATE device SET status='revoked', revoked_by=$3, revoked_at=now()
      WHERE id=$1 AND imf_id=$2 RETURNING *`, [req.params.id, req.user.imf_id, req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'Terminal introuvable' });
  const dev = rows[0];
  // Déconnexion forcée : destruction immédiate des sessions de la collectrice.
  await q('UPDATE session SET revoked=true WHERE user_id=$1', [dev.user_id]);
  await q(
    `INSERT INTO security_alert(imf_id,level,kind,attempted_identifier,imei,mac_address,message)
     VALUES ($1,'warning','device_revoked',$2,$3,$4,$5)`,
    [req.user.imf_id, dev.holder_name, dev.imei, dev.mac_address, 'Terminal révoqué à distance par ' + req.user.full_name]);
  notifySecurityAlert({ imf_id: req.user.imf_id, kind: 'device_revoked', identifier: dev.holder_name });
  res.json({ device: dev, sessions_killed: true });
});

/** Réactivation d'un terminal (retour d'un appareil bloqué). */
r.post('/devices/:id/reactivate', requireRole('admin_imf', 'direction', 'department', 'service'), async (req, res) => {
  const { rows } = await q(
    `UPDATE device SET status='active', revoked_by=NULL, revoked_at=NULL
      WHERE id=$1 AND imf_id=$2 RETURNING *`, [req.params.id, req.user.imf_id]);
  if (!rows.length) return res.status(404).json({ error: 'Terminal introuvable' });
  res.json({ device: rows[0] });
});

/** Alertes de sécurité temps réel (priorité haute si appareil inconnu). */
r.get('/security-alerts', requireRole('admin_imf', 'direction', 'department', 'service'), async (req, res) => {
  const { rows } = await q(
    `SELECT * FROM security_alert WHERE imf_id=$1 ORDER BY created_at DESC LIMIT 100`, [req.user.imf_id]);
  const unread = rows.filter(x => !x.acknowledged).length;
  res.json({ alerts: rows, unread });
});

r.post('/security-alerts/:id/read', requireRole('admin_imf', 'direction', 'department', 'service'), async (req, res) => {
  await q(`UPDATE security_alert SET acknowledged=true WHERE id=$1 AND imf_id=$2`, [req.params.id, req.user.imf_id]);
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 *  Terminal mobile (collectrice) : connexion par identifiant + PIN   *
 *  Couplage strict : appareil inconnu => blocage + alerte immédiate. *
 * ------------------------------------------------------------------ */

/** Connexion terrain. Body: { identifier, pin } + en-têtes X-Device-IMEI/MAC. */
r.post('/field/login', async (req, res) => {
  const { identifier, pin } = req.body || {};
  const { imei, mac } = deviceFromReq(req);
  if (!identifier || !/^\d{4,8}$/.test(String(pin || '')))
    return res.status(400).json({ error: 'Identifiant et PIN numérique requis' });

  const du = await q(
    `SELECT d.*, u.full_name AS user_name, u.is_active AS user_status, d.imf_id
       FROM device d JOIN app_user u ON u.id = d.user_id
      WHERE d.imei=$1`, [imei]);

  // Appareil inconnu ou MAC non concordante => blocage instantané + alerte prioritaire.
  if (!du.rows.length || du.rows[0].mac_address !== mac) {
    await q(
      `INSERT INTO security_alert(imf_id,level,kind,attempted_identifier,imei,mac_address,message)
       VALUES (NULL,'critical','unknown_device',$1,$2,$3,$4)`,
      [String(identifier), imei || null, mac || null,
       'Tentative de connexion depuis un appareil non enrôlé — accès refusé.']);
    notifySecurityAlert({ kind: 'unknown_device', identifier, imei, mac });
    return res.status(403).json({ error: 'unknown_device', blocked: true,
      message: 'Appareil non reconnu. Accès bloqué. Une alerte a été transmise à votre institution.' });
  }

  const dev = du.rows[0];
  if (dev.status !== 'active')
    return res.status(403).json({ error: 'device_revoked', blocked: true,
      message: 'Ce terminal a été révoqué. Contactez votre superviseur.' });

  // Identifiant = nom d'utilisateur ou code collectrice ; vérification du PIN.
  const okPin = await bcrypt.compare(String(pin), dev.pin_hash);
  const identOk = String(identifier).trim().toLowerCase() === String(dev.user_name || '').trim().toLowerCase()
    || String(identifier).trim() === String(dev.imei);
  if (!okPin || !identOk) {
    await q(`INSERT INTO security_alert(imf_id,level,kind,attempted_identifier,imei,mac_address,message)
             VALUES ($1,'warning','bad_credentials',$2,$3,$4,'Échec d’authentification terrain')`,
      [dev.imf_id, String(identifier), imei, mac]);
    return res.status(401).json({ error: 'bad_credentials', message: 'Identifiant ou PIN incorrect' });
  }
  // Si l'identifiant saisi ne correspond pas, on bloque aussi (sécurité stricte).
  await q(`INSERT INTO security_alert(imf_id,level,kind,attempted_identifier,imei,mac_address,message)
           VALUES ($1,'info','device_use',$2,$3,$4,'Connexion terrain réussie')`,
    [dev.imf_id, dev.user_name, imei, mac]);
  res.json({ ok: true, device_id: dev.id, user_id: dev.user_id, holder_name: dev.holder_name,
    imf_id: dev.imf_id, pin_expired: false });
});

/** Statut du terminal + auto-blocage si perdu/volé (appelé au démarrage de l'app). */
r.get('/field/device-status', async (req, res) => {
  const { imei, mac } = deviceFromReq(req);
  const { rows } = await q('SELECT status FROM device WHERE imei=$1 AND mac_address=$2', [imei, mac]);
  if (!rows.length) return res.status(403).json({ error: 'unknown_device', blocked: true });
  res.json({ status: rows[0].status, blocked: rows[0].status !== 'active' });
});

export default r;
