# Super Admin Phase 5 in the browser: analytics, action queue, support cases (internal vs customer notes),
# incidents, privacy requests, jobs & health center, scoped exports. Fails on any page error or raw
# "undefined"/"NaN"/"[object Object]" text.
import os, importlib.util
BASE = 'http://127.0.0.1:' + os.environ.get('QA_PORT', '4401')
spec = importlib.util.spec_from_file_location('af', os.path.join(os.path.dirname(__file__), 'admin_flow_lib.py')); af = importlib.util.module_from_spec(spec); spec.loader.exec_module(af)
from playwright.sync_api import sync_playwright
BAD = ['undefined', 'NaN', '[object Object]']
problems, steps = [], []
def page_ok(pg, name):
    txt = pg.inner_text('#main') if pg.query_selector('#main') else pg.inner_text('body')
    for b in BAD:
        if b in txt: problems.append(f'{name}: shows raw "{b}"')
    if pg.query_selector('#main .card.err'): problems.append(f'{name}: error card on page')
    steps.append(f'{name}: loaded')
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 1400, 'height': 1000}); af.watch(pg, 'admin', problems)
    pg.goto(BASE + '/admin'); pg.fill('#le', 'eric@bc.test'); pg.fill('#lp', 'demo password 123'); pg.click('#login button'); pg.wait_for_selector('nav#side', timeout=15000)
    for route, name in [('#/analytics', 'analytics'), ('#/queue', 'action queue'), ('#/jobs', 'jobs & health'), ('#/privacy', 'privacy requests'), ('#/exports', 'exports'), ('#/incidents', 'incidents'), ('#/support', 'support cases')]:
        pg.goto(BASE + '/admin' + route); pg.wait_for_timeout(1200); page_ok(pg, name)
    # health center shows honest states
    pg.goto(BASE + '/admin#/jobs'); pg.wait_for_timeout(1200)
    if 'Database storage' not in pg.inner_text('#main'): problems.append('health center: missing storage check')
    # support case: open, add internal and customer notes, change status
    pg.goto(BASE + '/admin#/support'); pg.wait_for_timeout(1000)
    pg.fill('#newcase input[name=subject]', 'QA: panel not energizing'); pg.fill('#newcase textarea[name=body]', 'Customer-visible opening note')
    pg.click('#newcase button[type=submit]'); pg.wait_for_timeout(1500)
    if '#/support/' not in pg.url: problems.append('support: case not opened (no redirect to the case)')
    else:
        pg.fill('#addnote textarea[name=body]', 'QA internal: check breaker'); pg.select_option('#addnote select[name=visibility]', 'internal'); pg.click('#addnote button'); pg.wait_for_timeout(1000)
        if 'INTERNAL (staff only)' not in pg.inner_text('#main'): problems.append('support: internal note not labelled')
        pg.select_option('#setstatus select[name=status]', 'waiting_customer'); pg.fill('#setstatus input[name=reason]', 'waiting for the customer reply'); pg.click('#setstatus button'); pg.wait_for_timeout(1000)
        if 'waiting customer' not in pg.inner_text('#main') and 'waiting_customer' not in pg.inner_text('#main'): problems.append('support: status change not shown')
        steps.append('support: case opened, internal and customer notes, status changed')
    # incident: open, then add an update
    pg.goto(BASE + '/admin#/incidents'); pg.wait_for_timeout(1000)
    pg.fill('#newinc input[name=title]', 'QA: test incident one'); pg.fill('#newinc textarea[name=summary]', 'Opened by the QA check.')
    pg.click('#newinc button[type=submit]'); pg.wait_for_timeout(1500)
    if '#/incidents/' not in pg.url: problems.append('incidents: not opened')
    else:
        pg.select_option('#upd select[name=status]', 'monitoring'); pg.fill('#upd textarea[name=message]', 'QA update: monitoring'); pg.click('#upd button'); pg.wait_for_timeout(1000)
        steps.append('incidents: opened and updated')
    # export: create, token shown once
    pg.goto(BASE + '/admin#/exports'); pg.wait_for_timeout(1000)
    pg.fill('#mkexp input[name=reason]', 'QA check of the export screen'); pg.click('#mkexp button[type=submit]'); pg.wait_for_timeout(1500)
    if 'Export ready' not in pg.inner_text('#tok') if pg.query_selector('#tok') else True: problems.append('exports: no export created')
    else: steps.append('exports: created, token shown once')
    print('steps: ' + ' | '.join(steps)); print('PROBLEMS: ' + str(problems))
    b.close()
