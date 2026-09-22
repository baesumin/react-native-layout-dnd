"""Contact sheet of selected frames of a recording, cropped to the example list.

usage: python3 scripts/perf/video/sheet.py <recording.mp4> <frame,frame,...> <out.png>
       [--crop 1320:1470:0:790] [--scale 440:490]

Requires ffmpeg and Pillow. The default crop is the FlatList example's list
region on the iPhone 17 Pro Max recording (3x); the default scale renders it at
1x so displacements can be read in points. Frame numbers are the 0-based indices
that pops.py prints.
"""
import argparse
import os
import subprocess

from PIL import Image, ImageDraw

parser = argparse.ArgumentParser()
parser.add_argument('video')
parser.add_argument('frames')
parser.add_argument('out')
parser.add_argument('--crop', default='1320:1470:0:790')
parser.add_argument('--scale', default='440:490')
args = parser.parse_args()

frames = [int(f) for f in args.frames.split(',')]
cache = os.path.splitext(args.video)[0] + '-sheet'
os.makedirs(cache, exist_ok=True)
images = []
for frame in frames:
    path = os.path.join(cache, f'f{frame}.png')
    if not os.path.exists(path):
        subprocess.run(
            ['ffmpeg', '-v', 'error', '-y', '-i', args.video, '-vf',
             f'select=eq(n\\,{frame}),crop={args.crop},scale={args.scale}',
             '-vsync', 'passthrough', '-frames:v', '1', path],
            check=True,
        )
    images.append(Image.open(path))
width, height = images[0].size
sheet = Image.new('RGB', (width * len(images) + 10 * (len(images) - 1), height + 30), 'white')
draw = ImageDraw.Draw(sheet)
label = os.path.basename(args.video)
for index, (frame, image) in enumerate(zip(frames, images)):
    sheet.paste(image, (index * (width + 10), 30))
    draw.text((index * (width + 10) + 5, 8), f'{label} frame {frame}', fill='black')
sheet.save(args.out)
print(args.out, sheet.size)
