import os, json
BASE = 'http://127.0.0.1:' + os.environ.get('QA_PORT', '4401')
from playwright.sync_api import sync_playwright
steps, problems = [], []
def watch(pg, who):
    pg.on('pageerror', lambda e: problems.append(f'{who} JS error: {e}'))
    pg.on('response', lambda r: r.status >= 500 and problems.append(f'{who} HTTP {r.status} {r.url}'))
def dead_controls(pg, label):
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
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1400, 'height': 1000}); watch(pg, 'admin'); checked = 0
    pg.goto(BASE + '/admin'); pg.fill('#le', 'eric@bc.test'); pg.fill('#lp', 'demo password 123'); pg.click('#login button'); pg.wait_for_timeout(1200)
    t = pg.inner_text('main'); steps.append('1 dashboard with real numbers, revenue says why unavailable: ' + str('Companies' in t and 'Stripe not connected' in t)); checked += dead_controls(pg, 'dashboard')
    pg.click('[data-drill*="companies"] >> nth=0'); pg.wait_for_timeout(800); steps.append('2 drill-down to company list: ' + str('#/companies' in pg.url and 'Acme' in pg.inner_text('main'))); checked += dead_controls(pg, 'companies')
    pg.click('main a:has-text("Acme")'); pg.wait_for_timeout(800)
    tabs_ok = True
    for tab in ['verification', 'members', 'markets', 'credentials', 'publishing', 'marketplace', 'subscription', 'support', 'activity', 'overview']:
        pg.click(f'[data-tab="{tab}"]'); pg.wait_for_timeout(350); tabs_ok = tabs_ok and pg.get_attribute(f'[data-tab="{tab}"]', 'aria-selected') == 'true'
        checked += dead_controls(pg, 'company/' + tab)
    steps.append('3 all 10 company tabs open: ' + str(tabs_ok))
    pg.click('[data-tab="support"]'); pg.wait_for_timeout(400); pg.click('#susp'); confirm(pg, 'Impersonation report under review'); confirm(pg, password='demo password 123'); pg.wait_for_timeout(800)
    suspended = 'suspended' in pg.inner_text('main').lower()
    gc = b.new_page(); r = gc.request.post(BASE + '/api/login', data=json.dumps({'email': 'pm@acme.test', 'password': 'demo password 123'}), headers={'content-type': 'application/json'})
    steps.append('4 suspend (reason + password step-up); GC refused at sign-in: ' + str(suspended and r.status == 403 and 'suspended' in r.text()))
    pg.click('#react'); confirm(pg, 'Report resolved: legitimate company'); pg.wait_for_timeout(800)
    r2 = gc.request.post(BASE + '/api/login', data=json.dumps({'email': 'pm@acme.test', 'password': 'demo password 123'}), headers={'content-type': 'application/json'})
    steps.append('   reactivated, GC can sign in again: ' + str(r2.status == 200))
    sub = b.new_page(); sub.goto(BASE + '/app'); sub.fill('#e', 'sub@em.test'); sub.fill('#p', 'demo password 123'); sub.click('button.primary'); sub.wait_for_timeout(1000)
    pg.fill('#gs', 'sub@'); pg.wait_for_timeout(900); pg.click('#gsr a:has-text("sub@em.test")'); pg.wait_for_timeout(800); checked += dead_controls(pg, 'user')
    pg.click('#urev'); confirm(pg, 'Reported lost laptop'); pg.wait_for_timeout(600)
    r3 = sub.request.get(BASE + '/api/me', headers={'authorization': 'Bearer ' + sub.evaluate("sessionStorage.getItem('bi_token')")})
    steps.append('5 global search → user → sign out everywhere; their session is dead: ' + str(r3.status == 401))
    pg.select_option('#rsel', 'read_only_analyst'); pg.click('#rgrant'); confirm(pg, 'Temporary analyst access for Q4 review'); pg.wait_for_timeout(600)
    granted = 'read_only_analyst' in pg.inner_text('main')
    pg.select_option('#rsel', 'read_only_analyst'); pg.click('#rrev'); confirm(pg, 'Q4 review finished'); pg.wait_for_timeout(600)
    roles_cell = pg.evaluate("() => [...document.querySelectorAll('main tr')].find(r => r.textContent.startsWith('Platform roles'))?.cells[1].textContent.trim()")
    steps.append('6 grant then revoke a platform role: ' + str(granted and roles_cell == 'none'))
    pg.click('[data-nav="audit"]'); pg.wait_for_timeout(800); pg.fill('#ff [name=action]', 'admin.'); pg.click('#ff button.primary'); pg.wait_for_timeout(800)
    t = pg.inner_text('main'); steps.append('7 audit log shows the actions with reasons: ' + str(all(x in t for x in ['admin.company.suspend', 'Impersonation report', 'admin.roles.revoke', 'admin.user.revoke_sessions']))); checked += dead_controls(pg, 'audit')
    cu = b.new_page(); watch(cu, 'customer'); cu.goto(BASE + '/admin'); cu.fill('#le', 'pm@acme.test'); cu.fill('#lp', 'demo password 123'); cu.click('#login button'); cu.wait_for_timeout(900)
    steps.append('8 customer opening /admin sees "No platform role": ' + str('No platform role' in cu.inner_text('body')))
    m = b.new_page(viewport={'width': 390, 'height': 844}); watch(m, 'mobile'); m.goto(BASE + '/admin'); m.evaluate(f"sessionStorage.setItem('bi_admin_token', {json.dumps(pg.evaluate('sessionStorage.getItem(\"bi_admin_token\")'))})"); m.goto(BASE + '/admin#/companies'); m.reload(); m.wait_for_timeout(1500)
    wide = m.evaluate('() => document.documentElement.scrollWidth <= window.innerWidth + 1')
    steps.append('9 phone width (390px): companies list usable, no sideways page scroll: ' + str('Acme' in m.inner_text('main') and wide))
    m.screenshot(path=os.path.join(os.environ.get('QA_OUT', '/tmp'), 'admin-mobile.png'), full_page=True)
    pg.click('[data-nav="dashboard"]'); pg.wait_for_timeout(800); pg.screenshot(path=os.path.join(os.environ.get('QA_OUT', '/tmp'), 'admin-dashboard.png'), full_page=True)
    steps.append(f'10 dead-control check: {checked} controls on visited pages')
    b.close()
print('\n'.join(steps)); print('PROBLEMS:', [x for x in problems if 'ERR_NAME' not in x])
