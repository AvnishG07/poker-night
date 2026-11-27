import pathlib, sys
src = pathlib.Path('src')
css = (src/'styles.css').read_text()
import base64
logo = 'data:image/png;base64,' + base64.b64encode(pathlib.Path('assets/webapprise-logo.png').read_bytes()).decode()
js = 'window.WA_LOGO=' + repr(logo) + ';\n' + ''.join((src/f).read_text() + '\n' for f in ['engine.js','store.js','app.js'])
def page(head_extra=''):
    return f'''<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0a2f25">
<title>Poker Night</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&family=Playfair+Display:wght@700&display=swap" rel="stylesheet">
{head_extra}
<style>{css}
.top{{padding-top:calc(12px + env(safe-area-inset-top))}}</style></head>
<body><div id="app"></div>
<script>{js}</script></body></html>'''
pathlib.Path('index.html').write_text(page())
V='10.12.2'
# Load Firebase from Google; if that fails on a phone, try a second source.
fb = '''<script>
window.firebaseReady = (function () {
  var V = '%s', mods = ['firebase-app-compat', 'firebase-auth-compat', 'firebase-firestore-compat'];
  var srcs = [function (m) { return 'https://www.gstatic.com/firebasejs/' + V + '/' + m + '.js'; },
              function (m) { return 'https://cdn.jsdelivr.net/npm/firebase@' + V + '/' + m + '.js'; }];
  function load(u) { return new Promise(function (res, rej) { var s = document.createElement('script'); s.src = u; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }
  async function all(i) { for (var k = 0; k < mods.length; k++) await load(srcs[i](mods[k])); }
  return all(0).catch(function () { return all(1); }).then(function () { return true; }, function () { return false; });
})();
</script>
''' % V
cfg = (pathlib.Path('firebase')/'config.js').read_text()
d = pathlib.Path('dist'); d.mkdir(exist_ok=True)
(d/'index.html').write_text(page(fb + '<script>' + cfg + '</script>'))
(d/'.nojekyll').write_text('')
print('built index.html and dist/index.html')
