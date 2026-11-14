import os
BASE = 'http://127.0.0.1:' + os.environ.get('QA_PORT', '4400')
F = lambda n: os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures', n)
OUT = lambda n: os.path.join(os.environ.get('QA_OUT', '/tmp'), n)
from playwright.sync_api import sync_playwright
import sys
port = sys.argv[1]; bad = []; ok = 0
with sync_playwright() as p:
    b = p.chromium.launch()
    for email in ['sub@em.test', 'eric@bc.test']:
        pg = b.new_page(viewport={'width': 1500, 'height': 1000}); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(f'http://127.0.0.1:{port}/app'); pg.fill('#e', email); pg.fill('#p', 'demo password 123'); pg.click('button.primary'); pg.wait_for_timeout(1200)
        keys = [x.get_attribute('data-t') for x in pg.query_selector_all('nav button')]
        for k in keys:
            pg.click(f'nav button[data-t="{k}"]'); pg.wait_for_timeout(700)
            sel = pg.get_attribute('nav button[aria-current="page"]', 'data-t')
            if sel != k: bad.append(f'{email}: clicked {k} but landed on {sel}')
            else: ok += 1
        if errs: bad.append(f'{email}: JS errors {errs}')
    b.close()
print(f'{ok} menu items opened their own page'); print('PROBLEMS:', bad)
