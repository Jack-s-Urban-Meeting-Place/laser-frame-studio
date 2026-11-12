/*
 * laser-path.js — turns clean vector paths into the point list a laser plays.
 *
 * A laser frame is one long list of points. The scanner mirrors visit them in
 * order at a fixed rate (e.g. 30,000 points per second). Each point is either
 * lit (has a colour) or blanked (beam off, used to jump between shapes).
 *
 * What this file takes care of:
 *   - Coordinates: image pixels -> ILDA units (-32768..32767, y pointing up),
 *     fitted inside the "wall canvas" (the safe area on the real wall) if asked.
 *   - Order: draws paths in a nearest-next order so the beam-off jumps are short.
 *   - Spacing: adds points along long lines so the mirrors follow them evenly.
 *   - Holds ("dwell"): repeats points at corners and at both ends of a jump,
 *     giving the mirrors time to arrive. Without them corners round off and
 *     faint "tails" show where the beam should be off.
 *   - Budget: if a frame has more points than "Max points", spaces the points
 *     out further until it fits (fewer points = faster redraw = less flicker).
 *
 * The hold and spacing defaults were checked against the official ILDA sample
 * files (see AGENTS.md), and played well on the LaserCube Ultra.
 */
'use strict';

const ILDA_SPAN = 65534;        // usable width of the ILDA coordinate range
const BLANK_STEP = 2500;        // ILDA units per point while the beam travels with the laser off
const JOIN_DISTANCE = 500;      // gaps smaller than this are drawn straight through, no blanking
const CORNER_COS = 0.7;         // turns sharper than ~45° count as a corner (cosine of the angle)
const MAX_POINT_SPACING = 40000;
const DEFAULT_ART_SIZE = 0.92;  // "Scale & position" Size at its starting value (keep in sync with value="92" in the HTML)

/**
 * Greedy ordering: from where the beam is now, always draw the nearest
 * remaining path next. Open paths may be drawn backwards; closed loops are
 * started at whichever of their points is nearest. Closed loops get their first
 * point repeated at the end so the loop is drawn all the way round.
 */
function orderPaths(paths, startPosition) {
  const remaining = paths.slice();
  const ordered = [];
  let position = startPosition;

  while (remaining.length) {
    let best = { index: 0, distance: Infinity, reverse: false, startAt: 0 };
    remaining.forEach((path, index) => {
      if (path.closed) {
        path.pts.forEach((pt, startAt) => {
          const d = distance(position, pt);
          if (d < best.distance) best = { index, distance: d, reverse: false, startAt };
        });
      } else {
        const toStart = distance(position, path.pts[0]);
        const toEnd = distance(position, path.pts[path.pts.length - 1]);
        if (toStart < best.distance) best = { index, distance: toStart, reverse: false, startAt: 0 };
        if (toEnd < best.distance) best = { index, distance: toEnd, reverse: true, startAt: 0 };
      }
    });

    const path = remaining.splice(best.index, 1)[0];
    let pts;
    if (path.closed) {
      pts = path.pts.slice(best.startAt).concat(path.pts.slice(0, best.startAt));
      pts.push(pts[0]);
    } else {
      pts = best.reverse ? path.pts.slice().reverse() : path.pts;
    }
    ordered.push({ pts, color: path.color });
    position = pts[pts.length - 1];
  }
  return ordered;
}

/**
 * Produces the final point list for ordered paths, with lit points no more
 * than `spacing` ILDA units apart. Each point: { x, y, r, g, b, blank }.
 */
