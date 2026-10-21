"""Start-paused and auto-fullscreen timing test on a mock watch page.

The mock page autoplays the video ~80 ms after load while GM.getValue is slowed
down (25 ms per call), which is how the old script missed the first play. Its
fullscreen button fullscreens the whole document (like YouTube's ytd-app) and
the mock "YouTube" only attaches its fullscreenchange layout handler late, so
the whole page goes fullscreen first and must be repaired.

Negative controls: v1.3.0 (play listener after the awaits) left the video
playing (1.44 s after 1.5 s); v1.3.1 judged a fullscreen requested 1.5 s
after the click as 'not granted' and never repaired the layout.

usage: python3 tests/play_fullscreen_test.py
"""
import asyncio, sys, threading, http.server, functools, json
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent
SCRIPT = (ROOT.parent / 'YouTube_Channel_Memory.user.js').read_text(encoding='utf-8')
PAGE = """<!doctype html><html><head><meta charset=utf-8></head><body style="margin:0;background:#000">
<ytd-app><ytd-watch-flexy video-id="PENDING">
 <div id="movie_player" class="html5-video-player" style="width:640px;height:360px">
  <video src="/fixtures/clip.webm" style="width:100%;height:100%"></video>
  <div class="ytp-right-controls"><button class="ytp-fullscreen-button">FS</button></div>
 </div>
 <div id="secondary" style="height:900px;color:#fff">playlist</div>
</ytd-watch-flexy></ytd-app>
<script>
const flexy = document.querySelector('ytd-watch-flexy'), v = document.querySelector('video');
const Q = new URLSearchParams(location.search), LATE = +(Q.get('late') || 0), FSDELAY = +(Q.get('fsdelay') || 0);
window.__rejections = [];
const ytPlay = () => v.play().catch(e => window.__rejections.push(e.name));   // YouTube records why play() failed
// YouTube's button may request fullscreen a while after the click
document.querySelector('.ytp-fullscreen-button').onclick = () => setTimeout(() => document.documentElement.requestFullscreen().catch(()=>{}), FSDELAY);
setTimeout(() => { v.muted = true; ytPlay(); }, 80);          // autoplay
setTimeout(ytPlay, 900);                                      // YouTube's later play()
window.__ytPlay = ytPlay;
setTimeout(() => flexy.setAttribute('video-id', 'abc'), LATE ? LATE : 0);     // page data arrives
const layout = () => flexy.toggleAttribute('fullscreen', !!document.fullscreenElement);
setTimeout(() => document.addEventListener('fullscreenchange', layout), LATE); // handler attached late
</script></body></html>"""

class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path.startswith('/watch'):
            b = PAGE.encode(); self.send_response(200); self.send_header('Content-Type', 'text/html'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
        else: super().do_GET()

def shim(store):
    return """(() => { const S = %s; window.__logs = [];
 const ol = console.log; console.log = (...a) => { window.__logs.push(a.join(' ')); ol(...a); };
 window.GM_getValue = (k, d) => (k in S ? S[k] : d);
 window.GM = { getValue: (k, d) => new Promise(r => setTimeout(() => r(k in S ? S[k] : d), 25)), setValue: async () => {}, deleteValue: async () => {} };
 window.GM_registerMenuCommand = () => {};
 const run = () => { try { new Function(%s)(); } catch (e) { console.log('SCRIPT ERROR ' + e); } };
 if (document.documentElement) run(); else new MutationObserver((m, o) => { if (document.documentElement) { o.disconnect(); run(); } }).observe(document, { childList: true });
})();""" % (json.dumps(store), json.dumps(SCRIPT))

fails = []
def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('  ' + str(detail) if detail != '' else ''))
    if not ok: fails.append(name)

