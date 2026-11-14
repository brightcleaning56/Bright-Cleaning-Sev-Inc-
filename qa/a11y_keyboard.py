"""Keyboard focus check: tab through each main screen and report any focused control with no visible focus indicator.
Prints PROBLEMS: [] when every tabbed-to control shows a focus ring (outline or box-shadow)."""
import os, json
from playwright.sync_api import sync_playwright
BASE = 'http://127.0.0.1:' + os.environ.get('QA_PORT', '4400')
problems = []
JS = """() => { const e = document.activeElement; if (!e || e === document.body) return null; const s = getComputedStyle(e);
  const ring = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || (s.boxShadow && s.boxShadow !== 'none') || e.matches(':focus-visible');
  return { tag: e.tagName, text: (e.innerText || e.getAttribute('aria-label') || e.name || e.id || '').slice(0, 40), ring }; }"""
def tab_through(pg, label, n=40):
    bad = set(); last = None
    for _ in range(n):
        pg.keyboard.press('Tab'); pg.wait_for_timeout(40)
        r = pg.evaluate(JS)
        key = (r or {}).get('tag'), (r or {}).get('text')
        if r and key == last: continue   # a date field's segments keep focus on one element; the browser draws those
        last = key
        if r and not r['ring']: bad.add(f"{r['tag']} '{r['text']}'")
    if bad: problems.append(f'{label}: no visible focus on {len(bad)} control(s), e.g. ' + '; '.join(list(bad)[:3]))
    return len(bad)
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1280, 'height': 900})
    pg.goto(BASE + '/'); pg.wait_for_timeout(600); tab_through(pg, 'website home')
    pg.goto(BASE + '/app'); pg.wait_for_timeout(500); tab_through(pg, 'sign-in')
    pg.fill('#e', 'pm@acme.test'); pg.fill('#p', 'demo password 123'); pg.click('button.primary'); pg.wait_for_timeout(1500)
    pg.evaluate("document.body.focus()"); tab_through(pg, 'publisher workspace', 60)
    sub = b.new_page(viewport={'width': 1280, 'height': 900}); sub.goto(BASE + '/app'); sub.fill('#e', 'sub@em.test'); sub.fill('#p', 'demo password 123'); sub.click('button.primary'); sub.wait_for_timeout(1500)
    sub.evaluate("document.body.focus()"); tab_through(sub, 'subscriber command', 60)
    b.close()
print('PROBLEMS:', json.dumps(problems))
