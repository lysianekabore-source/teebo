/* teebo — écran d'autorisation fine (visibilité inter-entités) */
(function () {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let UNITS = [];

  async function api(p, o) {
    const r = await fetch('/api/v1' + p, Object.assign({ credentials: 'include', headers: { 'Content-Type': 'application/json' } }, o || {}));
    let j = null; try { j = await r.json(); } catch (e) {}
    if (!r.ok) { const e = new Error((j && (j.message || j.error)) || ('Erreur ' + r.status)); e.status = r.status; throw e; }
    return j;
  }

  async function load() {
    try {
      const r = await api('/visibility-grants');
      UNITS = r.units || [];
      $('#policy').textContent = 'Politique par défaut : ' + r.default_policy + '. Une unité ne voit que ses propres données tant qu\'un droit ne lui est pas accordé.';
      $('#count').textContent = (r.grants || []).filter((g) => g.active).length + ' active(s)';
      const active = (r.grants || []).filter((g) => g.active);
      if (!active.length) { $('#grants').innerHTML = '<div class="empty">Aucune autorisation accordée. Chaque entité reste strictement cloisonnée.</div>'; return; }
      $('#grants').innerHTML = '<table class="tbl"><thead><tr><th>Source</th><th>Destinataire</th><th>Portée</th><th></th></tr></thead><tbody>' +
        active.map((g) => `<tr><td><b>${esc(g.grantor_name)}</b></td><td>${esc(g.grantee_name)}</td>
          <td><span class="tag tag--ok">${g.scope === 'read_balances' ? 'Lecture des soldes' : 'Lecture des opérations'}</span></td>
          <td style="text-align:right"><button class="btn btn--ghost btn--sm" data-rev="${g.id}">Révoquer</button></td></tr>`).join('') + '</tbody></table>';
      $('#grants').querySelectorAll('[data-rev]').forEach((b) => b.onclick = async () => {
        if (!confirm('Révoquer cette autorisation ? L\'entité retrouvera le cloisonnement par défaut.')) return;
        await api('/visibility-grants/' + b.dataset.rev, { method: 'DELETE' }); load();
      });
    } catch (e) { if (e.status === 401) location.href = '/login';
      else $('#grants').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; }
  }

  function newModal() {
    const opts = (sel) => UNITS.map((u) => `<option value="${u.id}" ${sel === u.id ? 'selected' : ''}>${esc(u.name)} (${esc(u.kind)})</option>`).join('');
    $('#modal-root').innerHTML = `<div class="modal-wrap"><div class="modal"><h3>Accorder une visibilité inter-entités</h3>
      <p class="sub">L'unité source autorise l'unité destinataire à lire ses données. Révoquable à tout moment.</p>
      <div class="fld"><label>Unité source (propriétaire des données)</label><select id="g-src"><option value="">Sélectionner…</option>${opts()}</select></div>
      <div class="fld"><label>Unité destinataire (autorisée à lire)</label><select id="g-dst"><option value="">Sélectionner…</option>${opts()}</select></div>
      <div class="fld"><label>Portée</label><select id="g-scope"><option value="read_operations">Lecture des opérations</option><option value="read_balances">Lecture des soldes</option></select></div>
      <div class="alert alert--err" hidden id="g-err"></div>
      <div class="modal__nav"><button class="btn btn--ghost" id="g-cancel">Annuler</button><button class="btn btn--primary" id="g-ok">Accorder</button></div>
    </div></div>`;
    $('#g-cancel').onclick = () => { $('#modal-root').innerHTML = ''; };
    $('#g-ok').onclick = async () => {
      const src = $('#g-src').value, dst = $('#g-dst').value, scope = $('#g-scope').value;
      if (!src || !dst) { const e = $('#g-err'); e.textContent = 'Sélectionnez les deux unités.'; e.hidden = false; return; }
      if (src === dst) { const e = $('#g-err'); e.textContent = 'Les deux unités doivent être différentes.'; e.hidden = false; return; }
      try { await api('/visibility-grants', { method: 'POST', body: { grantor_unit_id: src, grantee_unit_id: dst, scope } });
        $('#modal-root').innerHTML = ''; load();
      } catch (err) { const e = $('#g-err'); e.textContent = err.message; e.hidden = false; }
    };
  }

  $('#btn-new').onclick = newModal;
  load();
})();
