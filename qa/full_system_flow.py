"""One project followed through every role, in the browser:
Super Admin verifies a publisher -> the owner builds and publishes a project (with an insurance minimum) ->
a subcontractor adds its trade and is invited automatically -> it sees the requirement and the bidding breadth ->
it bids -> the owner compares the bids and awards with a recorded insurance reason -> the subcontractor countersigns ->
Super Admin finds the award and countersignature in the audit log.
Prints PROBLEMS: [] when every step holds."""
import os, datetime
from playwright.sync_api import sync_playwright
BASE = 'http://127.0.0.1:' + os.environ.get('QA_PORT', '4400')
PW = 'demo password 123'
problems, steps = [], []
def watch(pg, who):
    pg.on('pageerror', lambda e: problems.append(f'{who} JS error: {e}'))
    pg.on('response', lambda r: r.status >= 500 and problems.append(f'{who} HTTP {r.status} {r.url}'))
    pg.on('dialog', lambda d: (problems.append(f'{who} dialog: {d.message}'), d.dismiss()))
due = (datetime.date.today() + datetime.timedelta(days=14)).isoformat()
with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 1280, 'height': 1000})
    def login(email, who):
        pg = ctx.new_page(); watch(pg, who); pg.goto(BASE + '/app'); pg.fill('#e', email); pg.fill('#p', PW); pg.click('button.primary'); pg.wait_for_timeout(1200); return pg
    def nav(pg, tab):
        pg.evaluate(f"document.querySelector('[data-t={tab}]')?.click()"); pg.wait_for_timeout(900)

    # 1. Super Admin approves the pending publisher.
    adm = ctx.new_page(); watch(adm, 'admin'); adm.goto(BASE + '/admin', wait_until='commit'); adm.wait_for_selector('#le', timeout=15000)
    adm.fill('#le', 'eric@bc.test'); adm.fill('#lp', PW); adm.click('#login button'); adm.wait_for_selector('nav#side', state='attached', timeout=15000)
    adm.goto(BASE + '/admin#/verification', wait_until='commit'); adm.wait_for_timeout(1200)
    adm.get_by_text('Ridge Builders').first.click(); adm.wait_for_timeout(1000)
    adm.click('[data-tab=verification]'); adm.wait_for_timeout(600)
    adm.click('[data-dec=approve]'); adm.wait_for_timeout(400)
    adm.fill('#dlgr', 'License WA-7781 checked on the state register; contact confirmed.'); adm.click('#dlgok'); adm.wait_for_timeout(1200)
    steps.append('1 super admin approves the publisher: ' + str('Verified' in adm.inner_text('#main') or 'verified' in adm.inner_text('#main')))

    # 2. The owner builds the project in the wizard, adds a package with an insurance minimum, and publishes.
    own = login('gc@ridge.test', 'owner')
    steps.append('2 owner sees the verified publisher workspace: ' + str('Verified publisher' in own.inner_text('#verc') or 'Publisher verification' not in own.inner_text('body')))
    own.click('#newpub'); own.wait_for_timeout(400)
    for k, v in {'title': 'Lighting retrofit, Seattle office', 'address': '900 Pike St', 'city': 'Seattle', 'state': 'WA', 'description': 'Office lighting retrofit, four floors.'}.items(): own.fill(f'#npf [name={k}]', v)
    own.select_option('#npf [name=projectType]', 'office'); own.click('#npf [data-next="2"]'); own.wait_for_timeout(300)
    own.fill('#npf [name=developer]', 'Ridge Builders'); own.click('#npf [data-next="3"]'); own.wait_for_timeout(300)
    own.click('#npf .wstep[data-s="3"] button.primary'); own.wait_for_timeout(1200)
    steps.append('2a wizard creates the draft: ' + str('Lighting retrofit, Seattle office' in own.inner_text('#pubm'))) 
    own.fill('#pkf [name=title]', 'Electrical'); own.fill('#pkf [name=dueDate]', due); own.select_option('#pkf [name=trade]', 'electrical')
    own.fill('#pkf [name=description]', 'Electrical lighting retrofit per the E-series drawings.'); own.fill('#pkf [name=insuranceGL]', '1000000')
    own.click('#pkf button.primary'); own.wait_for_timeout(1200)
    if own.query_selector('[data-nodocs]'): own.click('[data-nodocs]'); own.wait_for_timeout(900)
    own.click('#pbpub'); own.wait_for_timeout(1200)
    steps.append('2b published: ' + str('published' in own.inner_text('#pubm')))
    if 'published' not in own.inner_text('#pubm'): problems.append('project did not publish: ' + own.inner_text('#pberr') if own.query_selector('#pberr') else 'project did not publish')

    # 3. A subcontractor adds its trade and is invited automatically to the open package in its area.
    sub = login('sub@em.test', 'subcontractor')
    nav(sub, 'plan'); sub.check('input[name=ptr][value=electrical]'); sub.click('#pff button.primary'); sub.wait_for_timeout(1200)
    nav(sub, 'invitations')
    try: sub.wait_for_function("() => document.body.innerText.includes('Insurance required to bid')", timeout=8000)
    except Exception: pass
    inv = sub.inner_text('body')
    steps.append('3 subcontractor is invited automatically after adding its trade: ' + str('Insurance required to bid' in inv))
    if 'Insurance required to bid' not in inv: problems.append('subcontractor was not invited to the open package after adding its trade')
    steps.append('3b invitation states the insurance required and how many were invited: ' + str('Insurance required to bid' in inv and 'companies were invited' in inv))

    # 4. It bids.
    if sub.query_selector('[data-bidform]'):
        sub.click('[data-bidform]'); sub.wait_for_timeout(400)
        sub.fill('input[name=amount]', '96500'); sub.fill('textarea[name=scope]', 'Lighting retrofit for all four floors per E-series drawings.')
        sub.fill('input[name=documentUrl]', 'https://example.com/lighting-bid.pdf'); sub.click('text=Send bid'); sub.wait_for_timeout(1500)
        steps.append('4 bid submitted: ' + str('96,500' in sub.inner_text('body')))
    else:
        problems.append('subcontractor cannot open the bid form for the invitation')

    # 5. The owner compares, sees the insurance shortfall, and awards with a recorded reason.
    own.reload(); own.wait_for_timeout(1000)
    own.evaluate("document.querySelector('[data-pubopen]')?.click()"); own.wait_for_timeout(900)
    own.evaluate("document.querySelector('[data-level]')?.click()"); own.wait_for_timeout(1000)
    cmp = own.inner_text('body')
    steps.append('5 owner sees the bid and the insurance result: ' + str('96,500' in cmp and 'Below insurance minimum' in cmp))
    own.click('[data-lvaward]'); own.wait_for_timeout(500)
    own.fill('.signrow input[name=n]', 'Dana Gray'); own.check('.signrow input[name=c]')
    own.fill('.signrow textarea[name=ir]', 'Certificate arrives Monday; owner accepted the bid.')
    own.click('.signrow button.primary'); own.wait_for_timeout(1500)
    steps.append('5b award signed: ' + str('awarded' in own.inner_text('body').lower()))

    # 6. The subcontractor countersigns.
    sub.reload(); sub.wait_for_timeout(900); nav(sub, 'contracts'); sub.wait_for_timeout(700)
    if sub.query_selector('[data-csign]'):
        sub.evaluate("document.querySelector('[data-csign]').click()"); sub.wait_for_timeout(300)
        form = sub.locator('form[data-csform]:not([hidden])')
        form.locator('input[name=signerName]').fill('Ana Ruiz'); form.locator('input[name=consent]').check(); form.locator('button[type=submit]').click(); sub.wait_for_timeout(1200)
        steps.append('6 countersigned: ' + str('Fully signed' in sub.inner_text('body')))
    else:
        problems.append('subcontractor has no contract to countersign')

    # 7. Super Admin finds the award and countersignature in the audit log.
    adm.goto(BASE + '/admin#/audit', wait_until='commit'); adm.wait_for_timeout(1500)
    audit = adm.inner_text('#main')
    steps.append('7 super admin audit shows the award and countersignature: ' + str('request.award' in audit and 'contract.countersign' in audit))
    if 'request.award' not in audit: problems.append('audit log does not show the award')
    b.close()
problems += [f'step failed: {x}' for x in steps if x.endswith('False')]
print('\n'.join(steps)); print('PROBLEMS:', [x for x in problems if 'ERR_NAME' not in x])
