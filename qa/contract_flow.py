"""Award to fully signed, then contract amendments, across two companies.

The GC posts a package, the subcontractor bids, the GC awards, both sign, then the GC proposes a price change.
The setup runs through the API (it is not what this check is about); the amendment steps run in the browser as each
person, so the buttons, forms and records the people actually see are what gets checked.
Prints PROBLEMS: [] when every step holds.
"""
import os, json, datetime, urllib.request, urllib.error
BASE = 'http://127.0.0.1:' + os.environ.get('QA_PORT', '4400')
PW = 'demo password 123'
problems, steps = [], []

def api(method, path, body=None, token=None):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Content-Type': 'application/json', **({'Authorization': 'Bearer ' + token} if token else {})})
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        raise RuntimeError(f'{method} {path} -> {e.code}: {e.read().decode()[:300]}')

def login(email):
    return api('POST', '/api/login', {'email': email, 'password': PW})['token']

due = (datetime.date.today() + datetime.timedelta(days=14)).isoformat()
gc_token, sub_token = login('pm@acme.test'), login('sub@em.test')
api('PATCH', '/api/profile', {'trades': ['electrical']}, sub_token)   # the subcontractor's trade, as the sign-up sets it

# 1. The GC posts a package; the subcontractor is invited and bids.
req = api('POST', '/api/requests', {'title': 'Contract flow electrical, Seattle clinic', 'address': '77 Award St', 'city': 'Seattle', 'state': 'WA',
    'projectType': 'medical', 'trades': ['electrical'], 'dueDate': due, 'description': 'Electrical rough-in and trim for a two-storey clinic addition.'}, gc_token)
inv = next((i for i in api('GET', '/api/invitations', None, sub_token) if i['request']['id'] == req['id']), None)
if not inv:
    problems.append('subcontractor was not invited to the new package')
else:
    bid = api('POST', f"/api/invitations/{inv['id']}/bid", {'amount': 180000, 'scope': 'Electrical rough-in and trim per the drawings and specifications.', 'documentUrl': 'https://example.com/bid.pdf', 'validDays': 30}, sub_token)
    steps.append('1 bid submitted')
    # 2. The GC awards with a typed signature; the subcontractor countersigns.
    aw = api('POST', f"/api/requests/{req['id']}/award", {'submissionId': bid['id'], 'signerName': 'Dana Gray', 'consent': True}, gc_token)
    contract = next(c for c in api('GET', '/api/contracts', None, sub_token) if c['id'] == aw['contractId'])
    if contract['canCountersign']:
        api('POST', f"/api/contracts/{contract['id']}/countersign", {'signerName': 'Sam Lee', 'consent': True}, sub_token)
    st = next(c for c in api('GET', '/api/contracts', None, gc_token) if c['id'] == aw['contractId'])
    if st['status'] != 'fully_signed' or not st['countersigned']:
        problems.append(f"award did not reach fully signed (status {st['status']})")
    steps.append('2 award countersigned: fully signed')
    # 3. The GC proposes a price change through the API; the subcontractor must accept it in the browser.
    api('POST', f"/api/contracts/{aw['contractId']}/amendments", {'total': 186000, 'reason': 'Owner added lobby fixtures per addendum 2.', 'signerName': 'Dana Gray', 'consent': True}, gc_token)
    contract_id = aw['contractId']

if not problems:
    from playwright.sync_api import sync_playwright
    def watch(pg, who):
        pg.on('pageerror', lambda e: problems.append(f'{who} JS error: {e}'))
        pg.on('response', lambda r: r.status >= 500 and problems.append(f'{who} HTTP {r.status} {r.url}'))
        pg.on('dialog', lambda d: (problems.append(f'{who} dialog: {d.message}'), d.dismiss()))
    with sync_playwright() as p:
        b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 1200, 'height': 1000})
        def open_app(email, who):
            pg = ctx.new_page(); watch(pg, who); pg.goto(BASE + '/app'); pg.fill('#e', email); pg.fill('#p', PW); pg.click('button.primary'); pg.wait_for_timeout(1000)
            return pg
        def go_contracts(pg):
            pg.evaluate("document.querySelector('[data-t=contracts]')?.click()"); pg.wait_for_timeout(800)

        # 4. Subcontractor sees the proposed change and accepts it with its own signature.
        sub = open_app('sub@em.test', 'sub'); go_contracts(sub)
        txt = sub.inner_text('body')
        steps.append('4 subcontractor sees the proposed change: ' + str('Review proposed change' in txt))
        if 'Review proposed change' not in txt:
            problems.append('subcontractor does not see the proposed change')
        else:
            sub.evaluate("document.querySelector('[data-amdec]').click()"); sub.wait_for_timeout(300)
            form = sub.locator('form[data-amdform]:not([hidden])')
            form.locator('input[name=signerName]').fill('Sam Lee'); form.locator('input[name=consent]').check()
            form.locator('button[value=accept]').click(); sub.wait_for_timeout(1200)
            after = sub.inner_text('body')
            if '$186,000' not in after and '186,000' not in after:
                problems.append('accepted change does not show the new amount')
            if 'accepted' not in after:
                problems.append('accepted change not listed in the contract history')
            steps.append('5 subcontractor accepted; new amount shown: ' + str('186,000' in after))

        # 5. GC proposes a scope change in the browser; then withdraws it.
        gc = open_app('pm@acme.test', 'gc'); go_contracts(gc)
        txt = gc.inner_text('body')
        if 'Changes:' not in txt or '#1 accepted' not in txt:
            problems.append('GC does not see the accepted change in the contract history')
        gc.evaluate("document.querySelector('[data-amopen]').click()"); gc.wait_for_timeout(300)
        form = gc.locator('form[data-amform]:not([hidden])')
        form.locator('textarea[name=scope]').fill('Add two lobby fixtures and relocate one junction box.')
        form.locator('textarea[name=reason]').fill('Owner requested the lobby change after the walkthrough.')
        form.locator('input[name=signerName]').fill('Dana Gray'); form.locator('input[name=consent]').check()
        form.locator('button[type=submit]').click(); gc.wait_for_timeout(1200)
        txt = gc.inner_text('body')
        steps.append('6 GC proposed a second change: ' + str('#2 pending' in txt))
        if '#2 pending' not in txt:
            problems.append('proposed second change not shown as pending')
        gc.evaluate("document.querySelector('[data-amwd]').click()"); gc.wait_for_timeout(1200)
        txt = gc.inner_text('body')
        steps.append('7 GC withdrew it: ' + str('#2 withdrawn' in txt))
        if '#2 withdrawn' not in txt:
            problems.append('withdrawn change not shown as withdrawn')
        raw = urllib.request.urlopen(urllib.request.Request(BASE + f'/api/contracts/{contract_id}/document', headers={'Authorization': 'Bearer ' + gc_token})).read().decode()
        if 'Amendments' not in raw:
            problems.append('signed record does not list the amendments')
        b.close()

print('\n'.join(steps))
print('PROBLEMS:', json.dumps(problems))
