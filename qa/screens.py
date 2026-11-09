import os
BASE = 'http://127.0.0.1:' + os.environ.get('QA_PORT', '4401')
F = lambda n: os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures', n)
OUT = lambda n: os.path.join(os.environ.get('QA_OUT', '/tmp'), n)
from playwright.sync_api import sync_playwright
problems = []
def watch(pg, who):
    pg.on('pageerror', lambda e: problems.append(f'{who} JS error: {e}'))
    pg.on('console', lambda m: m.type == 'error' and problems.append(f'{who} console: {m.text}'))
    pg.on('response', lambda r: r.status >= 500 and problems.append(f'{who} HTTP {r.status} {r.url}'))
    pg.on('dialog', lambda d: (problems.append(f'{who} unexpected dialog: {d.message}'), d.dismiss()))
def login(b, email, who):
    pg = b.new_page(viewport={'width': 1200, 'height': 900}); watch(pg, who)
    pg.goto(BASE + '/app'); pg.fill('#e', email); pg.fill('#p', 'demo password 123'); pg.click('button.primary'); pg.wait_for_timeout(1000)
    return pg
with sync_playwright() as p:
    b = p.chromium.launch()
    for email, who in [('eric@bc.test', 'platform'), ('sub@em.test', 'subscriber')]:
        pg = login(b, email, who)
        tabs = [t.get_attribute('data-t') for t in pg.query_selector_all('nav button')]
        for t in tabs:
            pg.click(f'nav button[data-t="{t}"]'); pg.wait_for_timeout(500)
        if who == 'subscriber':
            pg.click('nav button[data-t=projects]'); pg.wait_for_timeout(500)
            pg.click('#res a >> nth=0'); pg.wait_for_timeout(600)
            # XSS + javascript: link checks on the project page
            html = pg.content()
            if '<script>alert(1)</script>' in html: problems.append('XSS: raw script tag rendered')
            if 'href="javascript:' in html: problems.append('javascript: link rendered')
            pg.click('[data-track=watching]'); pg.wait_for_timeout(500)
            pg.click('nav button[data-t=contractors]'); pg.wait_for_timeout(500); pg.click('#cres a >> nth=0'); pg.wait_for_timeout(500)
            pg.click('nav button[data-t=planning]'); pg.wait_for_timeout(500)
        print(who, 'tabs visited:', len(tabs))
    pg = login(b, 'pm@acme.test', 'buyer'); pg.wait_for_timeout(1500); print('buyer view loaded:', 'Project Publishing Center' in pg.content())
    m = b.new_page(viewport={'width': 390, 'height': 844}); watch(m, 'signup'); m.goto(BASE + '/app'); m.click('#ss'); m.wait_for_timeout(300); m.click('text=Back to sign in'); m.click('#su'); m.wait_for_timeout(300)
    b.close()
print('PROBLEMS:', len(problems)); [print(' -', x) for x in problems]
