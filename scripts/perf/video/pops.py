"""Count single-slot pops of example list cards in a simulator recording.

usage: python3 scripts/perf/video/pops.py <recording.mp4> [--x 1230] [--top 796]
       [--bottom 2253] [--min 150] [--max 450] [--keep]

Requires ffmpeg/ffprobe and Pillow. Frames are extracted once into
<recording>-frames/ as an 80 px wide vertical strip around column x (native
video pixels; the defaults are the iPhone 17 Pro Max at 3x, where the FlatList
example's vertical list spans y 793-2256 and column 1230 sits inside every
card's right padding, clear of text).

Along that column each frame is classified into the example colors: list
background, root background, button, the three card tints and the drag preview
tint (`PREVIEW_COLOR` in example/src/ListExample.tsx). Card top edges
(background -> card) and bottom edges (card -> background) are kept when the
adjacent card run is at least 40 px tall and lies clear of the clip bounds, so
slivers behind the preview do not count. Consecutive frames are matched per
edge kind and color by mutual nearest neighbour; the frame's scroll delta is the
densest cluster of displacements; an edge whose displacement differs from that
delta by min..max px (one 50-150 pt slot at 3x) is reported as a pop.

A structural pop shows up as a pair: the card leaves its animated position for
one frame and returns on the next. Same-colored cards sit three slots apart in
the example, so confusing two cards yields residuals far above max; the tinted
preview is excluded from matching. The check is column based and cannot see a
card that is fully hidden behind the preview; treat its counts as a lower
bound and confirm flagged frames with sheet.py.
"""
import argparse
import os
import subprocess
import sys

from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument('video')
parser.add_argument('--x', type=int, default=1230)
parser.add_argument('--top', type=int, default=796)
parser.add_argument('--bottom', type=int, default=2253)
parser.add_argument('--min', dest='min_px', type=int, default=150)
parser.add_argument('--max', dest='max_px', type=int, default=450)
parser.add_argument('--keep', action='store_true', help='reuse extracted frames')
args = parser.parse_args()

MARGIN = 24
MIN_RUN = 40
STRIP_LEFT = args.x - 40
COLORS = {
    'bg': (241, 245, 249),
    'root': (248, 250, 252),
    'button': (226, 232, 240),
    'blue': (219, 234, 254),
    'green': (220, 252, 231),
    'yellow': (254, 243, 199),
    'preview': (251, 207, 232),
}
CARD = ('blue', 'green', 'yellow')

frames_dir = os.path.splitext(args.video)[0] + '-frames'
pts_path = os.path.join(frames_dir, 'pts.txt')
if not (args.keep and os.path.isdir(frames_dir)):
    if os.path.isdir(frames_dir):
        for name in os.listdir(frames_dir):
            os.remove(os.path.join(frames_dir, name))
    os.makedirs(frames_dir, exist_ok=True)
    probe = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
         'frame=pts_time', '-of', 'csv=p=0', args.video],
        check=True, capture_output=True, text=True,
    )
    with open(pts_path, 'w') as handle:
        handle.write(probe.stdout.replace(',', ''))
    height = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
         'stream=height', '-of', 'csv=p=0', args.video],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    subprocess.run(
        ['ffmpeg', '-v', 'error', '-i', args.video, '-vsync', 'passthrough', '-vf',
         f'crop=80:{height}:{STRIP_LEFT}:0', os.path.join(frames_dir, '%05d.png')],
        check=True,
    )


def classify(px):
    best, dist = 'other', 10 ** 9
    for name, ref in COLORS.items():
        d = sum((a - b) ** 2 for a, b in zip(px[:3], ref))
        if d < dist:
            best, dist = name, d
    return best if dist <= 14 ** 2 * 3 else 'other'


def edges_of(path):
    im = Image.open(path).convert('RGB')
    column = [classify(im.getpixel((40, y))) for y in range(args.top, args.bottom)]
    runs = []
    start = 0
    for y in range(1, len(column) + 1):
        if y == len(column) or column[y] != column[start]:
            runs.append((column[start], start, y))
            start = y
    result = []
    for index, (name, a, b) in enumerate(runs):
        if name not in CARD or b - a < MIN_RUN:
            continue
        if index > 0 and runs[index - 1][0] == 'bg' and a >= MARGIN:
            result.append(('top', name, args.top + a))
        if index + 1 < len(runs) and runs[index + 1][0] == 'bg' and b <= len(column) - MARGIN:
            result.append(('bottom', name, args.top + b))
    return result


def nearest(kind, color, y, pool):
    options = [
        (abs(py - y), py)
        for pkind, pcolor, py in pool
        if pkind == kind and pcolor == color and abs(py - y) <= 600
    ]
    return min(options)[1] if options else None


pts = [float(line) for line in open(pts_path) if line.strip()]
files = sorted(f for f in os.listdir(frames_dir) if f.endswith('.png'))
if len(files) != len(pts):
    print(f'warning: {len(files)} frames vs {len(pts)} timestamps', file=sys.stderr)
previous = None
pops = []
hist = {}
for index, name in enumerate(files):
    edges = edges_of(os.path.join(frames_dir, name))
    t = pts[index] if index < len(pts) else float('nan')
    if previous is not None:
        prev_edges, prev_t = previous
        pairs = []
        for kind, color, y in edges:
            py = nearest(kind, color, y, prev_edges)
            if py is None or nearest(kind, color, py, edges) != y:
                continue
            pairs.append((kind, color, py, y))
        if pairs:
            displacements = sorted(y - py for _, _, py, y in pairs)
            best_count, scroll = 0, 0
            for value in displacements:
                count = sum(1 for other in displacements if abs(other - value) <= 30)
                if count > best_count:
                    best_count, scroll = count, value
            for kind, color, py, y in pairs:
                residual = (y - py) - scroll
                bucket = int(abs(residual) // 10) * 10
                hist[bucket] = hist.get(bucket, 0) + 1
                if args.min_px <= abs(residual) <= args.max_px:
                    pops.append((index, t, t - prev_t, kind, color, py, y, scroll, residual))
    previous = (edges, t)

print(f'{os.path.basename(args.video)}: {len(files)} frames')
print('|residual| histogram (px bucket: count): ' + ', '.join(f'{b}:{hist[b]}' for b in sorted(hist)))
print(f'single-slot pops: {len(pops)}')
for index, t, dt, kind, color, py, y, scroll, residual in pops:
    print(
        f'  frame {index:4d} t={t:7.3f}s dt={dt * 1000:5.1f}ms {kind:6s} {color:6s} '
        f'{py:5d} -> {y:5d} (scroll {scroll:+d}, residual {residual:+d})'
    )