async def run(b, port, store, late=0, click=False, wait=3000, fsdelay=0):
    ctx = await b.new_context(viewport={'width': 1280, 'height': 720})
    await ctx.add_init_script(shim(store))
    pg = await ctx.new_page()
    await pg.goto(f'http://127.0.0.1:{port}/watch?v=abc&late={late}&fsdelay={fsdelay}')
    await pg.wait_for_timeout(1500)
    if click:
        await pg.mouse.click(300, 150)                      # real user input
        await pg.evaluate("window.__ytPlay()")
    await pg.wait_for_timeout(wait)
    r = await pg.evaluate("""() => ({ paused: document.querySelector('video').paused, t: document.querySelector('video').currentTime,
        fs: document.fullscreenElement ? document.fullscreenElement.tagName : null, layout: document.querySelector('ytd-watch-flexy').hasAttribute('fullscreen'),
        rej: window.__rejections, logs: window.__logs.filter(l => l.startsWith('YSC fs') || l.startsWith('SCRIPT')) })""")
    await ctx.close()
    return r

async def main():
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(H, directory=str(ROOT)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
        r = await run(b, port, {'_YSC-START_PAUSED': True})
        blocks = [l for l in r['logs'] if 'blocked play() at the source' in l]
        leaked = [l for l in r['logs'] if 'reached the browser' in l]
        check('start paused: every autoplay play() blocked at the source, nothing leaked', len(blocks) == 2 and not leaked and r['paused'] and r['t'] == 0, (r['t'], blocks, leaked))
        check('start paused: page sees NotAllowedError (same as browser autoplay block)', r['rej'] == ['NotAllowedError', 'NotAllowedError'], r['rej'])
        check('start paused: hold listener and hook ready before settings loaded', 'listener attached (start paused = true)' in r['logs'][0] and 'hook installed' in r['logs'][1], r['logs'][:3])
        r = await run(b, port, {'_YSC-START_PAUSED': False})
        check('start paused off: video keeps playing', not r['paused'], r['t'])
        r = await run(b, port, {'_YSC-START_PAUSED': True, '_YSC-FULLSCREEN_ON_START': True}, late=0, click=True)
        check('fullscreen, page ready: video fullscreen OK at once', r['fs'] and r['layout'] and any('video fullscreen OK' in l for l in r['logs']), [l for l in r['logs'] if 'auto' in l])
        check('user press plays normally (hold released)', not r['paused'] and r['t'] > 0.5, r['t'])
        r = await run(b, port, {'_YSC-START_PAUSED': True, '_YSC-FULLSCREEN_ON_START': True}, late=5000, click=True, wait=8000, fsdelay=1500)
        al = [l for l in r['logs'] if 'auto' in l]
        check('fullscreen requested 1.5 s after click (like YouTube): watched, entered, layout repaired', r['fs'] and r['layout'] and any('entered' in l for l in al) and any('layout switched' in l for l in al) and not any('not granted' in l for l in al), al)
        r = await run(b, port, {'_YSC-START_PAUSED': True, '_YSC-FULLSCREEN_ON_START': True}, late=4000, click=True, wait=6000)
        al = [l for l in r['logs'] if 'auto' in l]
        check('fullscreen, YouTube late: whole page first, then layout repaired, still fullscreen', r['fs'] and r['layout'] and any('whole page' in l for l in al) and any('layout switched' in l for l in al), al)
        r = await run(b, port, {'_YSC-START_PAUSED': True, '_YSC-FULLSCREEN_ON_START': True}, late=60000, click=True, wait=12000)
        al = [l for l in r['logs'] if 'auto' in l]
        check('fullscreen, never repaired: stays fullscreen and shows hint (no auto exit)', r['fs'] and any('showing hint' in l for l in al), al)
        check('no script errors', not any(l.startswith('SCRIPT') for l in r['logs']))
        await b.close()
    srv.shutdown()
    print('RESULT', 'ALL PASS' if not fails else f'{len(fails)} FAIL'); sys.exit(1 if fails else 0)
asyncio.run(main())
