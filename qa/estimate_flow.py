import os
BASE = 'http://127.0.0.1:' + os.environ.get('QA_PORT', '4400')
F = lambda n: os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures', n)
OUT = lambda n: os.path.join(os.environ.get('QA_OUT', '/tmp'), n)
from playwright.sync_api import sync_playwright
problems, steps = [], []
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 1400, 'height': 1100})
    pg.on('pageerror', lambda e: problems.append(str(e))); pg.on('response', lambda r: r.status >= 500 and problems.append(f'{r.status} {r.url}'))
    pg.goto(BASE + '/'); pg.fill('#e', 'est@prairie.test'); pg.fill('#p', 'demo password 123'); pg.click('button.primary'); pg.wait_for_timeout(1200)
    pg.click('nav button[data-t=invitations]'); pg.wait_for_timeout(1200)
    pg.click('[data-ai]'); pg.wait_for_timeout(800)
    steps.append('1 verified analysis shown: ' + str('Verified by' in pg.inner_text('body')))
    pg.click('[data-est-from]'); pg.wait_for_timeout(800)
    t = pg.inner_text('body'); steps.append('2 estimate lines with sources: ' + str('101 LOBBY' in pg.content() and 'sheet A2.1 · 101' in t))
    for n in ['0', '1']:
        pg.fill(f'input[data-f=laborUnit][data-n="{n}"]', '3'); pg.dispatch_event(f'input[data-f=laborUnit][data-n="{n}"]', 'change')
        pg.fill(f'input[data-f=materialUnit][data-n="{n}"]', '5'); pg.dispatch_event(f'input[data-f=materialUnit][data-n="{n}"]', 'change')
    pg.click('[data-save]'); pg.wait_for_timeout(800)
    t = pg.inner_text('body'); steps.append('3 calculated total (3650 SF x $8 +10% +10% = $35,332.00): ' + str('Total $35,332.00' in t))
    pg.click('[data-submit]'); pg.wait_for_timeout(1000)
    t = pg.inner_text('body'); steps.append('4 submitted as bid: ' + str('Your bid: $35,332.00' in t) + ' / estimate locked: ' + str('Submitted as your bid' in t))
    pg.screenshot(path=OUT('est1.png'), full_page=True)
    b.close()
print('\n'.join(steps)); print('PROBLEMS:', [x for x in problems if 'ERR_NAME' not in x])
