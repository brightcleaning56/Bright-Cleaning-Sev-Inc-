# Super Admin review screens in the browser: a platform owner opens Publisher verification, sees the pending
# company, opens its record, and opens Project authority. Prints "PROBLEMS: [...]" (empty when everything passes).
import os
from playwright.sync_api import sync_playwright
BASE = 'http://127.0.0.1:' + os.environ.get('QA_PORT', '4401')
problems = []
with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 1400, 'height': 1000}); pg = ctx.new_page(); pg.set_default_timeout(15000)
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)[:120]))
    pg.goto(BASE + '/admin', wait_until='commit'); pg.wait_for_selector('#le', timeout=15000)
    pg.fill('#le', 'eric@bc.test'); pg.fill('#lp', 'demo password 123'); pg.click('#login button'); pg.wait_for_selector('nav#side', timeout=15000)
    pg.goto(BASE + '/admin#/verification', wait_until='commit'); pg.wait_for_timeout(1500)
    body = pg.inner_text('#main')
    if 'Ridge Builders' not in body: problems.append('verification: pending publisher not listed')
    for bad in ['undefined', 'NaN', '[object Object]']:
        if bad in body: problems.append(f'verification: shows raw "{bad}"')
    pg.get_by_text('Ridge Builders').first.click(); pg.wait_for_timeout(1500)
    if 'Verification' not in pg.inner_text('#main'): problems.append('company record: verification tab missing')
    pg.goto(BASE + '/admin#/authority', wait_until='commit'); pg.wait_for_timeout(1200)
    if 'Construction managers' not in pg.inner_text('#main'): problems.append('authority: screen did not load')
    if errors: problems.append('page errors: ' + '; '.join(errors[:3]))
    b.close()
print('PROBLEMS: ' + repr(problems))
