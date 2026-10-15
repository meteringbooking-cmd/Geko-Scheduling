/* Geko theme bootstrap: runs in <head> before first paint so there is no flash.
   Light workspace is the default; a user's explicit "dark" choice (localStorage geko-theme) is respected. */
(function () {
  var root = document.documentElement;
  try { if (localStorage.getItem('geko-theme') !== 'dark') root.classList.add('light-mode'); }
  catch (e) { root.classList.add('light-mode'); }
})();
