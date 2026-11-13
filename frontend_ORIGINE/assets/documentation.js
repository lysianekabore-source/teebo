/* teebo — documentation : modes de connexion client */
(function () {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  fetch('/api/v1/client-login-modes', { credentials: 'include' })
    .then((r) => r.json())
    .then((r) => {
      const el = document.getElementById('modes');
      el.innerHTML = (r.modes || []).map((m) => `<div class="plan" style="cursor:default;margin-bottom:12px">
        <h4>${esc(m.label)}</h4><p style="color:var(--muted);font-size:13.5px;margin-top:6px">${esc(m.description)}</p></div>`).join('');
    })
    .catch(() => { document.getElementById('modes').innerHTML = '<div class="empty">Documentation indisponible hors-ligne.</div>'; });
})();
