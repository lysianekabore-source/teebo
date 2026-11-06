/* teebo — page Essai & échéances */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(p, o) {
    const r = await fetch('/api/v1' + p, Object.assign({ credentials: 'include', headers: { 'Content-Type': 'application/json' } }, o || {}));
    let j = null; try { j = await r.json(); } catch (e) {}
    if (!r.ok) { const e = new Error((j && (j.error || j.message)) || ('Erreur ' + r.status)); e.status = r.status; e.data = j; throw e; }
    return j;
  }
  const PLANS = [
    { code: 'essentiel', name: 'Essentiel', price: 'Sur devis', feats: ['Jusqu\'à 5 agences', 'Collecte mobile', 'Reporting BCEAO de base'] },
    { code: 'pro', name: 'Professionnel', price: 'Sur devis', feats: ['Agences illimitées', 'Espaces clients en ligne', 'Autorisations fines inter-entités'] },
    { code: 'gere', name: 'Délégué', price: 'Sur devis', feats: ['Infogérance', 'Personnalisation des états', 'Accompagnement terrain'] }
  ];

  function renderPlans() {
    $('#plans').innerHTML = PLANS.map((p) => `<div class="plan"><h4>${esc(p.name)}</h4><div class="price">${esc(p.price)}</div>
      <ul>${p.feats.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>`).join('');
  }

  function renderTimeline(days) {
    const J = [1, 15, 25, 30, 31];
    $('#timeline').innerHTML = J.map((d) => {
      const reached = days != null ? (30 - days) >= d : false;
      const txt = d === 1 ? 'Début de l\'essai gratuit de 30 jours.'
        : d === 15 ? 'Mi-parcours de l\'essai.'
        : d === 25 ? 'Affichage du bandeau : jours restants et invitation à contacter teebo.'
        : d === 30 ? 'Dernier jour de l\'essai gratuit.'
        : 'Application désactivée (utilisateurs et admin bloqués).';
      return `<div style="display:flex;gap:14px;padding:12px 0;border-bottom:1px solid var(--line);align-items:flex-start">
        <b style="flex:0 0 40px;height:40px;border-radius:50%;background:${reached ? 'var(--navy)' : '#eef0f6'};color:${reached ? 'var(--neon)' : 'var(--muted)'};display:flex;align-items:center;justify-content:center;font-weight:800">J${d}</b>
        <div><b style="font-size:14px">${esc(txt)}</b>${d === 31 ? '<div class="hint">Réactivation immédiate dès validation de la formule par teebo.</div>' : ''}</div></div>`;
    }).join('');
  }

  function renderKpis(s) {
    const days = s.days_left, locked = s.locked;
    $('#trial-kpis').innerHTML = `
      <div class="kpi ${locked ? '' : 'kpi--dark'}"><b>${days == null ? '∞' : days}</b><span>jours d'essai restants</span></div>
      <div class="kpi"><b>30</b><span>jours d'essai total</span></div>
      <div class="kpi"><b>25</b><span>alerte à partir du jour</span></div>
      <div class="kpi"><b>${locked ? '31+' : '31'}</b><span>désactivation au jour</span></div>`;
  }

  async function load() {
    renderPlans();
    let s;
    try { s = await api('/subscription/status'); }
    catch (e) {
      if (e.status === 401) { location.href = '/login'; return; }
      // Repli hors-ligne / API indisponible : on affiche la présentation statique.
      $('#status-chips').innerHTML = '<span class="chip">Essai gratuit — <b>30 jours</b></span>';
      renderKpis({ days_left: null, locked: false });
      renderTimeline(null);
      return;
    }
    const statusLabel = { trial: 'Essai gratuit', active: 'Actif', disabled: 'Désactivé', grace: 'Grâce' }[s.status] || s.status;
    $('#status-chips').innerHTML = `<span class="chip ${s.status === 'active' ? 'chip--ok' : s.locked ? 'chip--warn' : 'chip--neon'}">Statut : <b>${esc(statusLabel)}</b></span>`;
    renderKpis(s);

    const b = $('#trial-banner');
    if (s.banner) { b.className = 'alert alert--warn'; b.innerHTML = '⏳ ' + esc(s.banner.message); b.hidden = false; }
    else if (s.locked) { b.className = 'alert alert--err'; b.textContent = 'Votre essai est terminé. Contactez teebo pour activer votre formule.'; b.hidden = false; }

    renderTimeline(s.days_left);
  }
  load();
})();
