#!/usr/bin/env python3
"""
IS THE OG SHARE CARD'S IMPRINT REALLY LORA AT 0.22em?

The all-Lora migration changed `app/api/og/route.tsx` from "Lora wordmark + Open
Sans caps" to all-Lora, and deleted OpenSans-Bold.ttf. The source says
`letterSpacing: '0.22em'` at 23px. A source read is not proof: this image is
rasterised by SATORI, not by the browser, so it follows none of the app's CSS and
its own font loading can silently fall back.

METHOD — measured off the rendered PNG, no trust in the source:
  1. render a real card through the running server
  2. isolate the imprint row's ink columns and group them into glyph runs
  3. compute the SAME string's natural width from the actual Lora-Bold.ttf the
     route loads, using that font file directly
  4. tracking = (rendered ink span - natural width) / gaps

★ TWO TRAPS THIS SCRIPT EXISTS TO AVOID, both hit on the first attempt.
  (a) CSS COLLAPSES CONSECUTIVE WHITESPACE. The imprint is built with DOUBLE
      spaces ("·  MOVIEREVIEWS  ·  @HANSHOTFIRST"). Measuring against the string
      as written gives 0.174em and reads as a defect; measuring against what
      actually renders gives 0.219em. The collapse is confirmed independently
      below: the number of visible glyph runs must equal the number of non-space
      characters in the COLLAPSED string.
  (b) A FONT FALLBACK WOULD NOT SHOW UP AS AN ERROR. It is caught here by the
      natural width: widths computed from Lora-Bold.ttf only match the rendered
      ink if Lora is what was actually rasterised.

RUN:  python3 qa-og-imprint.py            (server must be up on :3000)
"""
import subprocess, sys, urllib.parse
from PIL import Image, ImageFont

BASE   = "http://localhost:3000"
FONT   = "apps/blog/public/fonts/Lora-Bold.ttf"
OUT    = "/mnt/o/LUMEN-DOCS/lora-spec/og/og-card.png"
SIZE   = 23
TARGET = 0.22

AUTHOR, COMMUNITY = "hanshotfirst", "moviereviews"
TITLE = "A geeky guy's guide to Shoresy"

def render():
    q = urllib.parse.urlencode({"title": TITLE, "author": AUTHOR, "community": COMMUNITY})
    r = subprocess.run(["curl", "-s", f"{BASE}/api/og?{q}", "--max-time", "90", "-o", OUT,
                        "-w", "%{http_code} %{content_type} %{size_download}"],
                       capture_output=True, text=True)
    return r.stdout.strip()

def glyph_runs(px, W, band, gap=3):
    cols = [x for x in range(W) if any(px[x, y] < 128 for y in band)]
    if not cols: return []
    runs, start, prev = [], cols[0], cols[0]
    for x in cols[1:]:
        if x - prev > gap:
            runs.append((start, prev)); start = x
        prev = x
    runs.append((start, prev))
    return runs

fails = []
def check(name, ok, detail=""):
    global fails
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""))
    if not ok: fails.append(name)

print(render())
im = Image.open(OUT)
check("the card renders at 1200x630", im.size == (1200, 630), f"{im.size[0]}x{im.size[1]}")

g = im.convert("L"); W, _ = g.size; px = g.load()
runs = glyph_runs(px, W, range(96, 126))
check("the imprint row has ink", len(runs) > 3, f"{len(runs)} runs")

gaps  = [runs[i+1][0] - runs[i][1] for i in range(len(runs)-1)]
split = gaps.index(max(gaps))
imp   = runs[split+1:]
rendered = imp[-1][1] - imp[0][0] + 1

raw       = f"·  {COMMUNITY.upper()}  ·  @{AUTHOR.upper()}"
collapsed = " ".join(raw.split())
nonspace  = [c for c in collapsed if c != " "]

check("whitespace collapsed as CSS requires", len(imp) == len(nonspace),
      f"{len(imp)} glyph runs vs {len(nonspace)} non-space chars in the collapsed string")

f       = ImageFont.truetype(FONT, SIZE)
bb      = f.getbbox(collapsed)
natural = bb[2] - bb[0]
per     = (rendered - natural) / (len(collapsed) - 1)
em      = per / SIZE

print(f"\n  natural width from {FONT} @ {SIZE}px .. {natural}px")
print(f"  rendered ink span ......................... {rendered}px")
print(f"  measured tracking ......................... {per:.2f}px/char = {em:.3f}em")
print(f"  target .................................... {TARGET}em = {TARGET*SIZE:.2f}px\n")

check(f"the imprint tracks at {TARGET}em", abs(em - TARGET) < 0.01, f"measured {em:.3f}em")
check("and it is really Lora (a fallback would not match this width)",
      abs(rendered - (natural + per*(len(collapsed)-1))) < 2, "widths agree to under 2px")

print(f"\n{'ALL PASS' if not fails else str(len(fails)) + ' FAILED'}")
sys.exit(1 if fails else 0)
