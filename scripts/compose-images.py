"""Builds docs/hero.png, docs/states.png and docs/settings.png from raw screenshots (see scripts/shoot.js).
usage: python scripts/compose-images.py <raw-dir>   (raw-<default|wide|narrow|settings>.png inside it)"""
import sys
from PIL import Image, ImageDraw, ImageFilter

raw = sys.argv[1]
def gradient(w, h, c1, c2):
    base = Image.new('RGB', (w, h), c1); top = Image.new('RGB', (w, h), c2)
    m1 = Image.linear_gradient('L').resize((w, h)); m2 = Image.linear_gradient('L').rotate(90).resize((w, h))
    return Image.composite(top, base, Image.blend(m1, m2, 0.5))
def trim(im):
    bb = im.getchannel('A').point(lambda v: 255 if v > 8 else 0).getbbox()
    return im.crop(bb) if bb else im
def load(n): return trim(Image.open(f'{raw}/raw-{n}.png').convert('RGBA'))
C1, C2 = (14, 16, 28), (52, 30, 70)

n, d, w = load('narrow'), load('default'), load('wide')
w = w.resize((int(w.width * 0.62), int(w.height * 0.62)), Image.LANCZOS)
W, H = 1800, 1000
bg = gradient(W, H, C1, C2).convert('RGBA')
glow = Image.new('RGBA', (W, H), (0, 0, 0, 0)); g = ImageDraw.Draw(glow)
g.ellipse((200, -200, 1100, 500), fill=(255, 140, 100, 38)); g.ellipse((1000, 500, 1800, 1200), fill=(60, 210, 160, 34))
bg = Image.alpha_composite(bg, glow.filter(ImageFilter.GaussianBlur(120)))
gap = 90; x = (W - (n.width + d.width + w.width + 2 * gap)) // 2
for im in (n, d, w):
    y = (H - im.height) // 2
    shadow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    sh = Image.new('RGBA', im.size, (0, 0, 0, 150)); sh.putalpha(im.getchannel('A').point(lambda v: int(v * 0.55)))
    shadow.paste(sh, (x, y + 16), sh); bg = Image.alpha_composite(bg, shadow.filter(ImageFilter.GaussianBlur(22)))
    bg.alpha_composite(im, (x, y)); x += im.width + gap
bg.convert('RGB').save('docs/hero.png', optimize=True)

def framed(im, pad, out):
    f = gradient(im.width + 2 * pad, im.height + 2 * pad, C1, C2).convert('RGBA'); f.alpha_composite(im, (pad, pad)); f.convert('RGB').save(out, optimize=True)
framed(d, 80, 'docs/states.png')
framed(load('settings'), 70, 'docs/settings.png')
print('ok')
