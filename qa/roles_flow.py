# Role sign-up and workspace banners in the browser: the Get Started chooser, one sign-up form per role,
# the validation message, and the setup banner on the subcontractor, service provider and owner workspaces.
# Prints "PROBLEMS: [...]" (empty when everything passes).
import os
from playwright.sync_api import sync_playwright
BASE = 'http://127.0.0.1:' + os.environ.get('QA_PORT', '4401')
problems = []
def fresh(b, url, wait):
    ctx = b.new_context(viewport={'width': 1280, 'height': 900}); pg = ctx.new_page(); pg.set_default_timeout(15000)
    pg.goto(BASE + url, wait_until='commit'); pg.wait_for_selector(wait, timeout=15000)
    return ctx, pg
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx, d = fresh(b, '/get-started', '.pg-card')
    if d.locator('.pg-card').count() != 4: problems.append('get-started: expected 4 role cards')
    ctx.close()
    expect = {'gc': ('General contractor or GM', 'select#k', 0), 'owner': ('Owner, developer or property manager', 'select#k', 0),
              'sub': ('Subcontractor', '#st', 1), 'service': ('Service provider', '#st', 1)}
    for role, (title, field, boxes) in expect.items():
        ctx, d = fresh(b, '/app#signup-' + role, '#sf h1')
        if d.inner_text('#sf h1') != title: problems.append(f'signup {role}: wrong title')
        if d.locator('#sf ' + field).count() != 1: problems.append(f'signup {role}: missing {field}')
        if (d.locator('#sf input[type=checkbox]').count() > 0) != bool(boxes): problems.append(f'signup {role}: wrong choice boxes')
        ctx.close()
    ctx, d = fresh(b, '/app#signup-sub', '#sf h1')
    d.fill('#c', 'QA Co'); d.fill('#n', 'QA Person'); d.fill('#e', 'qa@example.com'); d.fill('#p', 'a very long password 1'); d.fill('#st', 'WA')
    d.click('#sf button.primary'); d.wait_for_timeout(1200)
    if 'trades' not in d.inner_text('#le'): problems.append('signup sub: no trade message shown')
    ctx.close()
    for email, want in [('trade@elec.test', 'Subcontractor workspace'), ('svc@clean.test', 'Service provider workspace'), ('pm@acme.test', 'Owner workspace')]:
        ctx, d = fresh(b, '/app', '#e')
        d.fill('#e', email); d.fill('#p', 'demo password 123'); d.click('button.primary')
        try: d.wait_for_selector('.role-banner', timeout=15000)
        except Exception: problems.append(f'{email}: no workspace banner'); ctx.close(); continue
        heads = d.locator('.role-banner h2').all_inner_texts()
        if heads != [want]: problems.append(f'{email}: banner {heads}, wanted {want}')
        if d.locator('.role-steps li').count() < 3: problems.append(f'{email}: setup steps missing')
        if email == 'trade@elec.test' and 'Invitations to Bid' not in d.inner_text('body'): problems.append('subcontractor does not land on bid invitations')
        if email == 'pm@acme.test':
            if d.locator('#sumstrip .buyer-tiles > div').count() != 6: problems.append('owner: summary tiles missing')
            if 'Your projects' not in d.inner_text('body'): problems.append('owner: projects heading missing')
            if d.locator('#bidders tr').count() - 1 < 2: problems.append('owner: contractors on your projects missing the invited companies')
            if 'Project status' not in d.inner_text('#analytics'): problems.append('owner: project status card missing')
            if d.locator('#analytics .buyer-tiles > div').count() != 4: problems.append('owner: project status tiles wrong')
        ctx.close()
    # Each subscriber role has its own menu
    menus = {}
    for email in ['trade@elec.test', 'svc@clean.test', 'sub@em.test']:
        ctx, d = fresh(b, '/app', '#e')
        d.fill('#e', email); d.fill('#p', 'demo password 123'); d.click('button.primary'); d.wait_for_timeout(2500)
        menus[email] = set(t.strip() for t in d.locator('aside.side a, aside.side button').all_inner_texts() if t.strip())
        ctx.close()
    ctx, d = fresh(b, '/app', '#e')
    d.fill('#e', 'gc@ryan.test'); d.fill('#p', 'demo password 123'); d.click('button.primary'); d.wait_for_selector('#analytics', timeout=15000); d.wait_for_timeout(1000)
    if 'Bid spread by package' not in d.inner_text('#analytics'): problems.append('GC: bid spread card missing')
    if 'Subcontractors bidding on your packages' not in d.inner_text('#bidders'): problems.append('GC: bidders heading wrong')
    ctx.close()
    sub, svc, full = menus['trade@elec.test'], menus['svc@clean.test'], menus['sub@em.test']
    if 'Market Activity' in sub or 'AI Floor Plan Analyzer' in sub: problems.append('subcontractor menu shows items outside its role')
    if 'Plan Room' in svc or 'Drawing Sets' in svc: problems.append('service provider menu shows plan room')
    if 'Rate cards' not in svc: problems.append('service provider menu lacks Rate cards')
    if 'Awards & Contracts' not in sub or 'Awards & Contracts' not in svc: problems.append('contracts missing from a role menu')
    if not (len(sub) < len(full) and len(svc) < len(full)): problems.append('role menus are not narrower than the full menu')
    b.close()
print('PROBLEMS: ' + repr(problems))
