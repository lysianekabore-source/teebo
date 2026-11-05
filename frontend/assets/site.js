/* teebo — assistant d'inscription IMF (production)
   Parcours : 1) Formulaire IMF  2) Offre + formule  3) Facture proforma
             4) Confirmation approbation teebo (essai 30 j)
   Aucun gestionnaire inline (compatible CSP stricte). */
(function () {
  'use strict';

  var API = ''; // même origine en production
  var root = document.getElementById('wizard');

  // --- Grille tarifaire (accueil) ---------------------------------------
  // Les montants proviennent du paramétrage des formules (pas de valeur figée) ;
  // un repli statique n'est utilisé que si l'API est injoignable au chargement.
  var FALLBACK_TIERS = [
    { code:'starter', label:'Starter', desc:'Pour les IMF qui démarrent leur digitalisation.',
      price_cents:4500000, billing_cycle:'mensuel', max_agencies:3, max_users:15,
      features:['3 agences','15 utilisateurs','Collecte mobile','Support e-mail'] },
    { code:'business', label:'Business', desc:'Pour les IMF multi-agences en croissance.',
      price_cents:12000000, billing_cycle:'mensuel', max_agencies:10, max_users:60,
      features:['10 agences','60 utilisateurs','Collecte mobile','Reporting BCEAO','Support prioritaire'] },
    { code:'enterprise', label:'Enterprise', desc:'Pour les réseaux et institutions matures.',
      price_cents:35000000, billing_cycle:'mensuel', max_agencies:null, max_users:null,
      features:['Agences illimitées','Utilisateurs illimités','Collecte mobile','Reporting BCEAO','Sécurité renforcée','Support dédié'] }
  ];

  function renderPricing(plans) {
    var host = document.getElementById('pricing');
    if (!host) return;
    host.innerHTML = '';
    if (!plans || !plans.length) {
      host.appendChild(el('p', 'pricing__loading', 'Tarifs momentanément indisponibles. Contactez-nous : hello@teebo.africa'));
      return;
    }
    plans.forEach(function (p, i) {
      var feats = p.features;
      if (typeof feats === 'string') { try { feats = JSON.parse(feats); } catch (_) { feats = []; } }
      var best = i === 1;
      var t = el('article', 'tier' + (best ? ' tier--best' : ''));
      var caps = [];
      if (p.max_agencies) caps.push(p.max_agencies + ' agences');
      if (p.max_users) caps.push(p.max_users + ' utilisateurs');
      t.innerHTML =
        (best ? '<span class="tier__ribbon">Le plus choisi</span>' : '') +
        '<div class="tier__name">' + esc(p.label || p.name) + '</div>' +
        '<div class="tier__desc">' + esc(p.desc || p.description || '') + '</div>' +
        '<div class="tier__price">' + money(p.price_cents) + '</div>' +
        '<div class="tier__cycle">/ ' + esc(p.billing_cycle || 'mensuel') + '</div>' +
        (caps.length ? '<div class="tier__cap">' + esc(caps.join(' · ')) + '</div>' : '') +
        '<ul>' + (feats || []).map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul>' +
        '<a class="btn ' + (best ? '' : 'btn--primary') + '" href="#inscription">Demander un accès</a>';
      host.appendChild(t);
    });
  }

  // Rendu immédiat de la grille tarifaire (repli), puis affinage via l'API.
  renderPricing(FALLBACK_TIERS);

  if (!root) return;

  var state = {
    step: 1,
    countries: [],
    plans: [],
    imf: null,          // { request_id, imf_id, imf_code }
    selectedPlan: null,
    proforma: null
  };

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(cents) {
    var v = Number(cents || 0) / 100;
    return v.toLocaleString('fr-FR') + ' FCFA';
  }
  function api(path, method, body) {
    return fetch(API + path, {
      method: method || 'GET',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      credentials: 'same-origin',
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.error || 'Erreur');
        return d;
      });
    });
  }

  function renderSteps() {
    var wrap = el('div', 'wiz__steps');
    var labels = ['IMF', 'Formule', 'Proforma', 'Confirmation'];
    labels.forEach(function (lab, i) {
      var n = i + 1;
      var s = el('div', 'wiz__step' + (state.step === n ? ' active' : (state.step > n ? ' done' : '')));
      s.appendChild(el('i', null, state.step > n ? '✓' : String(n)));
      s.appendChild(document.createTextNode(lab));
      wrap.appendChild(s);
      if (i < labels.length - 1) wrap.appendChild(el('div', 'wiz__sep'));
    });
    return wrap;
  }

  function field(label, id, opts) {
    opts = opts || {};
    var f = el('div', 'field' + (opts.full ? ' field--full' : ''));
    var l = el('label'); l.setAttribute('for', id); l.textContent = label;
    f.appendChild(l);
    var input;
    if (opts.type === 'select') {
      input = el('select');
      (opts.options || []).forEach(function (o) {
        var op = el('option'); op.value = o.value; op.textContent = o.label; input.appendChild(op);
      });
    } else {
      input = el('input');
      input.type = opts.type || 'text';
      if (opts.placeholder) input.placeholder = opts.placeholder;
      if (opts.inputmode) input.setAttribute('inputmode', opts.inputmode);
    }
    input.id = id; input.name = id;
    if (opts.required) input.required = true;
    f.appendChild(input);
    var err = el('p', 'field__err'); err.hidden = true; err.setAttribute('data-for', id);
    f.appendChild(err);
    f._input = input;
    return f;
  }

  function showErr(panel, id, msg) {
    var input = panel.querySelector('#' + id);
    var err = panel.querySelector('.field__err[data-for="' + id + '"]');
    if (!input || !err) return;
    if (msg) { input.setAttribute('aria-invalid', 'true'); err.textContent = msg; err.hidden = false; }
    else { input.removeAttribute('aria-invalid'); err.hidden = true; err.textContent = ''; }
  }
  function clearErrs(panel) {
    panel.querySelectorAll('.field__err').forEach(function (e) { e.hidden = true; e.textContent = ''; });
    panel.querySelectorAll('[aria-invalid]').forEach(function (e) { e.removeAttribute('aria-invalid'); });
  }

  function alertBox(type, msg) {
    return el('div', 'alert alert--' + type, esc(msg));
  }

  // ================= ÉTAPE 1 : FORMULAIRE =================
  function renderForm() {
    var panel = el('div', 'panel');
    panel.appendChild(el('h3', null, "Informations de l'IMF"));
    panel.appendChild(el('p', 'panel__hint', 'Tous les champs sont requis. La sélection du pays ajuste automatiquement l’indicatif téléphonique.'));

    var errSlot = el('div'); panel.appendChild(errSlot);

    var g = el('div', 'grid2');
    g.appendChild(field('Nom', 'lastname', { required: true, placeholder: 'Nom du responsable' }));
    g.appendChild(field('Prénom', 'firstname', { required: true, placeholder: 'Prénom du responsable' }));
    g.appendChild(field('Poste occupé', 'position', { required: true, placeholder: 'Ex : Directeur général' }));
    g.appendChild(field('Nom de l’IMF', 'imf_name', { required: true, placeholder: 'Ex : Crédit Solidarité' }));
    g.appendChild(field('Nom de l’admin de l’IMF', 'admin_name', { required: true, placeholder: 'Administrateur principal' }));
    g.appendChild(field('Type d’IMF', 'imf_type', { type: 'select', required: true, options: [
      { value: '', label: 'Sélectionnez…' }, { value: 'SA', label: 'SA — Société anonyme' }, { value: 'SCOOP', label: 'SCOOP — Coopérative' }] }));
    panel.appendChild(g);

    var g2 = el('div', 'grid2');
    g2.appendChild(field('Pays (UEMOA)', 'country_code', { type: 'select', required: true, options: [{ value: '', label: 'Sélectionnez…' }] }));
    g2.appendChild(field('Ville siège de l’IMF', 'city', { required: true, placeholder: 'Ex : Ouagadougou' }));
    panel.appendChild(g2);

    // Téléphone WhatsApp avec indicatif auto
    var waf = el('div', 'field');
    waf.appendChild(Object.assign(el('label'), { textContent: 'Numéro WhatsApp de l’IMF' }));
    waf.querySelector('label').setAttribute('for', 'whatsapp');
    var wgrp = el('div', 'phone-group');
    var dial1 = el('div', 'dial', '+---'); dial1.id = 'dial-whatsapp';
    var wIn = el('input'); wIn.type = 'tel'; wIn.id = 'whatsapp'; wIn.name = 'whatsapp'; wIn.placeholder = '00 00 00 00'; wIn.required = true;
    wgrp.appendChild(dial1); wgrp.appendChild(wIn); waf.appendChild(wgrp);
    var werr = el('p', 'field__err'); werr.hidden = true; werr.setAttribute('data-for', 'whatsapp'); waf.appendChild(werr);
    panel.appendChild(waf);

    // Numéro d'appel IMF avec indicatif auto
    var phf = el('div', 'field');
    var lbl2 = el('label'); lbl2.setAttribute('for', 'phone_main'); lbl2.textContent = 'Numéro d’appel de l’IMF';
    phf.appendChild(lbl2);
    var pgrp = el('div', 'phone-group');
    var dial2 = el('div', 'dial', '+---'); dial2.id = 'dial-phone';
    var pIn = el('input'); pIn.type = 'tel'; pIn.id = 'phone_main'; pIn.name = 'phone_main'; pIn.placeholder = '00 00 00 00'; pIn.required = true;
    pgrp.appendChild(dial2); pgrp.appendChild(pIn); phf.appendChild(pgrp);
    var perr = el('p', 'field__err'); perr.hidden = true; perr.setAttribute('data-for', 'phone_main'); phf.appendChild(perr);
    panel.appendChild(phf);

    var g3 = el('div', 'grid2');
    g3.appendChild(field('Montant du capital social (FCFA)', 'capital', { required: true, inputmode: 'numeric', placeholder: 'Ex : 25 000 000' }));
    g3.appendChild(field('Numéro d’agrément BCEAO', 'bceao_agreement_no', { required: true, placeholder: 'Ex : 2024-XXX-IM-001' }));
    panel.appendChild(g3);

    panel.appendChild(field('Email valide de l’IMF', 'email', { type: 'email', required: true, placeholder: 'contact@monimf.bf' }));

    var nav = el('div', 'wiz__nav');
    var btn = el('button', 'btn btn--primary', 'Continuer');
    btn.type = 'button';
    nav.appendChild(btn);
    panel.appendChild(nav);

    // Remplissage pays
    var countrySel = panel.querySelector('#country_code');
    state.countries.forEach(function (c) {
      var o = el('option'); o.value = c.code; o.textContent = c.name + ' (' + c.dial + ')'; countrySel.appendChild(o);
    });

    function syncDial() {
      var c = state.countries.find(function (x) { return x.code === countrySel.value; });
      var d = c ? c.dial : '+---';
      dial1.textContent = d; dial2.textContent = d;
    }
    countrySel.addEventListener('change', syncDial);

    btn.addEventListener('click', function () {
      clearErrs(panel); errSlot.innerHTML = '';
      var v = {
        lastname: panel.querySelector('#lastname').value.trim(),
        firstname: panel.querySelector('#firstname').value.trim(),
        position: panel.querySelector('#position').value.trim(),
        imf_name: panel.querySelector('#imf_name').value.trim(),
        admin_name: panel.querySelector('#admin_name').value.trim(),
        imf_type: panel.querySelector('#imf_type').value,
        country_code: countrySel.value,
        city: panel.querySelector('#city').value.trim(),
        email: panel.querySelector('#email').value.trim(),
        bceao_agreement_no: panel.querySelector('#bceao_agreement_no').value.trim(),
        whatsapp: dial1.textContent + ' ' + wIn.value.replace(/^0+/, ''),
        phone_main: dial2.textContent + ' ' + pIn.value.replace(/^0+/, '')
      };
      var capRaw = panel.querySelector('#capital').value.replace(/[^0-9]/g, '');
      v.capital_cents = capRaw ? Number(capRaw) * 100 : 0;

      var errors = false;
      [['lastname','Le nom est requis.'],['firstname','Le prénom est requis.'],['position','Le poste est requis.'],
       ['imf_name','Le nom de l’IMF est requis.'],['admin_name','Le nom de l’admin est requis.'],['city','La ville est requise.'],
       ['bceao_agreement_no','Le n° d’agrément est requis.']].forEach(function (p) {
        if (!v[p[0]]) { showErr(panel, p[0], p[1]); errors = true; }
      });
      if (!v.country_code) { showErr(panel, 'country_code', 'Le pays est requis.'); errors = true; }
      if (!v.imf_type) { showErr(panel, 'imf_type', 'Le type d’IMF est requis.'); errors = true; }
      if (!v.capital_cents) { showErr(panel, 'capital', 'Le capital social est requis.'); errors = true; }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) { showErr(panel, 'email', 'Email invalide.'); errors = true; }
      if (wIn.value.replace(/\D/g, '').length < 6) { showErr(panel, 'whatsapp', 'Numéro WhatsApp invalide.'); errors = true; }
      if (pIn.value.replace(/\D/g, '').length < 6) { showErr(panel, 'phone_main', 'Numéro d’appel invalide.'); errors = true; }
      if (errors) {
        errSlot.appendChild(alertBox('err', 'Veuillez corriger les champs signalés.'));
        return;
      }

      btn.disabled = true;
      var old = btn.textContent; btn.textContent = 'Envoi…';
      api('/api/v1/requests', 'POST', v).then(function (d) {
        state.imf = d;
        state.step = 2;
        render();
      }).catch(function (e) {
        btn.disabled = false; btn.textContent = old;
        errSlot.appendChild(alertBox('err', messageFr(e.message)));
      });
    });

    return panel;
  }

  function messageFr(code) {
    var m = {
      missing_field: 'Un champ obligatoire est manquant.',
      country_not_uemoa: 'Sélectionnez un pays de l’UEMOA.',
      invalid_imf_type: 'Type d’IMF invalide (SA ou SCOOP).',
      invalid_email: 'Email invalide.',
      plan_not_found: 'Formule introuvable.',
      no_proforma: 'Aucune facture proforma à valider.',
      Erreur: 'Une erreur est survenue. Réessayez.'
    };
    return m[code] || 'Une erreur est survenue. Réessayez.';
  }

  // ================= ÉTAPE 2 : OFFRE + FORMULE =================
  function renderPlans() {
    var panel = el('div', 'panel');
    panel.appendChild(el('h3', null, 'Votre offre financière'));
    panel.appendChild(el('p', 'panel__hint', 'Sélectionnez la formule qui correspond à votre institution. Vous pourrez en changer plus tard.'));
    var errSlot = el('div'); panel.appendChild(errSlot);

    var plans = el('div', 'plans');
    state.plans.forEach(function (p) {
      var card = el('button', 'plan'); card.type = 'button';
      var feats = (p.features || []);
      if (typeof feats === 'string') { try { feats = JSON.parse(feats); } catch (_) { feats = []; } }
      card.innerHTML =
        '<h4>' + esc(p.label) + '</h4>' +
        '<div class="price">' + money(p.price_cents) + '</div>' +
        '<div class="cycle">/ ' + esc(p.billing_cycle) + '</div>' +
        '<ul>' + feats.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul>';
      card.addEventListener('click', function () {
        panel.querySelectorAll('.plan').forEach(function (x) { x.classList.remove('chosen'); });
        card.classList.add('chosen');
        state.selectedPlan = p;
        nextBtn.disabled = false;
      });
      plans.appendChild(card);
    });
    panel.appendChild(plans);

    var nav = el('div', 'wiz__nav');
    var back = el('button', 'btn btn--ghost', 'Retour'); back.type = 'button';
    back.style.color = 'var(--ink)'; back.style.borderColor = 'var(--line)';
    back.addEventListener('click', function () { state.step = 1; render(); });
    var nextBtn = el('button', 'btn btn--primary', 'Choisir cette formule'); nextBtn.type = 'button'; nextBtn.disabled = true;
    nextBtn.addEventListener('click', function () {
      if (!state.selectedPlan) return;
      nextBtn.disabled = true; var old = nextBtn.textContent; nextBtn.textContent = 'Génération…';
      api('/api/v1/requests/' + state.imf.request_id + '/select-plan', 'POST', { plan_code: state.selectedPlan.code })
        .then(function (d) { state.proforma = d.proforma; state.step = 3; render(); })
        .catch(function (e) { nextBtn.disabled = false; nextBtn.textContent = old; errSlot.appendChild(alertBox('err', messageFr(e.message))); });
    });
    nav.appendChild(back); nav.appendChild(nextBtn);
    panel.appendChild(nav);
    return panel;
  }

  // ================= ÉTAPE 3 : FACTURE PROFORMA =================
  function renderProforma() {
    var p = state.proforma || {};
    var panel = el('div', 'panel');
    panel.appendChild(el('h3', null, 'Facture proforma'));
    panel.appendChild(el('p', 'panel__hint', 'Vérifiez les informations puis validez pour transmettre votre demande à teebo.'));
    var errSlot = el('div'); panel.appendChild(errSlot);

    var box = el('div', 'proforma');
    box.innerHTML =
      '<div class="proforma__head"><b>Facture proforma n° ' + esc(p.no) + '</b><small>teebo · hello@teebo.africa</small></div>' +
      '<table>' +
      '<tr><td>Institution</td><td>' + esc((state.imf && state.imf.imf_code) || '') + '</td></tr>' +
      '<tr><td>Formule</td><td>' + esc(p.plan) + '</td></tr>' +
      '<tr><td>Abonnement</td><td>' + money(p.amount_cents) + ' / ' + esc(p.billing_cycle) + '</td></tr>' +
      '<tr><td>Période d’essai</td><td>' + esc(p.trial_days) + ' jours calendaires — gratuit</td></tr>' +
      '<tr class="total"><td>Total à payer pendant l’essai</td><td>0 FCFA</td></tr>' +
      '</table>';
    panel.appendChild(box);

    // Lien vers la facture proforma imprimable (PDF via HTML) — ouverte dans
    // un nouvel onglet, avec logo + mentions légales de l'IMF.
    if (p.url) {
      var dl = el('p', 'panel__hint');
      dl.style.marginTop = '14px';
      var a = el('a'); a.href = p.url; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = 'Télécharger / imprimer la facture proforma (PDF)';
      a.style.cssText = 'color:var(--navy);font-weight:700;text-decoration:underline';
      dl.appendChild(a);
      panel.appendChild(dl);
    }

    var nav = el('div', 'wiz__nav');
    var back = el('button', 'btn btn--ghost', 'Retour'); back.type = 'button';
    back.style.color = 'var(--ink)'; back.style.borderColor = 'var(--line)';
    back.addEventListener('click', function () { state.step = 2; render(); });
    var ok = el('button', 'btn btn--primary', 'Valider la facture proforma'); ok.type = 'button';
    ok.addEventListener('click', function () {
      ok.disabled = true; var old = ok.textContent; ok.textContent = 'Validation…';
      api('/api/v1/requests/' + state.imf.request_id + '/validate-proforma', 'POST', {})
        .then(function () { state.step = 4; render(); })
        .catch(function (e) { ok.disabled = false; ok.textContent = old; errSlot.appendChild(alertBox('err', messageFr(e.message))); });
    });
    nav.appendChild(back); nav.appendChild(ok);
    panel.appendChild(nav);
    return panel;
  }

  // ================= ÉTAPE 4 : CONFIRMATION =================
  function renderDone() {
    var panel = el('div', 'panel done');
    panel.appendChild(el('div', 'done__icon', '✓'));
    panel.appendChild(el('h3', null, 'Demande transmise à teebo'));
    panel.appendChild(el('p', null, 'Votre facture proforma a bien été validée. L’équipe teebo va approuver votre demande d’accès.'));
    panel.appendChild(el('p', null, 'Une fois approuvée, vous recevrez votre <b>code d’accès administrateur</b> par WhatsApp ou e-mail, avec un <b>essai gratuit de 30 jours calendaires</b>. À la première connexion, vous créerez votre propre mot de passe.'));

    // Prochaines étapes claires (optimisation du parcours après le clic).
    var steps = el('ol', 'done__next');
    steps.innerHTML =
      '<li><b>1.</b> teebo examine et approuve votre demande.</li>' +
      '<li><b>2.</b> Vous recevez votre code d’accès (WhatsApp / e-mail).</li>' +
      '<li><b>3.</b> Vous vous connectez et créez votre mot de passe.</li>' +
      '<li><b>4.</b> Votre facture définitive est émise dans votre espace.</li>';
    panel.appendChild(steps);

    var ref = state.proforma && state.proforma.no;
    if (ref) panel.appendChild(el('div', 'ref', 'Facture proforma : ' + esc(ref)));
    panel.appendChild(el('div', 'ref', 'Référence IMF : ' + esc((state.imf && state.imf.imf_code) || '')));

    var actions = el('div', 'done__actions');
    if (state.proforma && state.proforma.url) {
      var a = el('a', 'btn btn--ghost'); a.href = state.proforma.url; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = 'Télécharger ma facture proforma';
      a.style.color = 'var(--ink)'; a.style.borderColor = 'var(--line)';
      actions.appendChild(a);
    }
    var home = el('a', 'btn btn--primary'); home.href = '/login'; home.textContent = 'Accéder à la connexion';
    actions.appendChild(home);
    panel.appendChild(actions);
    return panel;
  }

  function render() {
    root.innerHTML = '';
    root.appendChild(renderSteps());
    if (state.step === 1) root.appendChild(renderForm());
    else if (state.step === 2) root.appendChild(renderPlans());
    else if (state.step === 3) root.appendChild(renderProforma());
    else root.appendChild(renderDone());
  }

  // Données de repli hors-ligne (si l'API n'est pas joignable au chargement).
  var FALLBACK_COUNTRIES = [
    { code:'BJ', name:'Bénin', dial:'+229' }, { code:'BF', name:'Burkina Faso', dial:'+226' },
    { code:'CI', name:"Côte d'Ivoire", dial:'+225' }, { code:'GW', name:'Guinée-Bissau', dial:'+245' },
    { code:'ML', name:'Mali', dial:'+223' }, { code:'NE', name:'Niger', dial:'+227' },
    { code:'SN', name:'Sénégal', dial:'+221' }, { code:'TG', name:'Togo', dial:'+228' }
  ];
  var FALLBACK_PLANS = [];

  // Chargement initial (pays + formules)
  Promise.all([
    api('/api/v1/requests/uemoa-countries'),
    api('/api/v1/requests/plans')
  ]).then(function (res) {
    state.countries = (res[0] && res[0].countries) || [];
    state.plans = (res[1] && res[1].plans) || [];
    if (!state.countries.length) state.countries = FALLBACK_COUNTRIES;
    if (state.plans.length) renderPricing(state.plans);
    render();
  }).catch(function () {
    state.countries = FALLBACK_COUNTRIES;
    state.plans = FALLBACK_PLANS;
    render();
  });
})();
