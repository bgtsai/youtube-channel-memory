"""Regression test for the settings panel layout, fullscreen chat hiding and the
colour-picker drag handle. Runs the userscript inside a SingleFile snapshot of a
live-stream watch page (fullscreen, squeezeback layout).

usage: python3 tests/panel_layout_test.py <snapshot.html> <out_dir>
"""
import asyncio, json, sys, re
from pathlib import Path
from playwright.async_api import async_playwright

SNAP, OUT = Path(sys.argv[1]), Path(sys.argv[2])
SCRIPT = (Path(__file__).resolve().parent.parent / 'YouTube_Channel_Memory.user.js').read_text(encoding='utf-8')
SHIM = "window.__menu={};window.GM={setValue:async()=>{},getValue:async(k,d)=>d,deleteValue:async()=>{}};window.GM_registerMenuCommand=(l,h)=>{window.__menu[l]=h};"
fails = []
def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (('  ' + str(detail)) if detail else ''))
    if not ok: fails.append(name)

MEASURE = """() => {
 const P = document.querySelector('#ysc-settings-panel'), q = s => P.querySelector(s);
 const fs = s => { const c = getComputedStyle(q(s)); return [parseFloat(c.fontSize), +c.fontWeight]; };
 const tg = [...P.querySelectorAll('.ysc-toggle')].map(t => { const r = t.getBoundingClientRect(), a = getComputedStyle(t, '::after'), b = parseFloat(getComputedStyle(t).borderTopWidth);
   const top = parseFloat(a.top), h = parseFloat(a.height); return { w: r.width, h: r.height, gapTop: top, gapBottom: r.height - 2*b - top - h }; });
 const leftCol = P.querySelector('.ysc-col');
 const ctl = [...leftCol.querySelectorAll('.ysc-stepper, .ysc-color-row, .ysc-edit-btn')].map(e => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.width)]; });
 const rows = [...P.querySelectorAll('.ysc-row')].map(r => Math.round(r.getBoundingClientRect().height));
 const lbls = [...P.querySelectorAll('.ysc-lbl')].map(l => { const t = l.firstChild.textContent, r = l.getBoundingClientRect(); const lh = parseFloat(getComputedStyle(l).lineHeight); const sm = l.querySelector('small'); const nameH = r.height - (sm ? sm.getBoundingClientRect().height + 4 : 0); return [t, Math.round(nameH / lh), sm ? Math.round(sm.getBoundingClientRect().height / parseFloat(getComputedStyle(sm).lineHeight)) : 1]; });
 const cr = [...P.querySelectorAll('.ysc-color-row')].map(e => e.scrollWidth <= e.clientWidth);
 return { title: fs('.ysc-title'), group: fs('.ysc-group'), lbl: fs('.ysc-lbl'), small: fs('.ysc-lbl small'), tg, ctl, rows, lbls,
          hex: [...P.querySelectorAll('.ysc-color-text')].map(e => e.textContent), noteInCard: !!q('.ysc-card #ysc-fs-note'), cr };
}"""

async def open_panel(b, dark=True, lang=None):
    pg = await b.new_page(viewport={'width': 1920, 'height': 1080})
    await pg.route('**/*', lambda r: r.continue_() if r.request.url.startswith('file:') else r.abort())
    await pg.goto(SNAP.as_uri())
    if not dark:
        await pg.evaluate("document.documentElement.removeAttribute('dark')")
    await pg.evaluate(SHIM)
    if lang:
        await pg.evaluate("l => { window.GM.getValue = async (k, d) => k === '_YSC-UI_LANG' ? l : d; }", lang)
    await pg.add_script_tag(content=SCRIPT); await pg.wait_for_timeout(1200)
    await pg.evaluate("window.__menu[Object.keys(window.__menu).find(k => k !== 'null')]()"); await pg.wait_for_timeout(800)
    return pg

