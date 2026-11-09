(() => {
  const toggle = document.getElementById('mobileToggle');
  const nav = document.getElementById('primaryNav');
  if (toggle && nav) {
    toggle.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    });
    nav.querySelectorAll('a').forEach(a => a.addEventListener('click', () => {
      nav.classList.remove('open'); toggle.setAttribute('aria-expanded', 'false');
    }));
  }
  const year = document.getElementById('year');
  if (year) year.textContent = new Date().getFullYear();
})();
// Website contact form: posts to /api/inquiries and shows the result without leaving the page.
(() => {
  document.querySelectorAll('form[data-inquiry]').forEach(form => {
    const status = form.querySelector('.status');
    const button = form.querySelector('button[type=submit]');
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());
      if (String(data.name || '').trim().length < 2) return show('Enter your full name.', false);
      if (!form.email.checkValidity()) return show('Enter a valid email address.', false);
      if (String(data.message || '').trim().length < 10) return show('Your message needs at least 10 characters.', false);
      button.disabled = true; const label = button.textContent; button.textContent = 'Sending…';
      try {
        const res = await fetch('/api/inquiries', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || 'Your message could not be sent. Please try again.');
        form.reset(); show(body.message || 'Thanks. Your message was received.', true);
      } catch (err) {
        show(err.message, false);
      } finally { button.disabled = false; button.textContent = label; }
    });
    function show(text, ok) { status.textContent = text; status.className = 'status ' + (ok ? 'ok' : 'err'); }
  });
})();
// Homepage walkthrough: pause and play button.
(() => {
  document.querySelectorAll('[data-demo]').forEach(demo => {
    const btn = demo.querySelector('.h-demo-play');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const paused = demo.classList.toggle('paused');
      btn.textContent = paused ? '▶' : '❚❚';
      btn.setAttribute('aria-label', paused ? 'Play walkthrough' : 'Pause walkthrough');
      btn.setAttribute('aria-pressed', String(paused));
    });
  });
})();
