import sys, json
from playwright.sync_api import sync_playwright
import os
# Accessibility scan (axe-core). Install once outside the repo: npm install axe-core@4 in a scratch folder, then
# AXE_JS=<folder>/node_modules/axe-core/axe.min.js QA_PORT=<port of a running demo server> python3 qa/a11y_scan.py <out.json>
AXE = os.environ['AXE_JS']
BASE = 'http://127.0.0.1:' + os.environ.get('QA_PORT', '4400')
def scan(pg, label, out):
    if not pg.evaluate('() => !!window.axe'): pg.evaluate(open(AXE).read())
    res = pg.evaluate("async () => { const r = await axe.run(document, { resultTypes: ['violations'] }); return r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, n: v.nodes.length, sample: (v.nodes[0] && v.nodes[0].html || '').slice(0, 120) })); }")
    out[label] = res
    print(label, 'violations:', len(res), [ (x['impact'], x['id'], x['n']) for x in res if x['impact'] in ('critical','serious')][:8])
with sync_playwright() as p:
    b = p.chromium.launch(); out = {}
    pg = b.new_page(viewport={'width': 1280, 'height': 900})
    pg.goto(BASE + '/'); pg.wait_for_timeout(700); scan(pg, 'website home', out)
    pg.goto(BASE + '/get-started'); pg.wait_for_timeout(700); scan(pg, 'website get-started', out)
    pg.goto(BASE + '/app'); pg.wait_for_timeout(700); scan(pg, 'sign-in', out)
    pg.fill('#e', 'pm@acme.test'); pg.fill('#p', 'demo password 123'); pg.click('button.primary'); pg.wait_for_timeout(1500)
    scan(pg, 'publisher workspace', out)
    pg.evaluate("document.querySelector('[data-pubopen]')?.click()"); pg.wait_for_timeout(900); scan(pg, 'publisher project', out)
    sub = b.new_page(viewport={'width': 1280, 'height': 900}); sub.goto(BASE + '/app'); sub.fill('#e', 'sub@em.test'); sub.fill('#p', 'demo password 123'); sub.click('button.primary'); sub.wait_for_timeout(1500)
    scan(sub, 'subscriber command', out)
    sub.evaluate("document.querySelector('[data-t=invitations]')?.click()"); sub.wait_for_timeout(800); scan(sub, 'subscriber invitations', out)
    adm = b.new_page(viewport={'width': 1280, 'height': 900}); adm.goto(BASE + '/admin', wait_until='commit'); adm.wait_for_selector('#le', timeout=15000)
    adm.fill('#le', 'eric@bc.test'); adm.fill('#lp', 'demo password 123'); adm.click('#login button'); adm.wait_for_selector('nav#side', state='attached', timeout=15000); adm.wait_for_timeout(900)
    scan(adm, 'super admin dashboard', out)
    json.dump(out, open(sys.argv[1], 'w'), indent=1)
    b.close()
