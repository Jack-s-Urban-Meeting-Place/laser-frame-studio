"""
ilda_inspect.py - prints a summary of one or more ILDA (.ild) files.

Use it to check files the app exports, or to compare against known-good files.
Needs only Python 3, no extra packages.

    python tools/ilda_inspect.py "path/to/animation.ild" [more files...]

For each file it reports:
  fmts         ILDA format codes found (5 = 2D true colour, what this app writes)
  frames       number of frames
  pts/frame    min / median / max points per frame
  blank%       share of points with the beam off
  litStep      typical distance between lit points (ILDA units, range is 65536 wide)
  blankStep    typical distance between beam-off points during a jump
  holdRun      typical number of repeated points at corners / jump ends
  span         width and height of the first frame's drawing
"""
import math
import os
import statistics
import struct
import sys

# Bytes per point for each ILDA format code (format 2 is a colour palette, not points).
POINT_SIZES = {0: 8, 1: 6, 2: 3, 4: 10, 5: 8}
# Offset of the status byte (blank / last-point flags) inside each point record.
STATUS_OFFSET = {0: 6, 1: 4, 4: 6, 5: 4}


def read_frames(path):
    data = open(path, 'rb').read()
    offset, formats, frames = 0, set(), []
    while offset + 32 <= len(data):
        magic, fmt, _name, _company, count, _num, _total, _proj = struct.unpack(
            '>4s3xB8s8sHHHBx', data[offset:offset + 32])
        if magic != b'ILDA':
            raise ValueError(f'not an ILDA header at byte {offset}')
        offset += 32
        formats.add(fmt)
        if count == 0:                      # end-of-file header
            break
        size = POINT_SIZES[fmt]
        body = data[offset:offset + count * size]
        offset += count * size
        if fmt == 2:
            continue
        points = []
        for i in range(count):
            record = body[i * size:(i + 1) * size]
            x, y = struct.unpack('>hh', record[:4])
            blanked = bool(record[STATUS_OFFSET[fmt]] & 0x40)
            points.append((x, y, blanked))
        frames.append(points)
    return formats, frames


def summarize(path):
    formats, frames = read_frames(path)
    if not frames:
        return f'fmts={sorted(formats)} (no point frames)'
    per_frame = []
    for points in frames:
        lit_steps, blank_steps, hold_runs, run = [], [], [], 1
        for a, b in zip(points, points[1:]):
            step = math.hypot(b[0] - a[0], b[1] - a[1])
            if step == 0:
                run += 1
                continue
            if run > 1:
                hold_runs.append(run)
            run = 1
            (blank_steps if b[2] else lit_steps).append(step)
        per_frame.append(dict(
            count=len(points),
            blanked=sum(p[2] for p in points),
            lit=statistics.median(lit_steps) if lit_steps else 0,
            blank=statistics.median(blank_steps) if blank_steps else 0,
            hold=statistics.median(hold_runs) if hold_runs else 0,
        ))
    counts = [f['count'] for f in per_frame]
    mean = lambda key: statistics.mean(f[key] for f in per_frame)
    first = frames[0]
    span = (max(p[0] for p in first) - min(p[0] for p in first),
            max(p[1] for p in first) - min(p[1] for p in first))
    return (f"fmts={sorted(formats)} frames={len(frames)} "
            f"pts/frame={min(counts)}/{round(statistics.median(counts))}/{max(counts)} "
            f"blank%={round(100 * sum(f['blanked'] for f in per_frame) / sum(counts))} "
            f"litStep~{round(mean('lit'))} blankStep~{round(mean('blank'))} "
            f"holdRun~{mean('hold'):.1f} span={span}")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    for file_path in sys.argv[1:]:
        try:
            print(os.path.basename(file_path).ljust(24), summarize(file_path))
        except Exception as error:            # keep going through the rest of the files
            print(os.path.basename(file_path).ljust(24), 'ERROR:', error)
