"""Speed buttons follow the video's actual speed (temporary speed button).

Runs the userscript on a SingleFile snapshot of a watch page served at /watch,
with the snapshot's old bar removed so the script builds its own.

usage: python3 tests/speed_sync_test.py <snapshot.html> <out_dir>
"""
import asyncio, sys, threading, http.server, functools, json
from pathlib import Path
from playwright.async_api import async_playwright

SNAP, OUT = Path(sys.argv[1]).resolve(), Path(sys.argv[2])
SCRIPT = (Path(__file__).resolve().parent.parent / 'YouTube_Channel_Memory.user.js').read_text(encoding='utf-8')
TEMPLATES = [["50%", 0.5], ["Normal", 1], ["1.25x", 1.25], ["1.5x", 1.5], ["2x", 2]]
fails = []
def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('  ' + str(detail) if detail != '' else ''))
    if not ok: fails.append(name)

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        b = SNAP.read_bytes(); self.send_response(200); self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)

SHIM = """(() => { const S = %s; window.__menu = {};
 window.GM_getValue = (k, d) => (k in S ? S[k] : d);
 window.GM = { getValue: async (k, d) => (k in S ? S[k] : d), setValue: async () => {}, deleteValue: async () => {} };
 window.GM_registerMenuCommand = (l, h) => { window.__menu[l] = h; }; })();""" % json.dumps({'_YSC-BUTTON_TEMPLATES': json.dumps(TEMPLATES[::-1])})  # stored unsorted on purpose

STATE = """() => { const b = document.querySelector('[id^=ycm-bar]'), v = document.querySelector('video[ycm-video]');
  return { rate: v && v.playbackRate, target: v && v.dataset.ycmTargetSpeed,
    btns: b ? [...b.querySelectorAll('span[ycm-speed]')].map(s => s.textContent + (s.hasAttribute('ycm-temp') ? '(T)' : '') + (s.hasAttribute('ycm-sel') ? '*' : '')) : null,
    reds: b ? [...b.querySelectorAll('span[ycm-speed]')].filter(s => s.style.color === getComputedStyle(b).getPropertyValue('--x') || s.hasAttribute('ycm-sel')).length : 0 }; }"""

