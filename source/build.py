import pathlib, sys
src = pathlib.Path('src')
css = (src/'styles.css').read_text()
js = ''.join((src/f).read_text() + '\n' for f in ['engine.js','store.js','app.js'])
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
fb = ''.join(f'<script src="https://www.gstatic.com/firebasejs/{V}/{m}.js"></script>\n' for m in ['firebase-app-compat','firebase-auth-compat','firebase-firestore-compat'])
cfg = (pathlib.Path('firebase')/'config.js').read_text()
d = pathlib.Path('dist'); d.mkdir(exist_ok=True)
(d/'index.html').write_text(page(fb + '<script>' + cfg + '</script>'))
(d/'.nojekyll').write_text('')
print('built index.html and dist/index.html')
