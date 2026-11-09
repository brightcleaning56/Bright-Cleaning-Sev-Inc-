import os
BASE = 'http://127.0.0.1:' + os.environ.get('QA_PORT', '4400')
F = lambda n: os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures', n)
OUT = lambda n: os.path.join(os.environ.get('QA_OUT', '/tmp'), n)
from playwright.sync_api import sync_playwright
import datetime
problems, steps = [], []
def watch(pg, who):
    pg.on('pageerror', lambda e: problems.append(f'{who} JS error: {e}'))
    pg.on('response', lambda r: r.status >= 500 and problems.append(f'{who} HTTP {r.status} {r.url}'))
    pg.on('dialog', lambda d: (problems.append(f'{who} dialog: {d.message}'), d.dismiss()))
def login(b, email, who):
    pg = b.new_page(viewport={'width': 1200, 'height': 1000}); watch(pg, who)
    pg.goto(BASE + '/app'); pg.fill('#e', email); pg.fill('#p', 'demo password 123'); pg.click('button.primary'); pg.wait_for_timeout(1000)
    return pg
due = (datetime.date.today() + datetime.timedelta(days=10)).isoformat()
with sync_playwright() as p:
    b = p.chromium.launch()
    sub = login(b, 'sub@em.test', 'sub')
    sub.click('nav button[data-t=plan]'); sub.wait_for_timeout(600)
    sub.check('input[name=ptr][value=glazing]'); sub.fill('input[name=legalName]', 'Emerald Glass LLC'); sub.fill('input[name=postalAddress]', '10 Pike St, Seattle, WA'); sub.click('#pff button.primary'); sub.wait_for_timeout(600)
    steps.append('1 profile: ' + sub.inner_text('#pfm'))
    gc = login(b, 'pm@acme.test', 'gc')
    gc.fill('#t', 'Storefront replacement'); gc.fill('#a', '700 Pike St'); gc.fill('#ci', 'Seattle'); gc.fill('#st', 'WA'); gc.fill('#dd', due)
    gc.fill('#docs', 'https://plans.example/storefront'); gc.fill('#ds', 'Replace ground-floor storefront system, 180 LF.')
    gc.check('input[name=tr][value=glazing]'); gc.click('#rf button.primary'); gc.wait_for_timeout(800)
    steps.append('2 GC posted: ' + gc.inner_text('#re'))
    sub.click('nav button[data-t=invitations]'); sub.wait_for_timeout(700)
    steps.append('3 sub sees invitation: ' + str('Storefront replacement' in sub.content()))
    sub.click('[data-intent=will_bid]'); sub.wait_for_timeout(600)
    sub.click('[data-bidform]'); sub.wait_for_timeout(300)
    sub.fill('input[name=amount]', '86400'); sub.fill('textarea[name=scope]', 'Furnish and install 180 LF thermally broken storefront, including glass and hardware.')
    sub.click('text=Send bid'); sub.wait_for_timeout(800)
    steps.append('4 sub bid shown: ' + str('$86,400.00' in sub.content()))
    gc.wait_for_timeout(2500); gc.reload(); gc.fill('#e', 'pm@acme.test') if gc.query_selector('#e') else None
    if gc.query_selector('#e'): gc.fill('#p', 'demo password 123'); gc.click('button.primary'); gc.wait_for_timeout(1000)
    gc.wait_for_timeout(1500); txt = gc.inner_text('body')
    steps.append('5 GC sees: invited/will-bid line=' + str('1 invited, 1 will bid' in txt) + ' bid listed=' + str('$86,400.00' in txt))
    gc.click('[data-level]'); gc.wait_for_timeout(900)
    t = gc.inner_text('body')
    steps.append('6 leveling table: ' + str('Bid leveling' in t and '$86,400.00' in t and 'none on file' in t and 'no general liability certificate on file' in t))
    gc.click('[data-pq][data-st=approved]'); gc.wait_for_timeout(900)
    steps.append('7 prequal approved: ' + str('approved' in gc.inner_text('body')))
    gc.screenshot(path=OUT('lv.png'), full_page=True)
    b.close()
print('\n'.join(steps)); print('PROBLEMS:', [x for x in problems if 'ERR_NAME' not in x and 'cdnjs' not in x])
