# Public website in the browser: homepage, every page in the navigation, the mobile menu, the sign-in
# hand-off to the workspace at /app, and a clean console (no script or CSP errors).
# Prints "PROBLEMS: []" when everything passes.
import os
from playwright.sync_api import sync_playwright
BASE = 'http://127.0.0.1:' + os.environ.get('QA_PORT', '4401')
PAGES = ['/platform', '/project-intelligence', '/marketplace', '/plan-room', '/takeoff-estimating', '/bid-management',
         '/service-contractors', '/data-trust', '/solutions', '/pricing', '/about', '/contact', '/faq']
problems = []
def watch(pg, name):
    pg.on('pageerror', lambda e: problems.append(f'{name}: page error {str(e)[:120]}'))
    pg.on('console', lambda m: problems.append(f'{name}: console {m.text[:140]}') if m.type == 'error' else None)
with sync_playwright() as p:
    b = p.chromium.launch()
    d = b.new_page(viewport={'width': 1280, 'height': 900}); watch(d, 'desktop')
    d.goto(BASE + '/'); d.wait_for_timeout(500)
    if 'Find. Bid. Win.' not in d.inner_text('h1'): problems.append('homepage: headline missing')
    for path in PAGES:
        r = d.goto(BASE + path); d.wait_for_timeout(200)
        if not r or r.status != 200: problems.append(f'{path}: status {r.status if r else None}')
        if not d.query_selector('h1'): problems.append(f'{path}: no heading')
        if not d.query_selector('.site-header .brand'): problems.append(f'{path}: header missing')
    d.goto(BASE + '/'); d.wait_for_timeout(300)
    d.click('.login-link'); d.wait_for_timeout(800)
    if not d.url.endswith('/app'): problems.append(f'sign in: went to {d.url}, not /app')
    if not d.query_selector('#e'): problems.append('sign in: workspace sign-in form missing')
    d.goto(BASE + '/'); d.click('a.btn-small'); d.wait_for_timeout(800)
    if not d.url.endswith('/get-started'): problems.append('get started: did not reach the role chooser')
    elif d.locator('.pg-card').count() != 4: problems.append('get started: role chooser does not show four roles')
    m = b.new_page(viewport={'width': 390, 'height': 844}); watch(m, 'mobile')
    m.goto(BASE + '/'); m.wait_for_timeout(300)
    if m.evaluate("document.documentElement.scrollWidth > window.innerWidth"): problems.append('mobile: horizontal scroll on homepage')
    m.click('#mobileToggle'); m.wait_for_timeout(300)
    if m.get_attribute('#mobileToggle', 'aria-expanded') != 'true': problems.append('mobile: menu did not open')
    m.click("#primaryNav a[href=\"/platform\"]"); m.wait_for_timeout(500)
    if not m.url.endswith("/platform"): problems.append("mobile: menu link did not open platform")
    b.close()
print('PROBLEMS: ' + repr(problems))
