import json
def watch(pg, who, problems):
    pg.on('pageerror', lambda e: problems.append(f'{who} JS error: {e}'))
    pg.on('response', lambda r: r.status >= 500 and problems.append(f'{who} HTTP {r.status} {r.url}'))
def dead_controls(pg, label, problems):
    """Every enabled, visible button/link on the page must do something (its own handler, a form handler, or an href)."""
    cdp = pg.context.new_cdp_session(pg); dead = []
    n = pg.evaluate("() => { const els = [...document.querySelectorAll('main button:not([disabled]), main a, #side button:not([disabled]), #top button')].filter(e => e.offsetParent); els.forEach((e, i) => e.dataset.qa = i); return els.length; }")
    for i in range(n):
        oid = cdp.send('Runtime.evaluate', {'expression': f"document.querySelector('[data-qa=\"{i}\"]')"})['result'].get('objectId')
        ls = cdp.send('DOMDebugger.getEventListeners', {'objectId': oid})['listeners']
        info = pg.evaluate(f"() => {{ const e = document.querySelector('[data-qa=\"{i}\"]'); return {{ href: e.getAttribute('href'), onclick: !!e.onclick, form: !!e.form, txt: e.textContent.trim().slice(0, 40) }}; }}")
        if info['onclick'] or (info['href'] and info['href'] != '#') or any(l['type'] in ('click', 'submit') for l in ls): continue
        if info['form']:
            foid = cdp.send('Runtime.evaluate', {'expression': f"document.querySelector('[data-qa=\"{i}\"]').form"})['result'].get('objectId')
            if foid and any(l['type'] == 'submit' for l in cdp.send('DOMDebugger.getEventListeners', {'objectId': foid})['listeners']) or pg.evaluate(f"() => !!document.querySelector('[data-qa=\"{i}\"]').form.onsubmit"): continue
        dead.append(info['txt'])
    if dead: problems.append(f'dead controls on {label}: {dead}')
    return n
def confirm(pg, reason=None, password=None):
    pg.wait_for_selector('#dlg[open]')
    if reason is not None: pg.fill('#dlgr', reason)
    if password is not None: pg.fill('#dlgx input[name=password]', password)
    pg.click('#dlgok'); pg.wait_for_timeout(500)
