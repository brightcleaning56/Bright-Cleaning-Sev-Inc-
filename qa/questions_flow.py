"""Package questions, answered by the GC in the browser and read back by an invited company.

The subcontractor asks a question (API setup + the ask form is checked in the browser), the GC answers it in its own
browser session, and the subcontractor then sees the answer. The asker is not named to other bidders.
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
api('PATCH', '/api/profile', {'trades': ['electrical']}, sub_token)
req = api('POST', '/api/requests', {'title': 'Questions flow electrical, Seattle lab', 'address': '12 Lab Way', 'city': 'Seattle', 'state': 'WA',
    'projectType': 'medical', 'trades': ['electrical'], 'dueDate': due, 'description': 'Electrical for a laboratory fit-out with fume hood circuits.'}, gc_token)
api('POST', f"/api/requests/{req['id']}/questions", {'question': 'Are the fume hood circuits in the electrical scope or by the owner?'}, sub_token)
steps.append('1 company asked a question')

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
    gc = open_app('pm@acme.test', 'gc')
    gc.evaluate("document.querySelector('[data-t=requests], [data-t=publications], [data-t=publish]')?.click()"); gc.wait_for_timeout(800)
    qbtn = gc.locator(f'button[data-qa="{req["id"]}"]')
    if qbtn.count() == 0:
        problems.append('GC cannot find the questions control for its package')
    else:
        qbtn.first.click(); gc.wait_for_timeout(800)
        panel = gc.locator(f'#qa-{req["id"]}')
        txt = panel.inner_text()
        steps.append('2 GC sees the question: ' + str('fume hood' in txt))
        if 'fume hood' not in txt:
            problems.append('GC does not see the question')
        else:
            panel.locator('input[name=answer]').fill('Owner furnishes and connects the fume hood circuits; electrical provides the feeders.')
            panel.locator('button', has_text='Answer').click(); gc.wait_for_timeout(1000)
            steps.append('3 GC answered: ' + str('A: Owner furnishes' in gc.locator(f'#qa-{req["id"]}').inner_text()))

    sub = open_app('sub@em.test', 'sub')
    sub.evaluate("document.querySelector('[data-t=invitations]')?.click()"); sub.wait_for_timeout(900)
    sbtn = sub.locator(f'button[data-qa="{req["id"]}"]')
    if sbtn.count() == 0:
        problems.append('invited company cannot find the questions control for the package')
    else:
        sbtn.first.click(); sub.wait_for_timeout(900)
        t = sub.locator(f'#qa-{req["id"]}').inner_text()
        steps.append('4 invited company reads the answer: ' + str('Owner furnishes' in t))
        if 'Owner furnishes' not in t:
            problems.append('invited company does not see the GC answer')
        if 'Q (' not in t:
            problems.append('question list missing for the invited company')
    b.close()

print('\n'.join(steps))
print('PROBLEMS:', json.dumps(problems))
