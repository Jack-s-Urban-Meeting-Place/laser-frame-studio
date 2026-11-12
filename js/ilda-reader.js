/*
 * ilda-reader.js — reads .ild laser files, so people can view and edit other people's work.
 *
 * The opposite of ilda-writer.js. An ILDA file is a list of sections, each with a
 * 32-byte header (see ilda-writer.js for the header layout) followed by records:
 *
 *   format 0  3D points, colour from a palette   8 bytes: X Y Z (int16), status, colour index
 *   format 1  2D points, colour from a palette   6 bytes: X Y (int16), status, colour index
 *   format 2  a colour palette                    3 bytes: R G B
 *   format 4  3D points, true colour              10 bytes: X Y Z (int16), status, B G R
 *   format 5  2D points, true colour              8 bytes: X Y (int16), status, B G R
 *
 * Status byte: 0x80 = last point of the frame, 0x40 = blanked (laser off).
 * Numbers are big-endian. A header with 0 records marks the end of the file.
 *
 * Some old files have junk after their last frame. Reading stops there and keeps
 * every frame read so far.
 *
 * readIldaFile(bytes)     -> { frames: [{ name, points: [{ x, y, blank, r, g, b }] }], note }
 * ildaFrameToStrokes(pts) -> lit lines, ready to become drawing pad strokes
 */
'use strict';

/**
 * The standard ILDA default palette (64 colours), used by formats 0 and 1 when a
 * file doesn't include its own palette (format 2). It runs round the colour
 * wheel (red, yellow, green, cyan, blue, magenta), then white and pinks.
 */
const ILDA_DEFAULT_PALETTE = [
  [255, 0, 0], [255, 16, 0], [255, 32, 0], [255, 48, 0], [255, 64, 0], [255, 80, 0], [255, 96, 0], [255, 112, 0],
  [255, 128, 0], [255, 144, 0], [255, 160, 0], [255, 176, 0], [255, 192, 0], [255, 208, 0], [255, 224, 0], [255, 240, 0],
  [255, 255, 0], [224, 255, 0], [192, 255, 0], [160, 255, 0], [128, 255, 0], [96, 255, 0], [64, 255, 0], [32, 255, 0],
  [0, 255, 0], [0, 255, 36], [0, 255, 73], [0, 255, 109], [0, 255, 146], [0, 255, 182], [0, 255, 219], [0, 255, 255],
  [0, 227, 255], [0, 198, 255], [0, 170, 255], [0, 142, 255], [0, 113, 255], [0, 85, 255], [0, 56, 255], [0, 28, 255],
  [0, 0, 255], [32, 0, 255], [64, 0, 255], [96, 0, 255], [128, 0, 255], [160, 0, 255], [192, 0, 255], [224, 0, 255],
  [255, 0, 255], [255, 32, 255], [255, 64, 255], [255, 96, 255], [255, 128, 255], [255, 160, 255], [255, 192, 255], [255, 224, 255],
  [255, 255, 255], [255, 224, 224], [255, 192, 192], [255, 160, 160], [255, 128, 128], [255, 96, 96], [255, 64, 64], [255, 32, 32],
];

const RECORD_BYTES = { 0: 8, 1: 6, 2: 3, 4: 10, 5: 8 };

/** Reads the bytes of a .ild file. Returns { frames, note } (note explains anything skipped). */
function readIldaFile(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames = [];
  let palette = ILDA_DEFAULT_PALETTE;
  let offset = 0;
  let note = '';

  while (offset + 32 <= bytes.length) {
    const magic = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    if (magic !== 'ILDA') { note = 'Some unreadable data at the end of the file was skipped.'; break; }
    const format = bytes[offset + 7];
    const name = String.fromCharCode(...bytes.slice(offset + 8, offset + 16)).replace(/\0/g, '').trim();
    let count = view.getUint16(offset + 24);
    const size = RECORD_BYTES[format];
    offset += 32;
    if (count === 0) break;                                        // end of file
    if (!size) { note = `Stopped at an unknown section (format ${format}).`; break; }
    // A file cut short: keep every complete point (some old files are missing a byte or two).
    const complete = Math.floor((bytes.length - offset) / size);
    const cutShort = complete < count;
    if (cutShort) {
      count = complete;
      note = 'The file ends part-way through a frame, so its last few points were skipped.';
      if (!count) break;
    }

    if (format === 2) {                                            // a palette for the frames that follow
      palette = [];
      for (let i = 0; i < count; i++) palette.push([bytes[offset + i * 3], bytes[offset + i * 3 + 1], bytes[offset + i * 3 + 2]]);
    } else {
      const points = [];
      for (let i = 0; i < count; i++) {
        const at = offset + i * size;
        const x = view.getInt16(at), y = view.getInt16(at + 2);
        // The status byte comes after X Y (2D) or X Y Z (3D); the colour follows it.
        const statusAt = at + (format === 0 || format === 4 ? 6 : 4);
        const blank = (bytes[statusAt] & 0x40) !== 0;
        let rgb;
        if (format === 4 || format === 5) rgb = [bytes[statusAt + 3], bytes[statusAt + 2], bytes[statusAt + 1]];   // stored B G R
        else rgb = palette[bytes[statusAt + 1]] || [255, 255, 255];
        // A "lit" point with no colour is really off.
        const off = blank || (rgb[0] === 0 && rgb[1] === 0 && rgb[2] === 0);
        points.push({ x, y, blank: off, r: rgb[0], g: rgb[1], b: rgb[2] });
      }
      frames.push({ name: name || `frame ${frames.length + 1}`, points });
    }
    offset += count * size;
    if (cutShort) break;
  }
  return { frames, note };
}

/**
 * Turns one frame's laser points back into lines: each run of lit points of the
 * same colour becomes one stroke. Repeated points (corner and jump "holds") are
 * dropped. Returns [{ rgb, pts: [[x, y], …] in ILDA units, closed }].
 */
function ildaFrameToStrokes(points) {
  const strokes = [];
  let stroke = null;
  const sameColor = (rgb, p) => rgb[0] === p.r && rgb[1] === p.g && rgb[2] === p.b;

  points.forEach((p, i) => {
    if (p.blank) { stroke = null; return; }
    const here = [p.x, p.y];
    if (!stroke || !sameColor(stroke.rgb, p)) {
      // A lit point means the beam travelled here from the previous point with the
      // laser on, so the line starts at the previous point.
      const previous = points[i - 1];
      stroke = { rgb: [p.r, p.g, p.b], pts: previous ? [[previous.x, previous.y]] : [], closed: false };
      strokes.push(stroke);
    }
    const last = stroke.pts[stroke.pts.length - 1];
    if (!last || last[0] !== here[0] || last[1] !== here[1]) stroke.pts.push(here);
  });

  for (const s of strokes) {
    const pts = s.pts;
    // Ends where it started: a loop (circle, box). Drop the repeated end point.
    if (pts.length > 3 && distance(pts[0], pts[pts.length - 1]) < 60) {
      s.closed = true;
      pts.pop();
    }
  }
  return strokes.filter(s => s.pts.length > 0);
}
