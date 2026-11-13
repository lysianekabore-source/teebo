/* teebo — actions des documents imprimables (relevé, factures).
   Aucun gestionnaire inline : compatible avec la CSP stricte. */
(function () {
  'use strict';
  var p = document.getElementById('btn-print');
  if (p) p.addEventListener('click', function () { window.print(); });
  var c = document.getElementById('btn-close');
  if (c) c.addEventListener('click', function () {
    if (window.history.length > 1) window.history.back();
    else window.close();
  });
})();
