import os
BASE = 'http://127.0.0.1:' + os.environ.get('QA_PORT', '4400')
F = lambda n: os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures', n)
OUT = lambda n: os.path.join(os.environ.get('QA_OUT', '/tmp'), n)
from playwright.sync_api import sync_playwright
import datetime
due = (datetime.date.today() + datetime.timedelta(days=10)).isoformat()
problems, steps = [], []
def watch(pg, who):
    pg.on('pageerror', lambda e: problems.append(f'{who} JS error: {e}'))
    pg.on('response', lambda r: r.status >= 500 and problems.append(f'{who} HTTP {r.status} {r.url}'))
    pg.on('dialog', lambda d: (problems.append(f'{who} dialog: {d.message}'), d.dismiss()))
with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 1200, 'height': 1100})
    def login(email, who):
        pg = ctx.new_page(); watch(pg, who); pg.goto(BASE + '/'); pg.fill('#e', email); pg.fill('#p', 'demo password 123'); pg.click('button.primary'); pg.wait_for_timeout(1000); return pg
    sub = login('sub@em.test', 'sub'); sub.click('nav button[data-t=plan]'); sub.wait_for_timeout(500); sub.check('input[name=ptr][value=electrical]'); sub.click('#pff button.primary'); sub.wait_for_timeout(400)
    gc = login('pm@acme.test', 'gc')
    gc.fill('#t', 'Medical office electrical'); gc.fill('#a', '700 Pike St'); gc.fill('#ci', 'Seattle'); gc.fill('#st', 'WA'); gc.fill('#dd', due); gc.check('input[name=tr][value=electrical]'); gc.click('#rf button.primary'); gc.wait_for_timeout(3200)
    gc.set_input_files('form[data-up] input[type=file]', [F('A2.1 - Level 1 Floor Plan.pdf'), F('E2.01_Lighting_Plan.pdf'), F('Project Manual - Division 26 Electrical.pdf')])
    gc.click('form[data-up] button'); gc.wait_for_timeout(1500)
    txt = gc.inner_text('body'); steps.append('1 GC plan room indexed: ' + str(all(k in txt for k in ['Architectural', 'Electrical', 'Specifications', 'A2.1 — Level 1 Floor Plan', 'E2.01 — Lighting Plan'])))
    gc.set_input_files('form[data-up] input[type=file]', [F('E2.01_Lighting_Plan rev1.pdf')]); gc.check('form[data-up] input[name=add]'); gc.fill('form[data-up] input[name=note]', 'Revised lighting layout, level 1'); gc.click('form[data-up] button'); gc.wait_for_timeout(1500)
    steps.append('2 addendum posted: ' + str('Addendum 1' in gc.inner_text('body')))
    sub.click('nav button[data-t=invitations]'); sub.wait_for_timeout(1000)
    st = sub.inner_text('body'); steps.append('3 bidder sees plan room + addendum gate: ' + str('Plan room' in st and 'Addendum 1 posted' in st))
    docid = sub.get_attribute('[data-doc-open] >> nth=0', 'data-doc-open')
    ok = sub.evaluate('''async id => { const tok = sessionStorage.getItem('bi_token');
      const l = await (await fetch('/api/documents/' + id + '/link', { method: 'POST', headers: { Authorization: 'Bearer ' + tok } })).json();
      const r = await fetch(l.url); const head = new Uint8Array(await r.arrayBuffer()).slice(0, 5);
      return r.status === 200 && r.headers.get('content-type') === 'application/pdf' && String.fromCharCode(...head) === '%PDF-'; }''', docid)
    steps.append('4 bidder opens drawing (signed link serves the PDF): ' + str(ok))
    sub.click('[data-bidform]'); sub.wait_for_timeout(300); sub.fill('input[name=amount]', '312000'); sub.fill('textarea[name=scope]', 'Complete electrical per E-series drawings and Division 26.'); sub.click('text=Send bid'); sub.wait_for_timeout(700)
    steps.append('5 bid blocked before ack: ' + str('acknowledge addendum 1' in sub.inner_text('body')))
    sub.click('[data-ack]'); sub.wait_for_timeout(700); sub.click('[data-bidform]'); sub.wait_for_timeout(300); sub.fill('input[name=amount]', '312000'); sub.fill('textarea[name=scope]', 'Complete electrical per E-series drawings and Division 26.'); sub.click('text=Send bid'); sub.wait_for_timeout(800)
    steps.append('6 bid after ack: ' + str('$312,000.00' in sub.inner_text('body')))
    gc.reload(); gc.wait_for_timeout(2000); g = gc.inner_text('body')
    steps.append('7 GC planholders: opened=' + str('yes, 1 file(s)' in g) + ' ack=' + str('1 of 1' in g) + ' bid=' + str('submitted' in g))
    gc.screenshot(path=OUT('pr1.png'), full_page=True)
    b.close()
print('\n'.join(steps)); print('PROBLEMS:', [x for x in problems if 'ERR_NAME' not in x])
