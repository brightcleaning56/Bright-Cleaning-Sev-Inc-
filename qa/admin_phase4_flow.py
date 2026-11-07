# Super Admin Phase 4 + MFA in the browser: subscriptions (revenue unavailable, manual trial extension), data sources
# (incomplete terms keep Resume disabled, missing items listed), AI limit, MFA enrolment with real codes and sign-in with
# a code, phone layout (cards + collapsed filters), dead controls.
import os, json, hmac, hashlib, struct, time, base64, importlib.util
BASE = 'http://127.0.0.1:' + os.environ.get('QA_PORT', '4401')
spec = importlib.util.spec_from_file_location('af', os.path.join(os.path.dirname(__file__), 'admin_flow_lib.py')); af = importlib.util.module_from_spec(spec); spec.loader.exec_module(af)
from playwright.sync_api import sync_playwright
def totp(secret, step=None):   # RFC 6238, as an authenticator app computes it
    key = base64.b32decode(secret.replace(' ', '') + '=' * (-len(secret.replace(' ', '')) % 8)); st = int(time.time() // 30) if step is None else step
    h = hmac.new(key, struct.pack('>Q', st), hashlib.sha1).digest(); o = h[-1] & 15
    return str((struct.unpack('>I', h[o:o + 4])[0] & 0x7fffffff) % 10**6).zfill(6)
steps, problems = [], []
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 1400, 'height': 1000}); af.watch(pg, 'admin', problems); checked = 0
    pg.goto(BASE + '/admin'); pg.fill('#le', 'ops@bc.test'); pg.fill('#lp', 'demo password 123'); pg.click('#login button'); pg.wait_for_timeout(1200)
    pg.click('[data-nav="subscriptions"]'); pg.wait_for_timeout(800); checked += af.dead_controls(pg, 'subscriptions', problems)
    t = pg.inner_text('main'); revenue_ok = 'Stripe not connected' in t and 'proposed' in t
    pg.click('main tr:has-text("Emerald") [data-adj]'); pg.wait_for_selector('#dlg[open]'); pg.select_option('#dlgx [name=action]', 'extend_trial'); pg.fill('#dlgx [name=days]', '14')
    af.confirm(pg, 'Pilot customer needs more time'); af.confirm(pg, password='demo password 123'); pg.wait_for_timeout(800)
    steps.append('1 subscriptions: revenue unavailable (Stripe), proposed prices labeled, manual trial extension with step-up: ' + str(revenue_ok and 'trial to' in pg.inner_text('main:has-text("Emerald")')))
    pg.click('[data-nav="sources"]'); pg.wait_for_timeout(800); checked += af.dead_controls(pg, 'sources', problems)
    pg.click('main a[href^="#/source/"] >> nth=0'); pg.wait_for_timeout(800); checked += af.dead_controls(pg, 'source', problems)
    t = pg.inner_text('main'); resume_disabled = pg.is_disabled('#sresume') if pg.query_selector('#sresume') else False
    steps.append('2 data source with incomplete terms: Resume disabled, missing items listed, import history shown: ' + str(resume_disabled and 'Cannot run until' in t and 'commercial reuse not confirmed' in t and 'Import history' in t))
    pg.click('[data-nav="ai"]'); pg.wait_for_timeout(800); checked += af.dead_controls(pg, 'ai', problems)
    pg.click('main tr:has-text("Emerald") [data-ail]'); pg.wait_for_selector('#dlg[open]'); pg.fill('#dlgx [name=limit]', '0'); af.confirm(pg, 'Paused while reviewing unusual usage'); pg.wait_for_timeout(800)
    steps.append('3 AI usage: cost and accuracy unavailable with reasons; limit set (0 = paused): ' + str('BLOCKED' in pg.inner_text('main') and 'limited from' in pg.inner_text('main tr:has-text("Emerald")')))
    pg.click('[data-nav="security"]'); pg.wait_for_timeout(600); pg.click('#mfas'); pg.wait_for_timeout(600); checked += af.dead_controls(pg, 'security', problems)
    secret = pg.inner_text('#mfab code').replace(' ', ''); pg.fill('#mfae [name=code]', totp(secret)); pg.click('#mfae button'); pg.wait_for_timeout(900)
    on = 'On' in pg.inner_text('main')
    pg.click('#out'); pg.wait_for_timeout(500); pg.fill('#le', 'ops@bc.test'); pg.fill('#lp', 'demo password 123'); pg.click('#login button'); pg.wait_for_timeout(700)
    asked = pg.is_visible('#lc')
    while int(time.time()) % 30 > 27: time.sleep(1)                       # avoid the code changing mid-entry
    pg.fill('#lc', totp(secret, int(time.time() // 30) + 1)); pg.click('#login button'); pg.wait_for_timeout(1000)
    steps.append('4 MFA: set up with the key shown, turned on with a real code; sign-in then asks for a code and accepts the next one: ' + str(on and asked and pg.is_visible('#side')))
    m = b.new_page(viewport={'width': 390, 'height': 844}); af.watch(m, 'mobile', problems); m.goto(BASE + '/admin'); m.evaluate(f"sessionStorage.setItem('bi_admin_token', {json.dumps(pg.evaluate('sessionStorage.getItem(\"bi_admin_token\")'))})"); m.goto(BASE + '/admin#/companies'); m.reload(); m.wait_for_timeout(1300)
    label = m.evaluate("() => getComputedStyle(document.querySelector('main td[data-label]'), '::before').content")
    filters_closed = not m.evaluate("() => document.querySelector('details.filters').open")
    wide = m.evaluate('() => document.documentElement.scrollWidth <= window.innerWidth + 1')
    steps.append(f'5 phone: tables shown as labeled cards ({label}), filters collapsed, no sideways scroll: ' + str('COMPANY' in label.upper() and filters_closed and wide))
    m.screenshot(path=os.path.join(os.environ.get('QA_OUT', '/tmp'), 'admin-mobile-cards.png'))
    steps.append(f'6 dead-control check: {checked} controls on visited pages')
    b.close()
print('\n'.join(steps)); print('PROBLEMS:', [x for x in problems if 'ERR_NAME' not in x])