function generateLaserPoints(orderedPaths, spacing, settings) {
  const points = [];
  const addPoint = (pt, color, blank) => points.push({
    x: pt[0], y: pt[1],
    r: blank ? 0 : color[0], g: blank ? 0 : color[1], b: blank ? 0 : color[2],
    blank,
  });
  const addHold = (pt, color, blank, count) => { for (let i = 0; i < count; i++) addPoint(pt, color, blank); };
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

  const arriveHold = Math.max(1, settings.blankHold);              // beam off, waiting at the new start
  const leaveHold = Math.max(1, Math.round(settings.blankHold / 2)); // beam off, before leaving the old end
  let beam = null;                                                 // where the beam is now

  for (const { pts, color } of orderedPaths) {
    const start = pts[0];

    // Get to the start of this path.
    if (beam === null) {
      addHold(start, color, true, arriveHold);
    } else if (distance(beam, start) > JOIN_DISTANCE) {
      addHold(beam, color, true, leaveHold);
      const steps = Math.ceil(distance(beam, start) / BLANK_STEP);
      for (let i = 1; i < steps; i++) addPoint(lerp(beam, start, i / steps), color, true);
      addHold(start, color, true, arriveHold);
    }

    // Draw the path, holding at sharp corners.
    addPoint(start, color, false);
    for (let i = 0; i < pts.length - 1; i++) {
      const from = pts[i], to = pts[i + 1];
      const steps = Math.max(1, Math.ceil(distance(from, to) / spacing));
      for (let s = 1; s <= steps; s++) addPoint(lerp(from, to, s / steps), color, false);

      const after = pts[i + 2];
      if (after && settings.cornerHold) {
        const inDir = [to[0] - from[0], to[1] - from[1]];
        const outDir = [after[0] - to[0], after[1] - to[1]];
        const lengths = Math.hypot(...inDir) * Math.hypot(...outDir) || 1;
        const cos = (inDir[0] * outDir[0] + inDir[1] * outDir[1]) / lengths;
        if (cos < CORNER_COS) addHold(to, color, false, settings.cornerHold);
      }
    }
    addHold(pts[pts.length - 1], color, false, settings.cornerHold);   // finish the line end cleanly
    beam = pts[pts.length - 1];
  }

  if (beam) addHold(beam, [0, 0, 0], true, leaveHold);   // turn off before the next frame starts
  if (!points.length) addPoint([0, 0], [0, 0, 0], true);  // empty frame: one dark point keeps the file valid
  return points;
}

/**
 * The wall canvas: the safe area on the real wall, in ILDA units.
 * The settings are percentages of the full laser range (see the "Wall canvas"
 * group in the HTML). Returns { left, right, bottom, top, centerX, centerY, width, height }.
 */
function wallCanvasBox(settings) {
  const width = settings.canvasWidth * ILDA_SPAN;
  const height = settings.canvasHeight * ILDA_SPAN;
  const centerX = settings.canvasX * ILDA_SPAN;
  const centerY = settings.canvasY * ILDA_SPAN;
  return {
    width, height, centerX, centerY,
    left: centerX - width / 2, right: centerX + width / 2,
    bottom: centerY - height / 2, top: centerY + height / 2,
  };
}

/**
 * Where a picture of `width` × `height` pixels lands in ILDA units.
 *   Fit to wall canvas ON:  the picture is scaled to fit inside the canvas box and
 *                           centred on it; Size = how much of the canvas it fills.
 *   Fit to wall canvas OFF: the longest side fills Size of the whole laser range,
 *                           centred on the middle (how v1.0 and v1.1 worked).
 * Then "Scale & position" Left/right and Up/down (artX, artY) move it, measured
 * as a fraction of the canvas (or of the whole range when Fit is off).
 * Returns a function [x, y] in pixels -> [x, y] in ILDA units (y pointing up).
 */
function pictureToLaser(width, height, settings) {
  let unitsPerPixel, centerX = 0, centerY = 0;
  const moveX = settings.artX || 0, moveY = settings.artY || 0;
  if (settings.fitToCanvas) {
    const box = wallCanvasBox(settings);
    unitsPerPixel = settings.size * Math.min(box.width / width, box.height / height);
    centerX = box.centerX + moveX * box.width;
    centerY = box.centerY + moveY * box.height;
  } else {
    unitsPerPixel = settings.size * ILDA_SPAN / Math.max(width, height);
    centerX = moveX * ILDA_SPAN;
    centerY = moveY * ILDA_SPAN;
  }
  return ([x, y]) => [centerX + (x - width / 2) * unitsPerPixel,
                      centerY - (y - height / 2) * unitsPerPixel];
}

/**
 * The drawing space: a grid of `width` × `height` "pad pixels" that covers the wall
 * canvas exactly. Lines drawn on the drawing pad are stored in it, and every frame's
 * lines (uploaded and drawn) are combined in it before going to the laser (app.js).
 * Scale & position don't apply here: what you see on the pad is where it lands.
 * Returns a function [x, y] pad pixels -> [x, y] ILDA units.
 */
