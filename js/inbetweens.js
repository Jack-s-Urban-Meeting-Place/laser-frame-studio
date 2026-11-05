/*
 * inbetweens.js — makes smooth "in-between" frames by morphing one traced frame into the next.
 *
 * Animators call this in-betweening (or "tweening"): the artist draws the key
 * frames and the in-betweens fill the gaps so the motion looks smoother.
 *
 * How it works, for two traced frames A and B:
 *   1. Matching:   decide which line in A becomes which line in B. Each possible
 *                  pair is scored by how far its points would have to travel
 *                  (and how different the two lengths are). The best pairs are
 *                  taken first, one partner each.
 *   2. Lining up:  both lines of a pair are re-drawn with the same number of
 *                  evenly spaced points, and turned so they run the same way
 *                  (a loop may also need its starting point moved).
 *   3. Morphing:   each in-between slides every point part of the way from A to B.
 *                  Lines with no partner shrink away (from A) or grow in (to B).
 *
 * If too little of the two frames matches up (a big jump, or very different
 * drawings), no in-betweens are made for that pair. It plays as a normal cut,
 * so the result is never worse than without in-betweens.
 *
 * Everything here works in working-image pixels, the same units as a trace
 * from trace-frame.js. laser-path.js turns the results into laser points.
 */
'use strict';

const MATCH_SAMPLE_POINTS = 24;    // points per line when comparing lines (quick and rough)
const MORPH_SAMPLES_PER_SIDE = 200; // the morph uses one point per 1/200 of the picture's diagonal
const MAX_MATCH_TRAVEL = 0.12;     // lines further apart than this (fraction of the diagonal) never pair up
const MAX_LENGTH_RATIO = 3;        // lines more than 3× longer/shorter than each other never pair up
const MIN_MATCHED_SHARE = 0.6;     // at least 60% of the line length must find a partner, or skip the pair
const VANISH_BELOW = 0.15;         // shrinking/growing lines are left out when smaller than this

/**
 * Re-draws a line with `count` evenly spaced points.
 * For a loop (closed), the points go all the way round without repeating the first one.
 */
