
/* teebo — assistant d'inscription IMF (production)
   Parcours : 1) Formulaire IMF  2) Offre unique  3) Facture proforma
             4) Confirmation approbation teebo (essai 30 j)
   Aucun gestionnaire inline (compatible CSP stricte). */
(function () {
  'use strict';

  var API = ''; // même origine en production
  var root = document.getElementById('wizard');

  // --- Offre unique (accueil) -------------------------------------------
  // teebo propose UNE SEULE offre, transparente, sans palier :
  //   • Abonnement mensuel de base : 75 000 FCFA / mois ;
  //   • Cycle annuel : remise de 15 % (63 750 FCFA / mois, soit 765 000 / an) ;
  //   • Licence unique d'activation : 250 000 FCFA, facturée APRÈS l'essai ;
  //   • Essai gratuit de 30 jours calendaires, sans engagement initial.
  // Le prix mensuel de base vient de l'API (plan unique) ; un repli statique
  // garantit un affichage même si l'API est injoignable au chargement.
  var MONTHLY_BASE_CENTS = 7500000;   // 75 000 FCFA / mois
  var LICENCE_CENTS = 25000000;       // 250 000 FCFA (frais unique d'activation)
  var ANNUAL_DISCOUNT = 0.15;         // -15 % sur l'abonnement en cycle annuel
  var TRIAL_DAYS = 30;

  var FALLBACK_PLAN = {
    code: 'standard', label: 'teeBo',
    desc: 'L’offre unique et transparente pour toute IMF de la zone UEMOA.',
    price_cents: MONTHLY_BASE_CENTS, billing_cycle: 'mensuel',
    max_agencies: null, max_users: null,
    features: ['Agences illimitées', 'Utilisateurs illimités',
      'Collecte de proximité & synchronisation terrain', 'Gestion multi-agences',
      'Rapports prudentiels DSC-SFD', 'Sécurité bancaire & cloisonnement des données',
      'Support inclus']
  };
  // Compat : la grille d'accueil et l'inscription partagent la même offre.
  var FALLBACK_TIERS = [FALLBACK_PLAN];

  // Périodicité choisie sur la grille d'accueil : 'mensuel' | 'annuel'.
  var landingBilling = 'mensuel';

  // Abonnement NET affiché selon le cycle (remise annuelle déjà incluse).
  function subNet(monthlyCents, cycle) {
    if (cycle === 'annuel') return Math.round(monthlyCents * 12 * (1 - ANNUAL_DISCOUNT));
    return Math.round(monthlyCents);
  }
  // Mensualisation affichée (« équivalent / mois ») selon le cycle.
  function perMonth(monthlyCents, cycle) {
    if (cycle === 'annuel') return Math.round(monthlyCents * (1 - ANNUAL_DISCOUNT));
    return Math.round(monthlyCents);
  }

  function landingMonthly() {
    var p = (state && state.plans && state.plans[0]) ? state.plans[0] : FALLBACK_PLAN;
    var c = Number(p.price_cents) || MONTHLY_BASE_CENTS;
    return c > 0 ? c : MONTHLY_BASE_CENTS;
  }

  // Rendu de la section tarifs : carte d'essai gratuit (au premier plan) +
  // carte de l'offre unique, avec bascule Mensuel / Annuel (−15 %).
  function renderPricing() {
    var host = document.getElementById('pricing');
    if (!host) return;
    var monthly = landingMonthly();
    var cycle = landingBilling;
    var net = subNet(monthly, cycle);
    var pm = perMonth(monthly, cycle);
    var total = LICENCE_CENTS + net;
    var savings = Math.round(monthly * 12 * ANNUAL_DISCOUNT);

    host.innerHTML = '';

    // --- Bascule Mensuel / Annuel ---
    var toggle = el('div', 'ptoggle');
    [['mensuel', 'Mensuel'], ['annuel', 'Annuel · −15 %']].forEach(function (opt) {
      var active = cycle === opt[0];
      var b = el('button', 'ptoggle__btn' + (active ? ' is-active' : ''), esc(opt[1]));
      b.type = 'button';
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
      b.addEventListener('click', function () {
        if (landingBilling === opt[0]) return;
        landingBilling = opt[0];
        renderPricing();
      });
      toggle.appendChild(b);
    });
    host.appendChild(toggle);

    var grid = el('div', 'offer');

    // --- Carte ESSAI GRATUIT (au premier plan) ---
    var trial = el('article', 'trial-card');
    trial.innerHTML =
      '<div class="trial-card__badge">\uD83C\uDF81 Essai gratuit — 30 jours</div>' +
      '<p class="trial-card__lead">Activez votre accès complet sans aucun engagement financier initial. ' +
      'Testez toutes les fonctionnalités de collecte de proximité, de synchronisation terrain et de ' +
      'gestion multi-agences en conditions réelles.</p>' +
      '<ul class="trial-card__list">' +
        '<li><b>0 FCFA</b> pendant 30 jours calendaires</li>' +
        '<li>Accès illimité à l’application terrain collectrice</li>' +
        '<li>Rapports prudentiels DSC-SFD fonctionnels</li>' +
        '<li>Licence (' + money(LICENCE_CENTS) + ') facturée uniquement après la validation de votre essai</li>' +
      '</ul>' +
      '<a class="btn btn--primary trial-card__cta" href="#inscription">Commencer mon essai gratuit</a>';
    grid.appendChild(trial);

    // --- Carte OFFRE UNIQUE ---
    var plan = (state && state.plans && state.plans[0]) ? state.plans[0] : FALLBACK_PLAN;
    var feats = plan.features;
    if (typeof feats === 'string') { try { feats = JSON.parse(feats); } catch (_) { feats = []; } }
    var card = el('article', 'offer-card');
    var savingsNote = cycle === 'annuel'
      ? '<div class="offer-card__save">−15 % · économie ' + money(savings) + ' / an</div>'
      : '<div class="offer-card__save offer-card__save--muted">Passez à l’annuel : −15 % sur l’abonnement</div>';
    var annualLine = cycle === 'annuel'
      ? '<div class="offer-card__sub">soit ' + money(net) + ' / an, facturés en une fois</div>'
      : '<div class="offer-card__sub">facturé chaque mois, sans engagement de durée</div>';
    card.innerHTML =
      '<div class="offer-card__ribbon">Offre unique</div>' +
      '<div class="offer-card__name">' + esc(plan.label || 'teeBo') + '</div>' +
      '<div class="offer-card__desc">' + esc(plan.desc || plan.description || FALLBACK_PLAN.desc) + '</div>' +
      '<div class="offer-card__price">' + money(pm) + ' <small>/ mois</small></div>' +
      savingsNote +
      annualLine +
      '<div class="offer-card__licence">+ Licence unique ' + money(LICENCE_CENTS) +
        ' <span>(une seule fois, facturée après l’essai)</span></div>' +
      '<ul class="offer-card__feats">' +
        (feats || []).map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') +
      '</ul>' +
      '<div class="offer-card__total">1<sup>er</sup> règlement après l’essai : <b>' + money(total) + '</b></div>' +
      '<a class="btn offer-card__cta" href="#inscription">Demander un accès</a>';
    grid.appendChild(card);

    host.appendChild(grid);
  }

  // Rendu immédiat de la section tarifs (repli), puis affinage via l'API.
  renderPricing();

  if (!root) return;

  var state = {
    step: 1,
    countries: [],
    plans: [],
    imf: null,          // { request_id, imf_id, imf_code }
    selectedPlan: null,
    billing: 'mensuel', // périodicité choisie : 'mensuel' | 'annuel'
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
    var labels = ['IMF', 'Offre', 'Proforma', 'Confirmation'];
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
    var gphone = el('div', 'grid2');
    gphone.appendChild(waf);

    // Numéro d'appel IMF avec indicatif auto
    var phf = el('div', 'field');
    var lbl2 = el('label'); lbl2.setAttribute('for', 'phone_main'); lbl2.textContent = 'Numéro d’appel de l’IMF';
    phf.appendChild(lbl2);
    var pgrp = el('div', 'phone-group');
    var dial2 = el('div', 'dial', '+---'); dial2.id = 'dial-phone';
    var pIn = el('input'); pIn.type = 'tel'; pIn.id = 'phone_main'; pIn.name = 'phone_main'; pIn.placeholder = '00 00 00 00'; pIn.required = true;
    pgrp.appendChild(dial2); pgrp.appendChild(pIn); phf.appendChild(pgrp);
    var perr = el('p', 'field__err'); perr.hidden = true; perr.setAttribute('data-for', 'phone_main'); phf.appendChild(perr);
    gphone.appendChild(phf);
    panel.appendChild(gphone);

    var g3 = el('div', 'grid2');
    g3.appendChild(field('Montant du capital social (FCFA)', 'capital', { required: true, inputmode: 'numeric', placeholder: 'Ex : 25 000 000' }));
    g3.appendChild(field('Numéro d’agrément BCEAO', 'bceao_agreement_no', { required: true, placeholder: 'Ex : 2024-XXX-IM-001' }));
    panel.appendChild(g3);

    // Identifiants légaux requis pour la facturation
    var g4 = el('div', 'grid2');
    g4.appendChild(field('Numéro RCCM', 'rccm', { required: true, placeholder: 'Ex : BF-OUA-2024-B-12345' }));
    g4.appendChild(field('Numéro IFU', 'ifu', { required: true, placeholder: 'Ex : 00012345 A' }));
    panel.appendChild(g4);

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
        rccm: panel.querySelector('#rccm').value.trim(),
        ifu: panel.querySelector('#ifu').value.trim(),
        whatsapp: dial1.textContent + ' ' + wIn.value.replace(/^0+/, ''),
        phone_main: dial2.textContent + ' ' + pIn.value.replace(/^0+/, '')
      };
      var capRaw = panel.querySelector('#capital').value.replace(/[^0-9]/g, '');
      v.capital_cents = capRaw ? Number(capRaw) * 100 : 0;

      var errors = false;
      [['lastname','Le nom est requis.'],['firstname','Le prénom est requis.'],['position','Le poste est requis.'],
       ['imf_name','Le nom de l’IMF est requis.'],['admin_name','Le nom de l’admin est requis.'],['city','La ville est requise.'],
       ['bceao_agreement_no','Le n° d’agrément est requis.'],
       ['rccm','Le numéro RCCM est requis (facturation).'],
       ['ifu','Le numéro IFU est requis (facturation).']].forEach(function (p) {
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
        state.billing_ids = { rccm: v.rccm, ifu: v.ifu };
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

  // ================= ÉTAPE 2 : OFFRE UNIQUE =================
  // Offre unique standardisée : licence unique + abonnement au choix MENSUEL
  // ou ANNUEL (remise de 15 % en annuel). Plus de 3 formules : une seule offre.
  // Les helpers subNet / perMonth sont définis plus haut (section accueil).

  // Retourne l'offre unique à présenter (API si dispo, sinon repli statique).
  function singlePlan() {
    return (state.plans && state.plans[0]) ? state.plans[0] : FALLBACK_PLAN;
  }

  function renderPlans() {
    if (!state.billing) state.billing = 'mensuel';
    var plan = singlePlan();
    // L'offre étant unique, elle est sélectionnée d'office : on ne demande que
    // le rythme de facturation (mensuel / annuel).
    state.selectedPlan = plan;

    var panel = el('div', 'panel');
    panel.appendChild(el('h3', null, '2. Validez l’offre unique'));
    panel.appendChild(el('p', 'panel__hint',
      'Prenez connaissance des conditions financières transparentes de la plateforme ' +
      '(Licence unique de ' + money(LICENCE_CENTS) + ' + Abonnement à partir de ' +
      money(perMonth(plan.price_cents || MONTHLY_BASE_CENTS, 'annuel')) + '/mois) ' +
      'et sélectionnez votre rythme de facturation (mensuel ou annuel avec −15 %).'));
    var errSlot = el('div'); panel.appendChild(errSlot);

    // --- Bascule de périodicité : Mensuel / Annuel (−15 %) ---
    var toggle = el('div', 'ptoggle ptoggle--wiz');
    [['mensuel', 'Mensuel'], ['annuel', 'Annuel · −15 %']].forEach(function (opt) {
      var active = state.billing === opt[0];
      var b = el('button', 'ptoggle__btn' + (active ? ' is-active' : ''), opt[1]);
      b.type = 'button';
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
      b.addEventListener('click', function () {
        if (state.billing === opt[0]) return;
        state.billing = opt[0];
        render();
      });
      toggle.appendChild(b);
    });
    panel.appendChild(toggle);

    // --- Carte de l'offre unique (récapitulatif financier) ---
    var monthly = Number(plan.price_cents) || MONTHLY_BASE_CENTS;
    var net = subNet(monthly, state.billing);
    var pm = perMonth(monthly, state.billing);
    var total = LICENCE_CENTS + net;
    var savings = Math.round(monthly * 12 * ANNUAL_DISCOUNT);
    var feats = plan.features;
    if (typeof feats === 'string') { try { feats = JSON.parse(feats); } catch (_) { feats = []; } }

    var savingsNote = state.billing === 'annuel'
      ? '<div class="offer-card__save">−15 % · économie ' + money(savings) + ' / an</div>'
      : '<div class="offer-card__save offer-card__save--muted">Passez à l’annuel : −15 % sur l’abonnement</div>';
    var annualLine = state.billing === 'annuel'
      ? '<div class="offer-card__sub">soit ' + money(net) + ' / an, facturés en une fois</div>'
      : '<div class="offer-card__sub">facturé chaque mois, sans engagement de durée</div>';

    var card = el('article', 'offer-card offer-card--wiz is-selected');
    card.innerHTML =
      '<div class="offer-card__ribbon">Offre unique</div>' +
      '<div class="offer-card__name">' + esc(plan.label || 'teeBo') + '</div>' +
      '<div class="offer-card__price">' + money(pm) + ' <small>/ mois</small></div>' +
      savingsNote +
      annualLine +
      '<div class="offer-card__licence">+ Licence unique ' + money(LICENCE_CENTS) +
        ' <span>(une seule fois, facturée après l’essai)</span></div>' +
      '<ul class="offer-card__feats">' +
        (feats || []).map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') +
      '</ul>' +
      '<div class="offer-card__total">1<sup>er</sup> règlement après l’essai : <b>' + money(total) + '</b></div>' +
      '<div class="offer-card__trial">\uD83C\uDF81 Essai gratuit de ' + TRIAL_DAYS + ' jours — aucun paiement initial</div>';
    panel.appendChild(card);

    var nav = el('div', 'wiz__nav');
    var back = el('button', 'btn btn--ghost', 'Retour'); back.type = 'button';
    back.style.color = 'var(--ink)'; back.style.borderColor = 'var(--line)';
    back.addEventListener('click', function () { state.step = 1; render(); });
    var nextBtn = el('button', 'btn btn--primary', 'Continuer'); nextBtn.type = 'button';
    nextBtn.addEventListener('click', function () {
      nextBtn.disabled = true; var old = nextBtn.textContent; nextBtn.textContent = 'Génération…';
      api('/api/v1/requests/' + state.imf.request_id + '/select-plan', 'POST',
          { plan_code: plan.code, billing_cycle: state.billing })
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
    var cyc = p.billing_cycle === 'annuel' ? 'Annuel (12 mois)' : 'Mensuel (1 mois)';
    var aboLabel = p.billing_cycle === 'annuel'
      ? 'Abonnement annuel (12 mois)'
      : 'Abonnement mensuel (1er mois)';
    var rows = '' +
      '<tr><td>Institution</td><td>' + esc((state.imf && state.imf.imf_code) || '') + '</td></tr>' +
      '<tr><td>N° RCCM</td><td>' + esc((state.billing_ids && state.billing_ids.rccm) || '') + '</td></tr>' +
      '<tr><td>N° IFU</td><td>' + esc((state.billing_ids && state.billing_ids.ifu) || '') + '</td></tr>' +
      '<tr><td>Offre</td><td>' + esc(p.plan || 'teeBo') + '</td></tr>' +
      '<tr><td>Périodicité</td><td>' + esc(cyc) + '</td></tr>' +
      '<tr><td>Frais de licence unique</td><td>' + money(p.licence_cents) + ' HT</td></tr>' +
      '<tr><td>' + esc(aboLabel) + '</td><td>' + money(p.subscription_cents) + ' HT</td></tr>';
    if (p.billing_cycle === 'annuel' && p.savings_cents)
      rows += '<tr><td>Remise annuelle (−15 %)</td><td>−' + money(p.savings_cents) + '</td></tr>';
    rows +=
      '<tr><td><b>Total partiel (HT)</b></td><td><b>' + money(p.amount_cents) + '</b></td></tr>' +
      '<tr><td>Période d’essai</td><td>' + esc(p.trial_days) + ' jours calendaires — gratuit</td></tr>' +
      '<tr class="total"><td>Total à payer pendant l’essai</td><td>0 FCFA</td></tr>';
    box.innerHTML =
      '<div class="proforma__head"><b>Facture proforma n° ' + esc(p.no) + '</b><small>teebo · hello@teebo.africa</small></div>' +
      '<table>' + rows + '</table>' +
      '<p class="proforma__legal">Montants hors taxes exprimés en FCFA (XOF). La TVA éventuelle est ' +
      'appliquée selon le paramétrage légal de chaque IMF.</p>';
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
  // Repli des formules identique à la grille d'accueil : le sélecteur de prix
  // de l'inscription ne doit JAMAIS être vide, même si l'API est injoignable
  // ou lente (backend en veille) au chargement de la page.
  var FALLBACK_PLANS = FALLBACK_TIERS;

  // Normalise price_cents : l'API renvoie une chaîne ("4500000"), on force un
  // nombre pour fiabiliser tous les calculs (abonnement, remise, total).
  function normPlans(list) {
    return (list || []).map(function (p) {
      var c = {}; for (var k in p) { if (Object.prototype.hasOwnProperty.call(p, k)) c[k] = p[k]; }
      c.price_cents = Number(p.price_cents) || 0;
      return c;
    });
  }

  // Chargement initial (pays + formules) — résilient : l'échec d'un appel
  // n'affecte pas l'autre, et le sélecteur de formules garde toujours un repli.
  Promise.allSettled([
    api('/api/v1/requests/uemoa-countries'),
    api('/api/v1/requests/plans')
  ]).then(function (res) {
    var cRes = res[0], pRes = res[1];
    state.countries = (cRes.status === 'fulfilled' && cRes.value && cRes.value.countries) || [];
    if (!state.countries.length) state.countries = FALLBACK_COUNTRIES;

    var plans = (pRes.status === 'fulfilled' && pRes.value && pRes.value.plans)
      ? normPlans(pRes.value.plans) : [];
    state.plans = plans.length ? plans : normPlans(FALLBACK_PLANS);

    renderPricing();
    render();
  });
})();



(function () {
  'use strict';
  var isFile = location.protocol === 'file:';
  var installBtns = [];
  var b1 = document.getElementById('install-btn');
  var b2 = document.getElementById('install-btn-hero');
  if (b1) installBtns.push(b1);
  if (b2) installBtns.push(b2);
  var deferredPrompt = null;

  function standalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
           window.navigator.standalone === true;
  }
  function showBtns() { installBtns.forEach(function (b) { b.hidden = false; }); }
  function hideBtns() { installBtns.forEach(function (b) { b.hidden = true; }); }

  // 1) Enregistrement du service worker (hors file:// et aperçu local).
  if ('serviceWorker' in navigator && !isFile) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js?v=25', { updateViaCache: 'none' }).catch(function () { /* silencieux */ });
    });
  }

  // 2) Invite d'installation native (Chrome, Edge, Android…).
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    if (!standalone()) showBtns();
  });

  // 3) Fiche d'aide (iOS / Safari et navigateurs sans invite native).
  var ua = navigator.userAgent || '';
  var isIOS = /iphone|ipad|ipod/i.test(ua);
  function helpCard() {
    var card = document.querySelector('.install-help');
    if (card) return card;
    card = document.createElement('div');
    card.className = 'install-help';
    card.innerHTML = isIOS
      ? '<b>Installer teebo sur votre iPhone</b>Appuyez sur le bouton <b style="display:inline">Partager</b> de Safari, puis choisissez <b style="display:inline">« Sur l’écran d’accueil »</b>. L’icône ouvrira directement la page de connexion.'
      : '<b>Installer teebo</b>Ouvrez le menu de votre navigateur et choisissez <b style="display:inline">« Installer l’application »</b> ou <b style="display:inline">« Ajouter à l’écran d’accueil »</b>. L’icône ouvrira directement la page de connexion.';
    var close = document.createElement('button');
    close.className = 'install-help__close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Fermer');
    close.textContent = '×';
    close.addEventListener('click', function () { card.hidden = true; });
    card.appendChild(close);
    document.body.appendChild(card);
    return card;
  }

  // 4) Clic sur les boutons d'installation.
  installBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then(function (choice) {
          if (choice && choice.outcome === 'accepted') hideBtns();
          deferredPrompt = null;
        });
      } else {
        var card = helpCard();
        card.hidden = false;
      }
    });
  });

  // 5) Sur iOS, pas d'invite native : proposer l'installation manuelle.
  if (isIOS && !standalone()) showBtns();

  // 6) L'application vient d'être installée.
  window.addEventListener('appinstalled', function () { hideBtns(); });
})();
