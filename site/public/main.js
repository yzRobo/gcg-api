// The page's only JavaScript. It is purely additive: with JS off or the fetch blocked, the
// baked stats stand and every command is still selectable. No spinners, no polling.
(function () {
  // Copy buttons (progressive enhancement).
  var buttons = document.querySelectorAll('.copy');
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener('click', function () {
      var btn = this;
      var code = btn.parentElement.querySelector('code');
      if (!code || !navigator.clipboard) return;
      navigator.clipboard.writeText(code.textContent.trim()).then(function () {
        var prev = btn.textContent;
        btn.textContent = 'copied';
        btn.classList.add('copied');
        setTimeout(function () { btn.textContent = prev; btn.classList.remove('copied'); }, 1400);
      }, function () { /* clipboard blocked; leave the command to be selected manually */ });
    });
  }

  // Live stats: a single request to the API's manifest, served from its edge cache.
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, 2500);
  fetch('https://api.gcgapi.com/v1/manifest', { signal: controller.signal })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
    .then(function (m) {
      clearTimeout(timer);
      var fmt = function (n) { return Number(n).toLocaleString('en-US'); };
      var cards = document.getElementById('stat-cards');
      var rulings = document.getElementById('stat-rulings');
      if (cards && typeof m.card_count === 'number') cards.textContent = fmt(m.card_count);
      if (rulings && typeof m.ruling_count === 'number') rulings.textContent = fmt(m.ruling_count);
      if (m.dataset_version) {
        var note = document.getElementById('live-note');
        if (note) { note.textContent = 'live · dataset ' + m.dataset_version; note.hidden = false; }
      }
    })
    .catch(function () { clearTimeout(timer); /* baked values stand */ });
})();
