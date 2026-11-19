# Every account in the demo world opens every menu item. Fails on: a menu item that does not open its own page, a
# JavaScript error, a failed request (HTTP 5xx), a console error, or leaked text (undefined, NaN, [object Object],
# "Something went wrong"). Prints counts per account and the problems found.
import os, json
BASE = 'http://127.0.0.1:' + os.environ.get('QA_PORT', '4400')
from playwright.sync_api import sync_playwright
ACCOUNTS = ['eric@bc.test', 'ops@bc.test', 'pm@acme.test', 'gc@ridge.test', 'gc@ryan.test', 'sub@em.test', 'trade@elec.test', 'svc@clean.test']
LEAK = ['undefined', 'NaN', '[object Object]', 'Something went wrong', 'Cannot read properties']
problems, counts = [], {}
with sync_playwright() as p:
    b = p.chromium.launch()
    for email in ACCOUNTS:
        pg = b.new_page(viewport={'width': 1400, 'height': 1000}); errs = []
        pg.on('pageerror', lambda e, who=email: errs.append(f'{who} JS error: {e}'))
        pg.on('console', lambda m, who=email: m.type == 'error' and 'ERR_TUNNEL_CONNECTION_FAILED' not in m.text and errs.append(f'{who} console: {m.text[:160]}'))
        pg.on('requestfailed', lambda r, who=email: r.url.startswith(BASE) and errs.append(f'{who} request failed: {r.url} {r.failure}'))
        pg.on('response', lambda r, who=email: r.status >= 500 and errs.append(f'{who} HTTP {r.status} {r.url}'))
        pg.goto(BASE + '/app'); pg.fill('#e', email); pg.fill('#p', 'demo password 123'); pg.click('button.primary'); pg.wait_for_timeout(1400)
        if not pg.query_selector('nav button'):
            counts[email] = 'no side menu (single workspace page; see dead controls check)'; pg.close(); continue
        keys = []
        for x in pg.query_selector_all('nav button'):
            k = x.get_attribute('data-t')
            if k and k not in keys: keys.append(k)
        ok = 0
        for k in keys:
            pg.click(f'nav button[data-t="{k}"]'); pg.wait_for_timeout(650)
            landed = pg.get_attribute('nav button[aria-current="page"]', 'data-t')
            if landed != k: problems.append(f'{email}: menu "{k}" landed on "{landed}"'); continue
            text = pg.inner_text('body')
            leaked = [w for w in LEAK if w in text]
            if leaked: problems.append(f'{email}: menu "{k}" shows {leaked}')
            else: ok += 1
        counts[email] = f'{ok}/{len(keys)}'
        problems += [f'{email}: {e}' for e in errs]
        pg.close()
    b.close()
print(json.dumps(counts))
print('PROBLEMS:', json.dumps(problems))
