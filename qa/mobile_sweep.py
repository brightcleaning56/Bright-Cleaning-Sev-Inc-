"""Phone-width sweep: every main screen must fit a 390px-wide phone with no sideways page scroll.
Prints PROBLEMS: [] when every screen fits."""
import os, json
from playwright.sync_api import sync_playwright
BASE = 'http://127.0.0.1:' + os.environ.get('QA_PORT', '4400')
problems, steps = [], []
def fits(pg, label):
    w = pg.evaluate("document.documentElement.scrollWidth")
    steps.append(f'{label}: {w}px')
    if w > 391: problems.append(f'{label} is {w}px wide on a 390px phone')
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    pg = ctx.new_page()
    for path in ['/', '/get-started', '/pricing', '/data-trust', '/faq']:
        try:
            pg.goto(BASE + path, wait_until='load'); pg.wait_for_timeout(500); fits(pg, 'website ' + path)
        except Exception as e: problems.append(f'website {path} did not load: {e}')
    pg.goto(BASE + '/app'); pg.fill('#e', 'pm@acme.test'); pg.fill('#p', 'demo password 123'); pg.click('button.primary'); pg.wait_for_timeout(1500)
    fits(pg, 'publisher workspace')
    pg.evaluate("document.querySelector('[data-pubopen]')?.click()"); pg.wait_for_timeout(900); fits(pg, 'publisher project workspace')
    sub = ctx.new_page(); sub.goto(BASE + '/app'); sub.fill('#e', 'sub@em.test'); sub.fill('#p', 'demo password 123'); sub.click('button.primary'); sub.wait_for_timeout(1500)
    for t in ['command', 'invitations', 'plan', 'contracts', 'subscription']:
        sub.evaluate(f"document.querySelector('[data-t={t}]')?.click()"); sub.wait_for_timeout(700); fits(sub, 'subscriber ' + t)
    adm = ctx.new_page(); adm.goto(BASE + '/admin', wait_until='commit'); adm.wait_for_selector('#le', timeout=15000)
    adm.fill('#le', 'eric@bc.test'); adm.fill('#lp', 'demo password 123'); adm.click('#login button'); adm.wait_for_selector('nav#side', state='attached', timeout=15000)
    for hash_ in ['#/dashboard', '#/companies', '#/verification', '#/audit']:
        adm.goto(BASE + '/admin' + hash_, wait_until='commit'); adm.wait_for_timeout(900); fits(adm, 'admin ' + hash_)
    b.close()
print('\n'.join(steps)); print('PROBLEMS:', json.dumps(problems))
