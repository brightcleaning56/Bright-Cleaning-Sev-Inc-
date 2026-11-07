import os
BASE = 'http://127.0.0.1:' + os.environ.get('QA_PORT', '4400')
F = lambda n: os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures', n)
OUT = lambda n: os.path.join(os.environ.get('QA_OUT', '/tmp'), n)
# Dead-control audit: on every screen, every visible button/link must do something:
# a click handler (property or listener), a form submit, a real href, or a native control role.
from playwright.sync_api import sync_playwright
import sys, json
port = sys.argv[1]; accounts = sys.argv[2].split(',')
JS = """async () => {
  const out = [];
  for (const el of document.querySelectorAll('button, a, [role=tab], [data-pick], [data-seg]')) {
    const r = el.getBoundingClientRect(); if (!r.width || !r.height || el.disabled) continue;
    if (el.closest('.leaflet-container')) continue;               // map library controls
    const label = (el.innerText || el.getAttribute('aria-label') || el.title || '').trim().slice(0, 40);
    let ok = !!el.onclick;
    if (!ok && el.tagName === 'A' && el.getAttribute('href') && !el.getAttribute('href').startsWith('#') && el.getAttribute('href') !== '') ok = true;
    if (!ok && el.tagName === 'A' && /^#(project|contractor)\\//.test(el.getAttribute('href') || '')) ok = true; // hash routes
    if (!ok && el.form && (el.type === 'submit' || el.getAttribute('type') === null) && el.tagName === 'BUTTON') ok = !!el.form.onsubmit;
    out.push({ ok, label, id: el.id, cls: el.className, tag: el.tagName, path: el.outerHTML.slice(0, 90) });
  }
  return out;
}"""
with sync_playwright() as p:
    b = p.chromium.launch(); total = 0; suspects = []
    for email in accounts:
        pg = b.new_page(viewport={'width': 1600, 'height': 1000}); cdp = pg.context.new_cdp_session(pg)
        pg.goto(f'http://127.0.0.1:{port}/'); pg.fill('#e', email); pg.fill('#p', 'demo password 123'); pg.click('button.primary'); pg.wait_for_timeout(1500)
        keys = [x.get_attribute('data-t') for x in pg.query_selector_all('nav button')] or ['buyer']
        for k in keys:
            if k != 'buyer': pg.click(f'nav button[data-t="{k}"]'); pg.wait_for_timeout(900)
            items = pg.evaluate(JS); total += len(items)
            for it in [i for i in items if not i['ok']]:
                # second chance: listeners added with addEventListener (checked through the browser's debugger API)
                h = pg.evaluate_handle(f"() => [...document.querySelectorAll('button, a, [role=tab], [data-pick], [data-seg]')].find(e => e.outerHTML.slice(0, 90) === {json.dumps(it['path'])})")
                try:
                    obj = cdp.send('Runtime.callFunctionOn', {'functionDeclaration': 'function(){return this}', 'objectId': h._impl_obj._guid if False else None}) if False else None
                    oid = cdp.send('Runtime.evaluate', {'expression': f"[...document.querySelectorAll('button, a, [role=tab], [data-pick], [data-seg]')].find(e => e.outerHTML.slice(0, 90) === {json.dumps(it['path'])})"})['result'].get('objectId')
                    ls = cdp.send('DOMDebugger.getEventListeners', {'objectId': oid})['listeners'] if oid else []
                    if any(l['type'] in ('click', 'submit') for l in ls): continue
                    # a submit button works through its form: check the form's own submit listeners too
                    foid = cdp.send('Runtime.evaluate', {'expression': f"([...document.querySelectorAll('button, a, [role=tab], [data-pick], [data-seg]')].find(e => e.outerHTML.slice(0, 90) === {json.dumps(it['path'])}) || {{}}).form || null"})['result'].get('objectId')
                    if foid and any(l['type'] == 'submit' for l in cdp.send('DOMDebugger.getEventListeners', {'objectId': foid})['listeners']): continue
                except Exception as e: pass
                suspects.append(f"{email.split('@')[0]} / {k}: <{it['tag']}> '{it['label']}' {it['path']}")
        if email.startswith('sub'):
            pg.click('nav button[data-t="projects"]'); pg.wait_for_timeout(900); pg.click('#res a >> nth=0'); pg.wait_for_timeout(1800)
            for ct in [x.get_attribute('data-ct') for x in pg.query_selector_all('[data-ct]')]:
                pg.click(f'[data-ct="{ct}"]'); pg.wait_for_timeout(500)
                items = pg.evaluate(JS); total += len(items)
                for it in [i for i in items if not i['ok']]:
                    oid = cdp.send('Runtime.evaluate', {'expression': f"[...document.querySelectorAll('button, a, [role=tab], [data-pick], [data-seg]')].find(e => e.outerHTML.slice(0, 90) === {json.dumps(it['path'])})"})['result'].get('objectId')
                    ls = cdp.send('DOMDebugger.getEventListeners', {'objectId': oid})['listeners'] if oid else []
                    foid = cdp.send('Runtime.evaluate', {'expression': f"([...document.querySelectorAll('button, a, [role=tab], [data-pick], [data-seg]')].find(e => e.outerHTML.slice(0, 90) === {json.dumps(it['path'])}) || {{}}).form || null"})['result'].get('objectId')
                    fls = cdp.send('DOMDebugger.getEventListeners', {'objectId': foid})['listeners'] if foid else []
                    if not any(l['type'] in ('click', 'submit') for l in ls) and not any(l['type'] == 'submit' for l in fls): suspects.append(f"sub / profile:{ct}: <{it['tag']}> '{it['label']}' {it['path']}")
        pg.close()
    b.close()
print(f'controls checked: {total}'); print(f'dead controls: {len(set(suspects))}'); [print(' -', s) for s in sorted(set(suspects))]
