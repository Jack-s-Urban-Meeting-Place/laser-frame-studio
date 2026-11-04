/*
 * tracing.js — turns an ink mask into vector lines ("paths").
 *
 * Three ways to trace, matching the "Art style" menu:
 *   traceOutlines()       Filled shapes: follows the edge around every ink area.
 *   traceCenterlines()    Line drawing: shrinks strokes to 1-pixel-wide skeletons
 *                         and follows those, so each pen stroke becomes one laser line.
 *   splitByStrokeWidth()  Mixed: sorts each separate piece of ink into "thin stroke"
 *                         or "solid blob" so the two tracers above can each do their part.
 *
 * Every tracer returns an array of paths: { pts: [[x, y], ...], closed: true/false }.
 * Coordinates are in working-image pixels, where pixel (x, y) covers x..x+1, y..y+1.
 */
'use strict';

// ---------------------------------------------------------------------------
// Outlines — "marching squares"
// ---------------------------------------------------------------------------
//
// Look at every 2x2 block of pixels. Wherever ink meets paper inside the
// block, draw a short segment between the midpoints of the block's edges.
// Chaining all segments end to end gives closed loops around every shape
// (and around every hole inside a shape).

function traceOutlines(mask, width, height) {
  const isInk = (x, y) => (x < 0 || y < 0 || x >= width || y >= height) ? 0 : mask[y * width + x];

  // Segment end points sit on half-pixel positions, so store them doubled
  // (integers) and pack (X, Y) into one number to use as a Map key.
  const keyWidth = 2 * width + 6;
  const keyOf = ([X, Y]) => (Y + 2) * keyWidth + (X + 2);
  const neighbours = new Map();            // point key -> [the two points it connects to]
  const connect = (a, b) => {
    const ka = keyOf(a), kb = keyOf(b);
    if (!neighbours.has(ka)) neighbours.set(ka, []);
    if (!neighbours.has(kb)) neighbours.set(kb, []);
    neighbours.get(ka).push(kb);
    neighbours.get(kb).push(ka);
  };

  for (let y = -1; y < height; y++) {
    for (let x = -1; x < width; x++) {
      // Corner bits: top-left 8, top-right 4, bottom-right 2, bottom-left 1.
      const pattern = isInk(x, y) * 8 + isInk(x + 1, y) * 4 + isInk(x + 1, y + 1) * 2 + isInk(x, y + 1);
      if (pattern === 0 || pattern === 15) continue;   // all paper or all ink: no edge here

      // Midpoints of the block's four edges (doubled coordinates).
      const top = [2 * x + 1, 2 * y], right = [2 * x + 2, 2 * y + 1];
      const bottom = [2 * x + 1, 2 * y + 2], left = [2 * x, 2 * y + 1];

      switch (pattern) {
        case 1: case 14: connect(left, bottom); break;
        case 2: case 13: connect(bottom, right); break;
        case 3: case 12: connect(left, right); break;
        case 4: case 11: connect(top, right); break;
        case 6: case 9: connect(top, bottom); break;
        case 7: case 8: connect(left, top); break;
        // Diagonal patterns: treat the two ink corners as touching.
        case 5: connect(left, top); connect(bottom, right); break;
        case 10: connect(top, right); connect(left, bottom); break;
      }
    }
  }

  // Walk the chains. Every point has exactly two neighbours, so each chain is a loop.
  const visited = new Set();
  const paths = [];
  for (const startKey of neighbours.keys()) {
    if (visited.has(startKey)) continue;
    const loop = [];
    let previous = -1, current = startKey;
    for (;;) {
      visited.add(current);
      loop.push(current);
      const [a, b] = neighbours.get(current);
      const next = a !== previous ? a : b;
      if (next === undefined || next === startKey || visited.has(next)) break;
      previous = current;
      current = next;
    }
    if (loop.length >= 4) {
      const pts = loop.map(key => {
        const X = (key % keyWidth) - 2, Y = Math.floor(key / keyWidth) - 2;
        return [X / 2 + 0.5, Y / 2 + 0.5];
      });
      paths.push({ pts, closed: true });
    }
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Skeletons — Zhang-Suen thinning
// ---------------------------------------------------------------------------
//
// Repeatedly peels away ink pixels from the outside of every stroke, without
// ever breaking a stroke in two, until only a 1-pixel-wide centre line is left.
// Neighbour names follow the original paper, clockwise from the top:
//
//     p9 p2 p3
//     p8 .. p4
//     p7 p6 p5

function thinToSkeleton(mask, width, height) {
  const img = new Uint8Array(mask);
  // Clear the 1-pixel border so the neighbour lookups below never go off the edge.
  for (let x = 0; x < width; x++) { img[x] = 0; img[(height - 1) * width + x] = 0; }
  for (let y = 0; y < height; y++) { img[y * width] = 0; img[y * width + width - 1] = 0; }

  const toDelete = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      toDelete.length = 0;
      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          const i = y * width + x;
          if (!img[i]) continue;
          const p2 = img[i - width], p3 = img[i - width + 1], p4 = img[i + 1], p5 = img[i + width + 1];
          const p6 = img[i + width], p7 = img[i + width - 1], p8 = img[i - 1], p9 = img[i - width - 1];

          // B: how many ink neighbours. Keep line ends (B<2) and interior pixels (B>6).
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;

          // A: number of paper->ink steps going round the ring. A must be 1,
          // otherwise removing this pixel would split the stroke.
          const A = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6) +
                    (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2);
          if (A !== 1) continue;

          // The two passes peel from opposite sides so the line stays centred.
          const blocked = pass === 0
            ? (p2 && p4 && p6) || (p4 && p6 && p8)
            : (p2 && p4 && p8) || (p2 && p6 && p8);
          if (blocked) continue;

          toDelete.push(i);
        }
      }
      for (const i of toDelete) img[i] = 0;
      if (toDelete.length) changed = true;
    }
  }
  return img;
}

