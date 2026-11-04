/*
 * path-cleanup.js — makes traced paths laser-friendly.
 *
 * Raw traced paths follow every pixel step, so they are jagged and have far
 * more points than a laser can draw. These helpers:
 *   smoothPath()      rounds off the pixel stair-steps
 *   simplifyPath()    keeps only the points needed to stay within a tolerance
 *   pathLength()      total length, used to drop tiny lines
 *   sampleLineColor() picks a laser colour for a path from the original image
 *
 * A path's points are [x, y] pairs; `closed` means the last point joins back to the first.
 */
'use strict';

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function pathLength(pts, closed) {
  let length = 0;
  for (let i = 1; i < pts.length; i++) length += distance(pts[i], pts[i - 1]);
  if (closed && pts.length > 1) length += distance(pts[0], pts[pts.length - 1]);
  return length;
}

/**
 * Moves each point a little toward the average of its neighbours
 * (weights ¼ ½ ¼), `passes` times. Open paths keep their end points fixed.
 */
function smoothPath(pts, closed, passes) {
  const n = pts.length;
  if (n < 3) return pts;
  for (let pass = 0; pass < passes; pass++) {
    const smoothed = new Array(n);
    for (let i = 0; i < n; i++) {
      if (!closed && (i === 0 || i === n - 1)) { smoothed[i] = pts[i]; continue; }
      const before = pts[(i - 1 + n) % n], here = pts[i], after = pts[(i + 1) % n];
      smoothed[i] = [
        0.25 * before[0] + 0.5 * here[0] + 0.25 * after[0],
        0.25 * before[1] + 0.5 * here[1] + 0.25 * after[1],
      ];
    }
    pts = smoothed;
  }
  return pts;
}

/** Shortest distance from point p to the line segment a–b. */
function distanceToSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  let t = lengthSquared ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/**
 * Ramer–Douglas–Peucker simplification of an open path: start with just the
 * two end points; if any point in between is further than `tolerance` from
 * that straight line, keep the furthest one and repeat on both halves.
 */
function simplifyOpenPath(pts, tolerance) {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const todo = [[0, n - 1]];
  while (todo.length) {
    const [first, last] = todo.pop();
    let furthest = -1, furthestDistance = -1;
    for (let i = first + 1; i < last; i++) {
      const d = distanceToSegment(pts[i], pts[first], pts[last]);
      if (d > furthestDistance) { furthestDistance = d; furthest = i; }
    }
    if (furthestDistance > tolerance) {
      keep[furthest] = 1;
      todo.push([first, furthest], [furthest, last]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Simplifies open or closed paths. A closed path is cut in two at its far side first. */
function simplifyPath(pts, closed, tolerance) {
  if (tolerance <= 0 || pts.length < 3) return pts;
  if (!closed) return simplifyOpenPath(pts, tolerance);

  let farIndex = 0, farDistance = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = distance(pts[i], pts[0]);
    if (d > farDistance) { farDistance = d; farIndex = i; }
  }
  const firstHalf = simplifyOpenPath(pts.slice(0, farIndex + 1), tolerance);
  const secondHalf = simplifyOpenPath(pts.slice(farIndex).concat([pts[0]]), tolerance);
  return firstHalf.concat(secondHalf.slice(1, -1));   // drop the duplicated joins
}

/**
 * Average colour of the ink under a path, pushed to full brightness, since a
 * laser can only add light. Black or grey ink (low saturation) becomes white.
 * Returns [r, g, b], each 0..255.
 */
function sampleLineColor(pts, mask, rgba, width, height) {
  let r = 0, g = 0, b = 0, samples = 0;
  const every = Math.max(1, Math.floor(pts.length / 150));   // ~150 samples is plenty
  for (let k = 0; k < pts.length; k += every) {
    const cx = Math.floor(pts[k][0]), cy = Math.floor(pts[k][1]);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= width || y >= height || !mask[y * width + x]) continue;
        const i = (y * width + x) * 4;
        r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2];
        samples++;
      }
    }
  }
  if (!samples) return [255, 255, 255];
  r /= samples; g /= samples; b /= samples;

  const brightest = Math.max(r, g, b), darkest = Math.min(r, g, b);
  const saturation = brightest < 1 ? 0 : (brightest - darkest) / brightest;
  if (saturation < 0.25) return [255, 255, 255];
  const boost = 255 / brightest;
  return [Math.round(r * boost), Math.round(g * boost), Math.round(b * boost)];
}