async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={'width': 1600, 'height': 900})
        await pg.route('**/*', lambda r: r.continue_() if r.request.url.startswith(f'http://127.0.0.1:{port}/') else r.abort())
        await pg.goto(f'http://127.0.0.1:{port}/watch?v=UpoFpL1q3WM')
        await pg.evaluate("document.querySelectorAll('[id^=ycm-bar]').forEach(e => e.remove());"
                          "for (const a of ['ycm-video','ycm-player','ycm-channel','ycm-audio']) document.querySelectorAll('[' + a + ']').forEach(e => e.removeAttribute(a))")
        await pg.evaluate(SHIM); await pg.add_script_tag(content=SCRIPT)
        await pg.wait_for_timeout(500)
        await pg.evaluate("document.dispatchEvent(new Event('yt-navigate-finish'))")
        await pg.wait_for_timeout(2500)
        s = await pg.evaluate(STATE)
        check('bar built, buttons in ascending order although stored descending', s['btns'] and [x.rstrip('*') for x in s['btns']] == ['50%', 'Normal', '1.25x', '1.5x', '2x'], s['btns'])
        check('1x selected at start', s['btns'] == ['50%', 'Normal*', '1.25x', '1.5x', '2x'], s['btns'])
        bar = await pg.query_selector('[id^=ycm-bar]')
        await pg.evaluate("document.querySelector('#movie_player').classList.remove('ytp-autohide')")   # keep controls visible for screenshots

        async def user_rate(r):          # like YouTube's speed menu / Shift+> : real input, then rate change
            await pg.mouse.click(5, 880); await pg.evaluate(f"document.querySelector('video[ycm-video]').playbackRate = {r}")
            await pg.wait_for_timeout(150); return await pg.evaluate(STATE)

        s = await user_rate(1.5)
        check('user sets 1.5 (in list): that button selected, no temporary', s['btns'] == ['50%', 'Normal', '1.25x', '1.5x*', '2x'] and s['target'] == '1.5', s)
        s = await user_rate(1.15)
        check('user sets 1.15: one temporary button between Normal and 1.25x', s['btns'] == ['50%', 'Normal', '1.15x(T)*', '1.25x', '1.5x', '2x'] and s['target'] == '1.15', s['btns'])
        await bar.screenshot(path=str(OUT / 'bar_1.15.png'))
        s = await user_rate(1.75)
        check('user sets 1.75: old temporary removed, new one between 1.5x and 2x', s['btns'] == ['50%', 'Normal', '1.25x', '1.5x', '1.75x(T)*', '2x'], s['btns'])
        await bar.screenshot(path=str(OUT / 'bar_1.75.png'))
        s = await user_rate(2.5)
        check('user sets 2.5: temporary at the end', s['btns'] == ['50%', 'Normal', '1.25x', '1.5x', '2x', '2.5x(T)*'], s['btns'])
        s = await user_rate(0.25)
        check('user sets 0.25: temporary at the start', s['btns'] == ['0.25x(T)*', '50%', 'Normal', '1.25x', '1.5x', '2x'], s['btns'])
        s = await user_rate(2)
        check('back to a listed speed: temporary gone, never duplicates a user button', s['btns'] == ['50%', 'Normal', '1.25x', '1.5x', '2x*'], s['btns'])
        # YouTube resets the speed without user input: target kept (guardian/re-apply restore it)
        await pg.wait_for_timeout(1700)
        await pg.evaluate("document.querySelector('video[ycm-video]').playbackRate = 1"); await pg.wait_for_timeout(1200)
        s = await pg.evaluate(STATE)
        check('reset without user input (within the guardian window): target stays 2, guardian restores it, display follows', s['rate'] == 2 and s['target'] == '2' and s['btns'] == ['50%', 'Normal', '1.25x', '1.5x', '2x*'], s)
        # clicking the temporary button works like any button
        await user_rate(1.15)
        await pg.click('span[ycm-temp]'); await pg.wait_for_timeout(150)
        s = await pg.evaluate(STATE)
        check('temporary button is clickable and keeps the speed', s['rate'] == 1.15 and s['btns'].count('1.15x(T)*') == 1, s)
        # fullscreen big mode (1.5x controls): same order, temporary button scales with the others
        await pg.evaluate("document.querySelector('#movie_player').classList.add('ytp-big-mode')"); await pg.wait_for_timeout(150)
        await bar.screenshot(path=str(OUT / 'bar_1.15_bigmode.png'))
        await pg.evaluate("document.querySelector('#movie_player').classList.remove('ytp-big-mode')")
        # editor: duplicate speeds are refused; on save the list is sorted by speed
        await pg.evaluate("window.__menu[Object.keys(window.__menu).find(k => k !== 'null')]()"); await pg.wait_for_timeout(800)
        await pg.click('#ysc-edit-btns'); await pg.wait_for_timeout(400)
        await pg.evaluate("[...document.querySelectorAll('#ysc-bt-list .bt-inp-speed')][0].value = '1.5'")   # first row (2x) -> 1.5 = duplicate
        await pg.click('#ysc-bt-save'); await pg.wait_for_timeout(200)
        dup = await pg.evaluate("(() => { const e = document.getElementById('ysc-bt-dup'); return e && getComputedStyle(e).display !== 'none' ? e.textContent : null; })()")
        check('editor refuses two buttons with the same speed', bool(dup) and bool(await pg.query_selector('#ysc-bt-overlay')), dup)
        await (await pg.query_selector('#ysc-bt-editor')).screenshot(path=str(OUT / 'editor_dup.png'))
        await pg.evaluate("[...document.querySelectorAll('#ysc-bt-list .bt-inp-speed')][0].value = '3'")
        await pg.click('#ysc-bt-save'); await pg.wait_for_timeout(300)
        await pg.click('.ysc-btn-save'); await pg.wait_for_timeout(800)
        s = await pg.evaluate(STATE)
        check('after editing (row order 3,1.5,1.25,1,0.5) the bar is sorted by speed', s['btns'] and [x.split('(')[0].rstrip('*') for x in s['btns'] if '(T)' not in x] == ['50%', 'Normal', '1.25x', '1.5x', '2x'], s['btns'])
        await b.close()
    srv.shutdown()
    print('RESULT', 'ALL PASS' if not fails else f'{len(fails)} FAIL'); sys.exit(1 if fails else 0)
asyncio.run(main())