function wallSpaceToLaser(width, height, settings) {
  return pictureToLaser(width, height, { ...settings, fitToCanvas: true, size: 1, artX: 0, artY: 0 });
}

/** The opposite of wallSpaceToLaser: [x, y] ILDA units -> [x, y] pad pixels. */
function laserToWallSpace(width, height, settings) {
  const toLaser = wallSpaceToLaser(width, height, settings);
  const [originX, originY] = toLaser([0, 0]);
  const unitsPerPixel = toLaser([1, 0])[0] - originX;
  return ([x, y]) => [(x - originX) / unitsPerPixel, (originY - y) / unitsPerPixel];
}

/**
 * Where the lines of an opened .ild file land. At the starting Scale & position the
 * file plays exactly as it was made. Size then grows or shrinks it around the
 * middle of the wall canvas, and Left/right, Up/down move it, like any other art.
 * Returns a function [x, y] ILDA units (from the file) -> [x, y] ILDA units.
 */
function ildaArtToLaser(settings) {
  const box = wallCanvasBox(settings);
  const fit = settings.fitToCanvas;
  const centerX = fit ? box.centerX : 0, centerY = fit ? box.centerY : 0;
  const grow = settings.size / DEFAULT_ART_SIZE;
  const moveX = (settings.artX || 0) * (fit ? box.width : ILDA_SPAN);
  const moveY = (settings.artY || 0) * (fit ? box.height : ILDA_SPAN);
  return ([x, y]) => [centerX + (x - centerX) * grow + moveX, centerY + (y - centerY) * grow + moveY];
}

/** Counts lit points that fall outside the wall canvas (they would land on the glass). */
function countPointsOutsideCanvas(points, settings) {
  const box = wallCanvasBox(settings);
  const margin = 50;   // ILDA units; ignores rounding right on the edge
  return points.filter(p => !p.blank && (
    p.x < box.left - margin || p.x > box.right + margin ||
    p.y < box.bottom - margin || p.y > box.top + margin)).length;
}

/**
 * Builds the laser frame for one frame's lines.
 * `trace` is in the drawing space (see wallSpaceToLaser) and each path already has
 * its final colour (app.js works those out when it combines a frame's layers).
 * `startPosition` is where the previous frame ended, so the first jump is short.
 * Returns { points, spacing, fitsBudget, lineCount, blankedCount, outsideCount, endPosition }.
 */
function buildLaserFrame(trace, settings, startPosition) {
  const toLaser = wallSpaceToLaser(trace.width, trace.height, settings);
  const paths = trace.paths.map(path => {
    const color = path.color;
    const brightness = path.brightness === undefined ? 1 : path.brightness;   // < 1 for lines fading in/out (in-betweens)
    return {
      closed: path.closed,
      pts: path.pts.map(toLaser),
      color: color.map(v => Math.round(v * brightness)),
    };
  });
  const ordered = orderPaths(paths, startPosition);

  let spacing = settings.pointSpacing;
  let points = generateLaserPoints(ordered, spacing, settings);
  let fitsBudget = true;

  if (points.length > settings.maxPoints) {
    // Binary search for the smallest spacing that fits within the point budget.
    let tooTight = settings.pointSpacing;
    let fits = MAX_POINT_SPACING;
    let best = generateLaserPoints(ordered, fits, settings);
    if (best.length > settings.maxPoints) {
      fitsBudget = false;                  // even very coarse spacing is too much: too many lines
    } else {
      for (let round = 0; round < 14; round++) {
        const middle = (tooTight + fits) / 2;
        const attempt = generateLaserPoints(ordered, middle, settings);
        if (attempt.length > settings.maxPoints) tooTight = middle;
        else { fits = middle; best = attempt; }
      }
    }
    spacing = fits;
    points = best;
  }

  // An empty frame (nothing drawn yet) is a single beam-off point: a short pause.
  if (!points.length) points = [{ x: startPosition[0], y: startPosition[1], r: 0, g: 0, b: 0, blank: true }];
  const last = points[points.length - 1];
  return {
    points,
    spacing,
    fitsBudget,
    lineCount: paths.length,
    blankedCount: points.filter(p => p.blank).length,
    outsideCount: countPointsOutsideCanvas(points, settings),
    endPosition: [last.x, last.y],
  };
}