function resamplePath(pts, closed, count) {
  const route = closed ? pts.concat([pts[0]]) : pts;
  const total = pathLength(route, false);
  if (total === 0 || route.length < 2) return new Array(count).fill(pts[0]);

  const step = total / (closed ? count : count - 1);
  const result = [];
  let segment = 0, segmentStart = 0;
  for (let i = 0; i < count; i++) {
    const wanted = Math.min(i * step, total);
    // Walk along the line until we reach the segment that contains `wanted`.
    while (segment < route.length - 2 &&
           segmentStart + distance(route[segment], route[segment + 1]) < wanted) {
      segmentStart += distance(route[segment], route[segment + 1]);
      segment++;
    }
    const a = route[segment], b = route[segment + 1];
    const length = distance(a, b) || 1;
    const t = Math.min(1, Math.max(0, (wanted - segmentStart) / length));
    result.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return result;
}

/**
 * Lines up `to` with `from` (both already resampled to the same count): flips its
 * direction and, for loops, moves its starting point, whichever way makes the
 * points travel least. Returns { aligned, travel } where travel is the average
 * distance a point moves (root mean square), in pixels.
 */
function alignPoints(from, to, closed) {
  const n = from.length;
  const options = [to, to.slice().reverse()];
  let best = null, bestSum = Infinity;
  for (const candidate of options) {
    const shifts = closed ? n : 1;          // open lines can only be flipped, not shifted
    for (let shift = 0; shift < shifts; shift++) {
      let sum = 0;
      for (let i = 0; i < n && sum < bestSum; i++) {
        const q = candidate[(i + shift) % n];
        const dx = from[i][0] - q[0], dy = from[i][1] - q[1];
        sum += dx * dx + dy * dy;
      }
      if (sum < bestSum) {
        bestSum = sum;
        best = shift ? candidate.slice(shift).concat(candidate.slice(0, shift)) : candidate;
      }
    }
  }
  return { aligned: best, travel: Math.sqrt(bestSum / n) };
}

/** Pairs up lines of frame A with lines of frame B. Returns { pairs, matchedShare }. */
function matchPaths(pathsA, pathsB, diagonal) {
  const describe = path => ({
    path,
    length: pathLength(path.pts, path.closed),
    rough: resamplePath(path.pts, path.closed, MATCH_SAMPLE_POINTS),
  });
  const linesA = pathsA.map(describe), linesB = pathsB.map(describe);

  // Score every possible pair; lower is better.
  const candidates = [];
  linesA.forEach((a, ia) => linesB.forEach((b, ib) => {
    if (a.path.closed !== b.path.closed) return;            // a loop only morphs into a loop
    const lengthRatio = Math.max(a.length, b.length) / Math.max(1e-6, Math.min(a.length, b.length));
    if (lengthRatio > MAX_LENGTH_RATIO) return;
    const travel = alignPoints(a.rough, b.rough, a.path.closed).travel / diagonal;
    if (travel > MAX_MATCH_TRAVEL) return;
    candidates.push({ ia, ib, score: travel + 0.05 * Math.log(lengthRatio) });
  }));

  // Take the best pairs first; each line gets at most one partner.
  candidates.sort((x, y) => x.score - y.score);
  const usedA = new Set(), usedB = new Set(), pairs = [];
  for (const c of candidates) {
    if (usedA.has(c.ia) || usedB.has(c.ib)) continue;
    usedA.add(c.ia);
    usedB.add(c.ib);
    pairs.push({ a: linesA[c.ia], b: linesB[c.ib] });
  }

  const totalLength = linesA.concat(linesB).reduce((sum, line) => sum + line.length, 0);
  const matchedLength = pairs.reduce((sum, p) => sum + p.a.length + p.b.length, 0);
  return {
    pairs,
    leftoverA: linesA.filter((_, i) => !usedA.has(i)),
    leftoverB: linesB.filter((_, i) => !usedB.has(i)),
    matchedShare: totalLength ? matchedLength / totalLength : 0,
  };
}

/** Scales a line toward its own middle, for lines that shrink away or grow in. */
function scaleAroundCenter(pts, factor) {
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  return pts.map(([x, y]) => [cx + (x - cx) * factor, cy + (y - cy) * factor]);
}

const mixColor = (c1, c2, t) => c1.map((v, i) => Math.round(v + (c2[i] - v) * t));

/**
 * Makes `count` in-between traces going from traceA to traceB.
 * Returns { traces, matchedShare } or { traces: null, reason } when the two
 * frames are too different to blend nicely.
 */
function makeInbetweenTraces(traceA, traceB, count) {
  if (traceA.width !== traceB.width || traceA.height !== traceB.height) {
    return { traces: null, reason: 'The two frames are different sizes' };
  }
  const { width, height } = traceA;
  const diagonal = Math.hypot(width, height);
  const match = matchPaths(traceA.paths, traceB.paths, diagonal);
  if (match.matchedShare < MIN_MATCHED_SHARE) {
    return { traces: null, matchedShare: match.matchedShare, reason: 'The two frames are too different to blend' };
  }

  // Line up each pair once; every in-between reuses it.
  const spacing = diagonal / MORPH_SAMPLES_PER_SIDE;
  const morphs = match.pairs.map(({ a, b }) => {
    const closed = a.path.closed;
    const n = Math.max(8, Math.min(200, Math.round(Math.max(a.length, b.length) / spacing)));
    const from = resamplePath(a.path.pts, closed, n);
    const to = alignPoints(from, resamplePath(b.path.pts, closed, n), closed).aligned;
    return { closed, from, to, colorA: a.path.color, colorB: b.path.color };
  });

  const traces = [];
  for (let k = 1; k <= count; k++) {
    const t = k / (count + 1);                     // e.g. 1 in-between: t = 0.5
    const paths = [];

    for (const m of morphs) {
      const pts = m.from.map((p, i) => [p[0] + (m.to[i][0] - p[0]) * t, p[1] + (m.to[i][1] - p[1]) * t]);
      // Drop the extra points again (they were only needed for the morph).
      paths.push({ pts: simplifyPath(pts, m.closed, spacing * 0.3), closed: m.closed, color: mixColor(m.colorA, m.colorB, t) });
    }
    // Lines only in A shrink away; lines only in B grow in.
    for (const { path } of match.leftoverA) {
      if (1 - t >= VANISH_BELOW) paths.push({ ...path, pts: scaleAroundCenter(path.pts, 1 - t), brightness: 1 - t });
    }
    for (const { path } of match.leftoverB) {
      if (t >= VANISH_BELOW) paths.push({ ...path, pts: scaleAroundCenter(path.pts, t), brightness: t });
    }
    traces.push({ width, height, paths });
  }
  return { traces, matchedShare: match.matchedShare };
}