// ---------------------------------------------------------------------------
// Centerlines — follow the skeleton
// ---------------------------------------------------------------------------
//
// Treat skeleton pixels as a network. "Nodes" are line ends (1 neighbour) and
// junctions (3+ neighbours); everything else (exactly 2 neighbours) is the
// middle of a line. Walk from node to node to get the lines, then pick up any
// closed loops (circles, letter O) that have no nodes at all.

function traceCenterlines(mask, width, height, stubLength) {
  const skeleton = thinToSkeleton(mask, width, height);
  const pixelCount = width * height;
  const isSkel = (x, y) => x >= 0 && y >= 0 && x < width && y < height && skeleton[y * width + x] === 1;

  // Neighbours of a skeleton pixel: the 4 side neighbours, plus a diagonal one
  // only when no side neighbour already links the two (avoids little triangles).
  function neighboursOf(i) {
    const x = i % width, y = (i / width) | 0, out = [];
    if (isSkel(x + 1, y)) out.push(i + 1);
    if (isSkel(x - 1, y)) out.push(i - 1);
    if (isSkel(x, y + 1)) out.push(i + width);
    if (isSkel(x, y - 1)) out.push(i - width);
    for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      if (isSkel(x + dx, y + dy) && !isSkel(x + dx, y) && !isSkel(x, y + dy)) out.push(i + dy * width + dx);
    }
    return out;
  }

  const links = new Array(pixelCount);
  const degree = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    if (skeleton[i]) { links[i] = neighboursOf(i); degree[i] = links[i].length; }
  }

  // Each step between two pixels may be walked only once.
  const walkedSteps = new Set();
  const stepKey = (a, b) => a < b ? a * pixelCount + b : b * pixelCount + a;

  function walk(start, next) {
    const line = [start];
    let previous = start, current = next;
    walkedSteps.add(stepKey(previous, current));
    for (;;) {
      line.push(current);
      if (degree[current] !== 2) break;        // reached a line end or a junction
      let following = -1;
      for (const n of links[current]) {
        if (n !== previous && !walkedSteps.has(stepKey(current, n))) { following = n; break; }
      }
      if (following < 0) break;
      walkedSteps.add(stepKey(current, following));
      previous = current;
      current = following;
    }
    return line;
  }

  const found = [];
  // 1) Lines that start at an end or junction.
  for (let i = 0; i < pixelCount; i++) {
    if (!skeleton[i] || degree[i] === 2 || degree[i] === 0) continue;
    for (const n of links[i]) {
      if (walkedSteps.has(stepKey(i, n))) continue;
      const line = walk(i, n);
      found.push({ line, closed: false, startDegree: degree[i], endDegree: degree[line[line.length - 1]] });
    }
  }
  // 2) Whatever is left is pure loops.
  for (let i = 0; i < pixelCount; i++) {
    if (!skeleton[i] || degree[i] !== 2) continue;
    for (const n of links[i]) {
      if (walkedSteps.has(stepKey(i, n))) continue;
      const line = walk(i, n);
      if (line[line.length - 1] === i) line.pop();   // don't repeat the starting pixel
      found.push({ line, closed: true, startDegree: 2, endDegree: 2 });
    }
  }

  const paths = [];
  for (const f of found) {
    const pts = f.line.map(i => [(i % width) + 0.5, ((i / width) | 0) + 0.5]);
    // A "stub" is a short twig from a junction to a dead end. Thinning makes
    // these at blunt stroke ends and corners; "Trim stubs" removes them.
    const isStub = !f.closed &&
      ((f.startDegree === 1 && f.endDegree >= 3) || (f.startDegree >= 3 && f.endDegree === 1));
    if (isStub && pathLength(pts, false) < stubLength) continue;
    // Only free-standing strokes (both ends loose, or a loop) are subject to the
    // "Min line length" filter later; short pieces of a bigger drawing are kept.
    const freeStanding = f.closed || (f.startDegree <= 1 && f.endDegree <= 1);
    paths.push({ pts, closed: f.closed, freeStanding });
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Mixed mode — decide per piece of ink
// ---------------------------------------------------------------------------
//
// For each separate piece of ink: average stroke width ≈ area / skeleton length.
// Pen strokes are thin (a few pixels); a filled circle or silhouette is very wide.

function splitByStrokeWidth(mask, width, height, maxStrokeWidth) {
  const skeleton = thinToSkeleton(mask, width, height);
  const pixelCount = width * height;
  const seen = new Uint8Array(pixelCount);
  const thinMask = new Uint8Array(pixelCount);
  const thickMask = new Uint8Array(pixelCount);
  const stack = [];

  for (let start = 0; start < pixelCount; start++) {
    if (!mask[start] || seen[start]) continue;
    const piece = [];
    let skeletonPixels = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop();
      piece.push(i);
      skeletonPixels += skeleton[i];
      const x = i % width, y = (i / width) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const j = ny * width + nx;
          if (mask[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
        }
      }
    }
    const averageWidth = piece.length / Math.max(1, skeletonPixels);
    const target = averageWidth > maxStrokeWidth ? thickMask : thinMask;
    for (const i of piece) target[i] = 1;
  }
  return { thinMask, thickMask };
}
