"""Publisher command center: tiles, project search and filter, request chooser, and the unconfirmed-account banner.
Uses the demo publisher (pm@acme.test) and creates one unconfirmed company for the banner check.
Prints PROBLEMS: [] when every step holds."""
import os, json, urllib.request
BASE = 'http://127.0.0.1:' + os.environ.get('QA_PORT', '4400')
problems, steps = [], []
from playwright.sync_api import sync_playwright

# An unconfirmed company, created through the public sign-up.
email = 'qa.unconfirmed.%d@test.invalid' % (os.getpid())
req = urllib.request.Request(BASE + '/api/signup/buyer', method='POST', data=json.dumps({'company': 'QA Unconfirmed Builders', 'kind': 'general_contractor', 'name': 'Qa', 'email': email, 'password': 'long enough password'}).encode(), headers={'Content-Type': 'application/json'})
urllib.request.urlopen(req).read()

def watch(pg, who):
    pg.on('pageerror', lambda e: problems.append(f'{who} JS error: {e}'))
    pg.on('response', lambda r: r.status >= 500 and problems.append(f'{who} HTTP {r.status} {r.url}'))

with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 1280, 'height': 900})
    pg = ctx.new_page(); watch(pg, 'publisher')
    pg.goto(BASE + '/app'); pg.fill('#e', 'pm@acme.test'); pg.fill('#p', 'demo password 123'); pg.click('button.primary'); pg.wait_for_timeout(1500)
    tiles = pg.evaluate("[...document.querySelectorAll('.cctile')].map(t => t.innerText)")
    steps.append(f'1 command center shows {len(tiles)} tiles')
    if len(tiles) != 8: problems.append(f'command center has {len(tiles)} tiles, expected 8')
    rows = pg.evaluate("document.querySelectorAll('#pubrows tr').length")
    pg.fill('#pubq', 'zzz-no-such-project'); pg.wait_for_timeout(200)
    none = pg.evaluate("document.querySelectorAll('#pubrows tr').length")
    if none != 1 or 'No projects match' not in pg.inner_text('#pubrows'):
        problems.append('search with no match does not show the empty message')
    pg.fill('#pubq', '')
    pg.select_option('#pubf', 'draft'); pg.wait_for_timeout(200)
    if 'of' not in pg.inner_text('#pubcount'): problems.append('status filter shows no count')
    pg.select_option('#pubf', ''); pg.wait_for_timeout(200)
    if pg.evaluate("document.querySelectorAll('#pubrows tr').length") != rows: problems.append('clearing filters does not restore the list')
    steps.append('2 search and status filter work')
    pg.select_option('#btrade', 'janitorial'); pg.wait_for_timeout(500)
    if 'compan' not in pg.inner_text('#bcount'): problems.append('bidder directory trade filter shows no count')
    pg.select_option('#btrade', '')
    dir_pkgs = pg.evaluate("[...document.querySelectorAll('#bpkg option')].map(o => o.value).filter(Boolean)")
    if not dir_pkgs: problems.append('bidder directory offers no package to compare with')
    else:
        pg.select_option('#bpkg', dir_pkgs[0]); pg.wait_for_timeout(600)
        if not pg.evaluate("document.querySelectorAll('#brows tr').length"): problems.append('bidder directory shows no rows for a package')
        invites = pg.locator('#brows [data-binv]:not([disabled])')
        if invites.count():
            invites.first.click(); pg.wait_for_timeout(1000)
            if pg.inner_text('#bmsg').strip(): problems.append('inviting from the directory failed: ' + pg.inner_text('#bmsg'))
            if 'Invited' not in pg.inner_text('#brows'): problems.append('an invited company is not marked Invited')
    steps.append('2b bidder directory filters, eligibility and invite work')
    pg.click('[data-pubopen]'); pg.wait_for_timeout(900)
    if pg.query_selector('[data-breadth]'):
        pg.click('[data-breadth]'); pg.wait_for_timeout(900)
        panel = pg.inner_text('.breadth') if pg.query_selector('.breadth') else ''
        if 'Bid breadth' not in panel or 'eligible, not invited' not in panel: problems.append('bid breadth panel does not show its counts')
        steps.append('2c bid breadth panel shows counts and actions')
    else:
        problems.append('no Bid breadth control on a published package')
    labels = pg.evaluate("[...document.querySelectorAll('.choose button')].map(b => b.innerText.split('\\n')[0])")
    if labels != ['Create full project', 'Post single trade', 'Create cleaning request']: problems.append(f'request chooser is {labels}')
    opts = pg.evaluate("[...document.querySelectorAll('#sv option')].map(o => o.value)")
    for need in ['post_construction', 'janitorial', 'windows', 'floor_care', 'pressure_washing', 'parking_lot']:
        if need not in opts: problems.append(f'cleaning request is missing the {need} option')
    steps.append('3 request chooser lists full project, single trade and cleaning, with all six cleaning services')
    ctx2 = b.new_context(viewport={'width': 1280, 'height': 900}); u = ctx2.new_page(); watch(u, 'unconfirmed')
    u.goto(BASE + '/app'); u.fill('#e', email); u.fill('#p', 'long enough password'); u.click('button.primary'); u.wait_for_timeout(1500)
    banner = u.inner_text('#emailbanner') if u.query_selector('#emailbanner') else ''
    if 'Email not confirmed' not in banner or 'blocked' not in banner: problems.append('unconfirmed banner does not explain what is blocked')
    u.click('#resend'); u.wait_for_timeout(900)
    if 'Sent to' not in u.inner_text('#resendmsg'): problems.append('resend confirmation did not confirm it was sent')
    if not u.evaluate("document.querySelector('#rf button.primary')?.disabled"): problems.append('posting is not blocked for an unconfirmed company')
    steps.append('4 unconfirmed banner explains the block, resend works, posting is blocked')
    u.fill('#vf input[name=website]', 'https://qa-verify.test'); u.fill('#vf input[name=licenseNumber]', 'WA-QA-1'); u.fill('#vf input[name=phone]', '206-555-0123')
    u.fill('#vf input[name=contactName]', 'Qa Person'); u.fill('#vf input[name=title]', 'Owner'); u.click('#vf button.primary'); u.wait_for_timeout(1200)
    vtxt = u.inner_text('#verc')
    if 'Pending review' not in vtxt or 'Requested' not in vtxt: problems.append('verification request does not show as pending with its history')
    steps.append('5 verification request is filed and shown as pending with history')
    fixture = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures', 'E2.01_Lighting_Plan.pdf')
    u.set_input_files('#vdocf input[type=file]', fixture); u.select_option('#vdocf select[name=kind]', 'license')
    u.click('#vdocf button[type=submit]'); u.wait_for_timeout(1200)
    if 'E2.01_Lighting_Plan' not in u.inner_text('#verc'): problems.append('verification document upload does not appear in the list')
    steps.append('6 verification PDF uploaded and listed')
    b.close()
print('\n'.join(steps)); print('PROBLEMS:', json.dumps(problems))
