/* True Roofing Group — shared client script (framework-free) */
(function () {
  // Mobile nav toggle
  var toggle = document.querySelector('.nav-toggle');
  var links = document.querySelector('.nav-links');
  if (toggle && links) {
    toggle.addEventListener('click', function () {
      links.classList.toggle('open');
      toggle.setAttribute('aria-expanded', links.classList.contains('open'));
    });
    links.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') links.classList.remove('open');
    });
  }

  // Quote / contact form handling.
  // No backend is wired yet: submissions are validated client-side and, if a
  // FORM_ENDPOINT is configured below, POSTed there. Otherwise a friendly
  // success message is shown so the page is demo-ready. Replace FORM_ENDPOINT
  // with a real handler (e.g. a Vercel function, Formspree, or CRM webhook).
  var FORM_ENDPOINT = ''; // e.g. '/api/leads' or a Formspree URL

  document.querySelectorAll('form[data-quote]').forEach(function (form) {
    var msg = form.querySelector('[data-msg]');
    var btn = form.querySelector('button[type="submit"]');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (msg) { msg.textContent = ''; msg.className = ''; msg.setAttribute('data-msg', ''); }
      var data = Object.fromEntries(new FormData(form).entries());
      if (!data.name || !data.name.trim()) return showErr('Please tell us your name.');
      if (!data.phone && !data.email) return showErr('Add a phone or email so we can reach you.');

      if (btn) btn.disabled = true;
      if (!FORM_ENDPOINT) {
        setTimeout(function () {
          form.reset();
          if (btn) btn.disabled = false;
          showOk("Thanks, " + firstName(data.name) + "! A True Roofing specialist will reach out shortly to schedule your free inspection.");
        }, 400);
        return;
      }
      fetch(FORM_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }).then(function (r) {
        if (btn) btn.disabled = false;
        if (r.ok) { form.reset(); showOk("Thanks, " + firstName(data.name) + "! We'll be in touch within one business day."); }
        else showErr('Something went wrong. Please call us and we’ll help right away.');
      }).catch(function () {
        if (btn) btn.disabled = false;
        showErr('Network error. Please try again or give us a call.');
      });

      function showErr(t) { if (msg) { msg.textContent = t; msg.className = 'err'; } if (btn) btn.disabled = false; return false; }
      function showOk(t) { if (msg) { msg.textContent = t; msg.className = 'ok'; } }
    });

    function showErr(t) { if (msg) { msg.textContent = t; msg.className = 'err'; } return false; }
    function showOk(t) { if (msg) { msg.textContent = t; msg.className = 'ok'; } }
    function firstName(n) { return (n || '').trim().split(/\s+/)[0]; }
  });

  // Footer year
  document.querySelectorAll('[data-year]').forEach(function (el) {
    // Static build: leave the printed year as authored; JS only fills empty nodes.
    if (!el.textContent.trim()) el.textContent = '2026';
  });
})();
