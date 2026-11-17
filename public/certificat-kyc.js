/* ===========================================================================
 * teebo — VAGUE 42 : script de la page publique de vérification du certificat
 * de diligence KYC/KYB et de visite terrain.
 *
 * Rôle unique : deux boutons (Imprimer / Enregistrer en PDF, Fermer).
 * Aucune donnée n'est lue, envoyée ni stockée ici ; le document est rendu par
 * le serveur et n'appelle aucune API. Script EXTERNE (pas de code en ligne)
 * pour respecter la politique de sécurité du serveur.
 * =========================================================================== */
(function () {
  'use strict';

  function imprimer() {
    try { window.print(); }
    catch (e) { /* rien à faire : l'utilisateur peut utiliser Ctrl+P */ }
  }

  function fermer() {
    // Si l'onglet a été ouvert par le site teebo, on revient à la page
    // précédente ; sinon on tente de fermer l'onglet.
    if (window.history.length > 1) { window.history.back(); return; }
    window.close();
  }

  function brancher() {
    var b1 = document.getElementById('btn-imprimer');
    var b2 = document.getElementById('btn-fermer');
    if (b1) b1.addEventListener('click', imprimer);
    if (b2) b2.addEventListener('click', fermer);
    // Raccourci discret : la touche « p » du clavier imprime le certificat.
    document.addEventListener('keydown', function (ev) {
      if ((ev.ctrlKey || ev.metaKey) && String(ev.key).toLowerCase() === 'p') return; // laissé au navigateur
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', brancher);
  } else {
    brancher();
  }
})();
