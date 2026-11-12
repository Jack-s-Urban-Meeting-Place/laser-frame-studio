/*
 * trace-frame.js — runs the whole "picture -> clean vector paths" pipeline for one frame.
 *
 *   image  -> working copy (getWorkingImage)
 *          -> ink mask     (image-cleanup.js)
 *          -> raw paths    (tracing.js)
 *          -> clean paths  (path-cleanup.js)
 *
 * The result is cached on the frame by app.js, and only recomputed when a
 * tracing setting changes. Laser settings are applied later (laser-path.js).
 * Lines drawn on the drawing pad use traceDrawing() instead (bottom of this file).
 */
'use strict';

// Sliders measured in pixels (blur, specks, simplify, lengths) are tuned for a
// working image 400 px across; at other "Detail" sizes they are scaled to match,
// so the same slider value looks the same at any detail level.
const REFERENCE_DETAIL = 400;

// Mixed mode: pieces of ink wider than this (at reference detail) are treated
// as solid shapes and outlined; thinner ones are treated as pen strokes.
const MAX_STROKE_WIDTH = 12;

/**
 * Draws the frame onto a white canvas whose longest side is `longestSide`
 * pixels, and returns its pixels. Cached on the frame per detail level.
 */
function getWorkingImage(frame, longestSide) {
  if (frame.working && frame.working.longestSide === longestSide) return frame.working;
  const scale = longestSide / Math.max(frame.bitmap.width, frame.bitmap.height);
  const width = Math.max(8, Math.round(frame.bitmap.width * scale));
  const height = Math.max(8, Math.round(frame.bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';                  // transparent PNGs are treated as white paper
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(frame.bitmap, 0, 0, width, height);

  frame.working = { longestSide, width, height, rgba: ctx.getImageData(0, 0, width, height).data };
  return frame.working;
}

/**
 * Traces one frame with the current settings.
 * Returns { width, height, mask, threshold, inverted, paths }, where each path is
 * { pts, closed, color } in working-image pixels.
 */
function traceFrame(frame, settings) {
  const { width, height, rgba } = getWorkingImage(frame, settings.detail);
  const scale = settings.detail / REFERENCE_DETAIL;

  // 1. Picture -> clean ink mask.
  const gray = boxBlur(toGrayscale(rgba, width * height), width, height, Math.round(settings.blur * scale));
  const threshold = settings.autoThreshold ? otsuThreshold(gray) : settings.threshold;
  const { mask, inverted } = makeInkMask(gray, threshold, settings.invert);
  removeSpecks(mask, width, height, Math.round(settings.speckSize * scale * scale));

  // 2. Mask -> raw paths, depending on the art style.
  const stubLength = settings.stubLength * scale;
  let rawPaths;
  if (settings.artStyle === 'outline') {
    rawPaths = traceOutlines(mask, width, height);
  } else if (settings.artStyle === 'centerline') {
    rawPaths = traceCenterlines(mask, width, height, stubLength);
  } else {
    const { thinMask, thickMask } = splitByStrokeWidth(mask, width, height, MAX_STROKE_WIDTH * scale);
    rawPaths = traceCenterlines(thinMask, width, height, stubLength)
      .concat(traceOutlines(thickMask, width, height));
  }

  // 3. Raw paths -> smooth, simplified paths with a colour each.
  const paths = [];
  for (const raw of rawPaths) {
    const isTooShort = pathLength(raw.pts, raw.closed) < settings.minLineLength * scale;
    if (raw.freeStanding !== false && isTooShort) continue;

    const color = sampleLineColor(raw.pts, mask, rgba, width, height);
    let pts = smoothPath(raw.pts, raw.closed, settings.smoothing);
    pts = simplifyPath(pts, raw.closed, settings.simplify * scale);
    if (pts.length < 2) continue;
    paths.push({ pts, closed: raw.closed && pts.length > 2, color });
  }

  return { width, height, mask, threshold, inverted, paths };
}

/**
 * Frames drawn on the drawing pad (draw-pad.js) are already lines, so they skip
 * all of the above: each pen stroke becomes one path, with its own colour.
 * Only Simplify and Smoothing apply (lightly), to tidy shaky hand-drawn lines.
 * `drawing` is { width, height, strokes } in pad pixels (the drawing space).
 * Returns the same shape as traceFrame(), with no mask (there is no picture to clean).
 */
function traceDrawing(drawing, settings) {
  const { width, height, strokes } = drawing;
  const scale = Math.max(width, height) / REFERENCE_DETAIL;
  const paths = strokes.map(stroke => {
    let pts = stroke.pts;
    if (pts.length === 1) {
      pts = [pts[0], pts[0]];                           // a dot: the laser draws it as a bright point
    } else {
      // Strokes are stored with few points (a straight line is just its two ends).
      // Smoothing averages each point with its neighbours, which would cut the
      // corners off a sparse shape, so first put points every few pixels.
      pts = addPointsAlong(pts, stroke.closed, 4);
      pts = smoothPath(pts, stroke.closed, Math.min(1, settings.smoothing));
      pts = simplifyPath(pts, stroke.closed, settings.simplify * scale * 0.5);
    }
    return { pts, closed: stroke.closed && pts.length > 2, color: stroke.rgb.slice() };
  });
  return { width, height, mask: null, threshold: null, inverted: false, paths };
}

/** Returns the line with extra points added so no two are more than `step` pixels apart. */
function addPointsAlong(pts, closed, step) {
  const route = closed ? pts.concat([pts[0]]) : pts;
  const result = [route[0]];
  for (let i = 1; i < route.length; i++) {
    const from = route[i - 1], to = route[i];
    const pieces = Math.max(1, Math.ceil(distance(from, to) / step));
    for (let k = 1; k <= pieces; k++) {
      result.push([from[0] + (to[0] - from[0]) * k / pieces, from[1] + (to[1] - from[1]) * k / pieces]);
    }
  }
  if (closed) result.pop();                 // the loop closes itself; don't repeat the start
  return result;
}
