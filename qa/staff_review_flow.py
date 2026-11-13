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
    # The company uploads a verification PDF (through its own account); staff can open it from this record, and the view is logged.
    import json as _j, urllib.request as _u
    def _api(m, path, body=None, tok=None, raw=None, headers=None):
        h = {'Content-Type': 'application/json', **({'Authorization': 'Bearer ' + tok} if tok else {}), **(headers or {})}
        rq = _u.Request(BASE + path, method=m, data=raw if raw is not None else (_j.dumps(body).encode() if body is not None else None), headers=h)
        return _j.loads(_u.urlopen(rq).read() or b'{}')
    rtok = _api('POST', '/api/login', {'email': 'gc@ridge.test', 'password': 'demo password 123'})['token']
    pdf = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures', 'E2.01_Lighting_Plan.pdf'), 'rb').read()
    _api('POST', '/api/publisher/documents?name=WA%20license.pdf&kind=license', tok=rtok, raw=pdf, headers={'Content-Type': 'application/pdf'})
    pg.reload(wait_until='commit'); pg.wait_for_timeout(1200)
    pg.get_by_text('Ridge Builders').first.click(); pg.wait_for_timeout(1200)
    pg.click('[data-tab=verification]'); pg.wait_for_timeout(900)
    if 'Uploaded documents' not in pg.inner_text('#main') or 'WA license.pdf' not in pg.inner_text('#main'): problems.append('company record: uploaded verification document not listed for staff')
    if 'Review history' not in pg.inner_text('#main'): problems.append('company record: review history missing')
    pg.goto(BASE + '/admin#/authority', wait_until='commit'); pg.wait_for_timeout(1200)
    if 'Construction managers' not in pg.inner_text('#main'): problems.append('authority: screen did not load')
    if errors: problems.append('page errors: ' + '; '.join(errors[:3]))
    b.close()
print('PROBLEMS: ' + repr(problems))
