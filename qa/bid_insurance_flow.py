# A subcontractor sees the publisher's insurance minimum in the bid form, adds a certificate there, and the
# form shows the minimum met without losing the bid being typed. Uses the API for the GC's request so the
# package carries an insurance minimum (the posting form does not expose one).
import os, json, datetime
BASE = 'http://127.0.0.1:' + os.environ.get('QA_PORT', '4400')
from playwright.sync_api import sync_playwright
problems, steps = [], []
def login(b, email):
    pg = b.new_page(viewport={'width': 1200, 'height': 1000})
    pg.on('pageerror', lambda e: problems.append(f'{email} JS error: {e}'))
    pg.goto(BASE + '/app'); pg.fill('#e', email); pg.fill('#p', 'demo password 123'); pg.click('button.primary'); pg.wait_for_timeout(1000)
    return pg
due = (datetime.date.today() + datetime.timedelta(days=10)).isoformat()
with sync_playwright() as p:
    b = p.chromium.launch()
    sub = login(b, 'sub@em.test')
    sub.click('nav button[data-t=plan]'); sub.wait_for_timeout(600)
    sub.check('input[name=ptr][value=glazing]'); sub.click('#pff button.primary'); sub.wait_for_timeout(600)
    gc = login(b, 'pm@acme.test')
    posted = gc.evaluate("""async (due) => {
      const r = await fetch('/api/requests', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + sessionStorage.getItem('bi_token') },
        body: JSON.stringify({ title: 'Insured glazing package', address: '700 Pike St', city: 'Seattle', state: 'WA', dueDate: due, trades: ['glazing'], projectType: 'retail',
          description: 'Replace ground-floor storefront system, 180 LF.', documentsUrl: 'https://plans.example/insured', noDocuments: true,
          insuranceRequirements: { generalLiabilityMin: 1000000, workersComp: true } }) });
      return { status: r.status, body: await r.text() };
    }""", due)
    steps.append('1 GC posted package with insurance minimum: HTTP ' + str(posted['status']))
    if posted['status'] >= 300: problems.append('could not post the package: ' + posted['body'][:200])
    sub.reload(); sub.wait_for_timeout(800)
    sub.click('nav button[data-t=invitations]'); sub.wait_for_timeout(800)
    sub.click('[data-intent=will_bid]'); sub.wait_for_timeout(500)
    sub.click('[data-bidform]:not([disabled])'); sub.wait_for_timeout(700)
    fit = sub.inner_text('.insfit') if sub.query_selector('.insfit') else ''
    steps.append('2 bid form shows minimum: ' + str('general liability' in fit and 'workers comp' in fit))
    if 'general liability of at least' not in fit: problems.append('bid form does not state the general liability minimum')
    sub.fill('input[name=amount]', '52000'); sub.fill('textarea[name=scope]', 'Storefront glazing, glass and hardware, per plans.')
    sub.evaluate("document.querySelector('.insfit details').open = true")
    sub.fill('.insfit-form input[name=carrier]', 'Northwest Mutual Casualty'); sub.fill('.insfit-form input[name=policy]', 'GL-1182')
    sub.fill('.insfit-form input[name=gl]', '2000000'); sub.fill('.insfit-form input[name=wc]', '500000'); sub.fill('.insfit-form input[name=expires]', '2027-12-31')
    sub.click('.insfit-form button'); sub.wait_for_timeout(900)
    fit2 = sub.inner_text('.insfit')
    steps.append('3 after adding certificate: ' + fit2.split('\n')[0][:90])
    if 'do not yet meet' in fit2 or 'meet this package' not in fit2: problems.append('certificate added but the form still shows a shortfall: ' + fit2[:160])
    kept = sub.input_value('input[name=amount]') == '52000' and 'Storefront glazing' in sub.input_value('textarea[name=scope]')
    steps.append('4 typed bid kept: ' + str(kept))
    if not kept: problems.append('adding a certificate cleared the bid being typed')
    b.close()
print('\n'.join(steps))
print('PROBLEMS:', json.dumps(problems))
