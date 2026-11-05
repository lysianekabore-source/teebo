/* teebo — console admin : terminaux + alertes sécurité temps réel */
(function () {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let USERS = [];

  async function api(p, o) {
    const r = await fetch('/api/v1' + p, Object.assign({ credentials: 'include', headers: { 'Content-Type': 'application/json' } }, o || {}));
    let j = null; try { j = await r.json(); } catch (e) {}
    if (!r.ok) { const e = new Error((j && (j.message || j.error)) || ('Erreur ' + r.status)); e.status = r.status; throw e; }
    return j;
  }
  const LEVEL = { critical: 'danger', warning: 'warn', info: 'muted' };
  const KIND = { unknown_device: 'Appareil inconnu', device_revoked: 'Terminal révoqué', bad_credentials: 'Échec d\'authentification', device_use: 'Utilisation de terminal' };

  async function loadAlerts() {
    try {
      const r = await api('/security-alerts');
      $('#alert-count').textContent = r.unread + ' non lue(s)';
      const al = r.alerts || [];
      if (!al.length) { $('#alerts').innerHTML = '<div class="empty">Aucune alerte.</div>'; return; }
      $('#alerts').innerHTML = al.slice(0, 20).map((a) => `<div class="item" style="background:#fff;border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
          <div><b style="font-size:14px">${esc(KIND[a.kind] || a.kind)}</b>
          <div class="hint">${esc(a.details || '')}</div>
          <div class="hint">Identifiant : <b>${esc(a.attempted_identifier || '—')}</b> · IMEI ${esc(a.imei || '—')} · MAC ${esc(a.mac_address || '—')}</div></div>
          <div style="text-align:right"><span class="tag tag--${LEVEL[a.level] || 'muted'}">${esc(a.level)}</span>
          <div class="hint">${new Date(a.created_at).toLocaleString('fr-FR')}</div>
          ${a.is_read ? '' : `<button class="btn btn--ghost btn--sm" data-read="${a.id}" style="margin-top:8px">Marquer lu</button>`}</div>
        </div></div>`).join('');
      $('#alerts').querySelectorAll('[data-read]').forEach((b) => b.onclick = async () => { await api('/security-alerts/' + b.dataset.read + '/read', { method: 'POST' }); loadAlerts(); });
    } catch (e) { if (e.status === 401) location.href = '/login'; }
  }

  async function loadDevices() {
    try {
      const r = await api('/devices');
      const dev = r.devices || [];
      $('#dev-count').textContent = dev.length + ' terminal(aux)';
      if (!dev.length) { $('#devices').innerHTML = '<div class="empty">Aucun terminal enrôlé. Enrôlez un premier téléphone de collectrice.</div>'; return; }
      $('#devices').innerHTML = '<table class="tbl"><thead><tr><th>Collectrice</th><th>Terminal</th><th>Statut</th><th></th></tr></thead><tbody>' +
        dev.map((d) => `<tr><td><b>${esc(d.holder_name)}</b><div class="hint">${esc(d.user_name || '')}</div></td>
          <td><code>${esc(d.imei)}</code><div class="hint">MAC ${esc(d.mac_address)}</div></td>
          <td><span class="tag tag--${d.status === 'active' ? 'ok' : 'danger'}">${d.status === 'active' ? 'Actif' : 'Révoqué'}</span></td>
          <td style="text-align:right">${d.status === 'active'
            ? `<button class="btn btn--ghost btn--sm" data-rev="${d.id}">Révoquer</button>`
            : `<button class="btn btn--ghost btn--sm" data-rea="${d.id}">Réactiver</button>`}</td></tr>`).join('') + '</tbody></table>';
      $('#devices').querySelectorAll('[data-rev]').forEach((b) => b.onclick = async () => {
        if (!confirm('Révoquer ce terminal ? La session de la collectrice sera immédiatement fermée.')) return;
        await api('/devices/' + b.dataset.rev + '/revoke', { method: 'POST' }); loadDevices(); loadAlerts(); });
      $('#devices').querySelectorAll('[data-rea]').forEach((b) => b.onclick = async () => { await api('/devices/' + b.dataset.rea + '/reactivate', { method: 'POST' }); loadDevices(); });
    } catch (e) { if (e.status === 401) location.href = '/login';
      else $('#devices').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; }
  }

  async function enrollModal() {
    try { const r = await api('/org/users'); USERS = r.users || []; } catch (e) { USERS = []; }
    const uopts = USERS.map((u) => `<option value="${u.id}">${esc(u.full_name)} (${esc(u.role)})</option>`).join('');
    $('#modal-root').innerHTML = `<div class="modal-wrap"><div class="modal"><h3>Enrôler un terminal</h3>
      <p class="sub">Couplage obligatoire téléphone ↔ collectrice. Le terminal est refusé s'il n'est pas enrôlé ici.</p>
      <form id="f"><div class="fld"><label>Collectrice (utilisateur)</label><select id="user_id" required>${uopts || '<option value="">Aucun utilisateur disponible</option>'}</select></div>
      <div class="fld"><label>Nom de la collectrice</label><input id="holder_name" required></div>
      <div class="fld"><label>Date de naissance</label><input id="holder_birth" type="date" required></div>
      <div class="fld"><label>IMEI (15 chiffres)</label><input id="imei" inputmode="numeric" maxlength="15" required placeholder="123456789012345"></div>
      <div class="fld"><label>Adresse MAC</label><input id="mac_address" required placeholder="AA:BB:CC:DD:EE:FF"></div>
      <div class="fld"><label>Code PIN numérique (4 à 8 chiffres)</label><input id="pin" inputmode="numeric" maxlength="8" required></div>
      <div class="fld"><label>Téléphone (optionnel)</label><input id="phone_number"></div>
      <div class="alert alert--err" hidden id="e"></div>
      <div class="modal__nav"><button type="button" class="btn btn--ghost" id="cancel">Annuler</button><button class="btn btn--primary" type="submit">Enrôler</button></div></form></div></div>`;
    $('#cancel').onclick = () => { $('#modal-root').innerHTML = ''; };
    $('#f').onsubmit = async (ev) => { ev.preventDefault();
      try { await api('/devices', { method: 'POST', body: {
        user_id: $('#user_id').value, holder_name: $('#holder_name').value.trim(), holder_birth: $('#holder_birth').value,
        imei: $('#imei').value.trim(), mac_address: $('#mac_address').value.trim(), pin: $('#pin').value.trim(), phone_number: $('#phone_number').value.trim() } });
        $('#modal-root').innerHTML = ''; loadDevices();
      } catch (err) { const e = $('#e'); e.textContent = err.message; e.hidden = false; }
    };
  }

  $('#btn-enroll').onclick = enrollModal;
  loadAlerts(); loadDevices();
  setInterval(loadAlerts, 15000); // alertes temps réel
})();
