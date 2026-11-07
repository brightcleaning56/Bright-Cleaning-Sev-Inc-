# Super Admin Phase 3 in the browser (rich world): projects + correction, package oversight, revoking plan access kills a
# link the bidder already holds (then restore), quarantine/release, duplicates, markets, mobile menu, dead controls.
import os, json, importlib.util
BASE = 'http://127.0.0.1:' + os.environ.get('QA_PORT', '4403')
spec = importlib.util.spec_from_file_location('af', os.path.join(os.path.dirname(__file__), 'admin_flow_lib.py')); af = importlib.util.module_from_spec(spec); spec.loader.exec_module(af)
from playwright.sync_api import sync_playwright
steps, problems = [], []
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 1400, 'height': 1000}); af.watch(pg, 'admin', problems); checked = 0
    pg.goto(BASE + '/admin'); pg.fill('#le', 'eric@bc.test'); pg.fill('#lp', 'demo password 123'); pg.click('#login button'); pg.wait_for_timeout(1200)
    pg.click('[data-nav="projects"]'); pg.wait_for_timeout(800); checked += af.dead_controls(pg, 'projects', problems)
    pg.click('main a[href^="#/project/"] >> nth=0'); pg.wait_for_timeout(800); checked += af.dead_controls(pg, 'project', problems)
    pg.click('#pfix'); pg.wait_for_selector('#dlg[open]'); pg.select_option('#dlgx [name=field]', 'name'); pg.fill('#dlgx [name=value]', 'Pine St Office Tower'); af.confirm(pg, 'Name from the developer site plan'); pg.wait_for_timeout(700)
    t = pg.inner_text('main'); steps.append('1 project directory → profile → correct name; history kept, source permits shown unchanged: ' + str('Pine St Office Tower' in t and 'Name from the developer site plan' in t and 'source records' in t))
    sub = b.new_page(); sub.goto(BASE + '/'); sub.fill('#e', 'sub@em.test'); sub.fill('#p', 'demo password 123'); sub.click('button.primary'); sub.wait_for_timeout(1000)
    stok = sub.evaluate("sessionStorage.getItem('bi_token')")
    docs = sub.request.get(BASE + '/api/documents', headers={'authorization': 'Bearer ' + stok}).json(); did = docs[0]['id']
    link = sub.request.post(BASE + f'/api/documents/{did}/link', headers={'authorization': 'Bearer ' + stok}).json()['url']
    ok_before = sub.request.get(BASE + link).status == 200
    pg.click('[data-nav="packages"]'); pg.wait_for_timeout(800); checked += af.dead_controls(pg, 'packages', problems)
    pg.click('main a[href^="#/package/"] >> nth=0'); pg.wait_for_timeout(900); checked += af.dead_controls(pg, 'package', problems)
    pg.click('[data-acc][data-rev="true"] >> nth=0'); af.confirm(pg, 'Bidder disputed NDA terms'); af.confirm(pg, password='demo password 123'); pg.wait_for_timeout(900)
    ok_after = sub.request.get(BASE + link).status
    steps.append(f'2 package oversight → revoke plan access: link issued earlier works before ({ok_before}), refused after (HTTP {ok_after}): ' + str(ok_before and ok_after != 200 and 'revoked' in pg.inner_text('main')))
    pg.click('[data-acc][data-rev="false"] >> nth=0'); af.confirm(pg, 'NDA signed'); pg.wait_for_timeout(800)
    new_link = sub.request.post(BASE + f'/api/documents/{did}/link', headers={'authorization': 'Bearer ' + stok}).json().get('url')
    steps.append('   restore → bidder can open plans again: ' + str(bool(new_link) and sub.request.get(BASE + new_link).status == 200))
    pg.click('[data-nav="documents"]'); pg.wait_for_timeout(800); checked += af.dead_controls(pg, 'documents', problems)
    pg.click('main a[href^="#/document/"] >> nth=0'); pg.wait_for_timeout(800); checked += af.dead_controls(pg, 'document', problems)
    pg.click('#dq'); af.confirm(pg, 'Suspicious embedded content reported'); pg.wait_for_timeout(800)
    q1 = 'quarantined' in pg.inner_text('main'); pg.click('#drel'); af.confirm(pg, 'Scanned clean by hand'); pg.wait_for_timeout(800)
    steps.append('3 quarantine then release a file: ' + str(q1 and 'available' in pg.inner_text('main')))
    pg.click('[data-nav="duplicates"]'); pg.wait_for_timeout(700); checked += af.dead_controls(pg, 'duplicates', problems)
    pg.click('[data-nav="markets"]'); pg.wait_for_timeout(700); checked += af.dead_controls(pg, 'markets', problems)
    steps.append('4 duplicate review and trades & markets open: ' + str('Trades' in pg.inner_text('main')))
    pg.click('[data-nav="audit"]'); pg.wait_for_timeout(600); pg.fill('#ff [name=action]', 'admin.'); pg.click('#ff button.primary'); pg.wait_for_timeout(700)
    t = pg.inner_text('main'); steps.append('5 audit shows correction, revoke/restore, quarantine/release: ' + str(all(x in t for x in ['admin.project.correct', 'admin.document.access.revoke', 'admin.document.access.restore', 'admin.document.quarantine', 'admin.document.release'])))
    m = b.new_page(viewport={'width': 390, 'height': 844}); af.watch(m, 'mobile', problems); m.goto(BASE + '/admin'); m.evaluate(f"sessionStorage.setItem('bi_admin_token', {json.dumps(pg.evaluate('sessionStorage.getItem(\"bi_admin_token\")'))})"); m.reload(); m.wait_for_timeout(1300)
    side_hidden = not m.is_visible('#side'); main_top = m.evaluate("() => document.querySelector('main').getBoundingClientRect().top")
    m.click('#menu'); m.wait_for_timeout(300); opened = m.is_visible('#side [data-nav="projects"]'); m.click('#side [data-nav="projects"]'); m.wait_for_timeout(900)
    steps.append(f'6 phone: menu collapsed, workspace starts at {int(main_top)}px; menu opens, choosing an item closes it: ' + str(side_hidden and main_top < 200 and opened and not m.is_visible('#side') and 'Projects' in m.inner_text('#crumbs')))
    m.screenshot(path=os.path.join(os.environ.get('QA_OUT', '/tmp'), 'admin-mobile-menu.png'))
    steps.append(f'7 dead-control check: {checked} controls on visited pages')
    b.close()
print('\n'.join(steps)); print('PROBLEMS:', [x for x in problems if 'ERR_NAME' not in x])
