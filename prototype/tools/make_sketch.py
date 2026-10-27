# Generates samples/hand-sketch.png: a two-story, two-bay frame drawn like a pencil
# sketch on a phone photo (wobbly strokes, overshoots, a gap, uneven light, noise).
import math, random, sys
from PIL import Image, ImageDraw, ImageFilter

random.seed(7)
W, H = 1600, 1200
img = Image.new("L", (W, H), 255)
px = img.load()
for y in range(H):              # uneven lighting, darker toward one corner
    for x in range(0, W):
        px[x, y] = int(235 - 40 * (x / W) * (y / H) + random.uniform(-8, 8))
d = ImageDraw.Draw(img)

def stroke(x1, y1, x2, y2, over=12, gap=None):
    L = math.hypot(x2 - x1, y2 - y1); ux, uy = (x2 - x1) / L, (y2 - y1) / L
    x1, y1 = x1 - ux * random.uniform(0, over), y1 - uy * random.uniform(0, over)
    x2, y2 = x2 + ux * random.uniform(0, over), y2 + uy * random.uniform(0, over)
    L = math.hypot(x2 - x1, y2 - y1); n = int(L / 6)
    wob, phase = random.uniform(1.5, 3.5), random.uniform(0, 6.28)
    pts = []
    for i in range(n + 1):
        t = i / n
        off = wob * math.sin(phase + t * 7) + random.uniform(-0.6, 0.6)
        pts.append((x1 + (x2 - x1) * t - uy * off, y1 + (y2 - y1) * t + ux * off, t))
    for (ax, ay, ta), (bx, by, tb) in zip(pts, pts[1:]):
        if gap and gap[0] < ta < gap[1]:
            continue
        d.line([(ax, ay), (bx, by)], fill=random.randint(40, 80), width=random.choice([4, 5, 6]))

xs, ys = [250, 750, 1300], [1000, 650, 330]
for x in xs: stroke(x, ys[0], x + random.uniform(-6, 6), ys[2])          # columns
for y in ys[1:]: stroke(xs[0], y, xs[2], y + random.uniform(-8, 8),
                        gap=(0.62, 0.66) if y == ys[1] else None)          # beams, one with a gap
stroke(xs[0], ys[1], xs[1], ys[2])                                        # brace
d.line([(170, 1040), (1380, 1040)], fill=120, width=2)                    # ground line, light
d.text((1000, 1080), "2 bays @ 25'", fill=60)
img = img.filter(ImageFilter.GaussianBlur(1.2))
img.convert("RGB").save(sys.argv[1], quality=85)
print("saved", sys.argv[1])