async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await open_panel(b)
        m = await pg.evaluate(MEASURE)
        check('type scale L4/L3/L2/L1 = 22/20/18/16', [m['title'][0], m['group'][0], m['lbl'][0], m['small'][0]] == [22, 20, 18, 16], (m['title'], m['group'], m['lbl'], m['small']))
        check('weights 700/700/500/400', [m['title'][1], m['group'][1], m['lbl'][1], m['small'][1]] == [700, 700, 500, 400])
        check('toggles 40x24, knob gap 2px top and bottom', all(t['w'] == 40 and t['h'] == 24 and abs(t['gapTop'] - 2) < .01 and abs(t['gapBottom'] - 2) < .01 for t in m['tg']), m['tg'][0])
        check('left column controls share left edge and 120px width', len({c[0] for c in m['ctl']}) == 1 and all(c[1] == 120 for c in m['ctl']), m['ctl'])
        check('rows share one height (64) unless a description wraps', set(m['rows']) == {64}, sorted(set(m['rows'])))
        check('no item name or description wraps', all(n == 1 and d == 1 for _, n, d in m['lbls']), [l for l in m['lbls'] if l[1] != 1 or l[2] != 1])
        check('colour text fits inside its 120px box', all(m['cr']), m['cr'])
        check('colour rows show #HEX', all(re.fullmatch(r'#[0-9A-F]{6}', h) for h in m['hex']), m['hex'])
        check('automation note sits inside its card', m['noteInCard'])
        await (await pg.query_selector('#ysc-settings-panel')).screenshot(path=str(OUT / 'panel_dark.png'))
        # colour picker drag
        await pg.click('#ysc-color-sel-row'); await pg.wait_for_timeout(400)
        h = await pg.query_selector('#ysc-cp .cp-drag'); hb = await h.bounding_box()
        before = await (await pg.query_selector('#ysc-cp')).bounding_box()
        await pg.mouse.move(hb['x'] + 20, hb['y'] + 7); await pg.mouse.down(); await pg.mouse.move(hb['x'] + 220, hb['y'] + 107, steps=8); await pg.mouse.up()
        after = await (await pg.query_selector('#ysc-cp')).bounding_box()
        check('colour picker moves with its handle (+200, +100)', round(after['x'] - before['x']) == 200 and round(after['y'] - before['y']) == 100, (after['x'] - before['x'], after['y'] - before['y']))
        await pg.screenshot(path=str(OUT / 'picker_dragged.png'))
        await pg.close()
        # English UI: same layout rules must hold
        pg = await open_panel(b, lang='en')
        m = await pg.evaluate(MEASURE)
        check('EN: no item name or description wraps', all(n == 1 and d == 1 for _, n, d in m['lbls']), [l for l in m['lbls'] if l[1] != 1 or l[2] != 1])
        check('EN: rows share one height (64)', set(m['rows']) == {64}, sorted(set(m['rows'])))
        await (await pg.query_selector('#ysc-settings-panel')).screenshot(path=str(OUT / 'panel_en.png'))
        await pg.close()
        # light theme
        pg = await open_panel(b, dark=False)
        await (await pg.query_selector('#ysc-settings-panel')).screenshot(path=str(OUT / 'panel_light.png'))
        await pg.close()
        # fullscreen chat: snapshot has squeezeback + ycm-hide-chat
        pg = await b.new_page(viewport={'width': 1920, 'height': 1080})
        await pg.route('**/*', lambda r: r.continue_() if r.request.url.startswith('file:') else r.abort())
        await pg.goto(SNAP.as_uri()); await pg.evaluate(SHIM)
        await pg.evaluate("window.GM.getValue = async (k, d) => k === '_YSC-HIDE_LIVE_CHAT' ? true : d"); await pg.add_script_tag(content=SCRIPT); await pg.wait_for_timeout(800)
        r = await pg.evaluate("() => ({ panels: document.querySelector('#panels-full-bleed-container').getBoundingClientRect().width, player: document.querySelector('#player-full-bleed-container').getBoundingClientRect().width })")
        check('fullscreen: chat column gone, player full width', r['panels'] == 0 and r['player'] == 1920, r)
        await pg.evaluate("document.querySelector('ytd-engagement-panel-section-list-renderer').setAttribute('visibility','ENGAGEMENT_PANEL_VISIBILITY_EXPANDED')")
        r2 = await pg.evaluate("() => document.querySelector('#panels-full-bleed-container').getBoundingClientRect().width")
        check('fullscreen: an expanded description/comments panel still shows', r2 > 0, r2)
        await b.close()
    print('RESULT', 'ALL PASS' if not fails else f'{len(fails)} FAIL')
    sys.exit(1 if fails else 0)
asyncio.run(main())
