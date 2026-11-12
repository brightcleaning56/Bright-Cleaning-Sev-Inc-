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
    labels = pg.evaluate("[...document.querySelectorAll('.choose button')].map(b => b.innerText.split('\\n')[0])")
    if labels != ['Create full project', 'Post single trade', 'Create cleaning request']: problems.append(f'request chooser is {labels}')
    steps.append('3 request chooser lists full project, single trade and cleaning')
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
    b.close()
print('\n'.join(steps)); print('PROBLEMS:', json.dumps(problems))
