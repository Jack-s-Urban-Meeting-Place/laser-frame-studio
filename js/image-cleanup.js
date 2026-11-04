/*
 * image-cleanup.js — turns a picture into a clean black-and-white "ink mask".
 *
 * Pipeline (run on a small working copy of each frame):
 *   1. toGrayscale()     colour -> brightness, 0 (black) .. 255 (white)
 *   2. boxBlur()         optional softening of JPEG noise and paper texture
 *   3. otsuThreshold()   picks the dark/light cut-off automatically
 *   4. makeInkMask()     brightness -> ink (1) or paper (0), with optional invert
 *   5. removeSpecks()    drops tiny dots of ink and fills tiny holes
 *
 * A "mask" everywhere in this app is a Uint8Array with one entry per pixel,
 * row by row: 1 = ink, 0 = paper. Pixel (x, y) lives at index y * width + x.
 */
'use strict';

/** Converts RGBA pixel data (from canvas getImageData) to brightness values. */
function toGrayscale(rgba, pixelCount) {
  const gray = new Float32Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    // Standard luminance weights: green looks brightest to the eye, blue darkest.
    gray[i] = 0.299 * rgba[4 * i] + 0.587 * rgba[4 * i + 1] + 0.114 * rgba[4 * i + 2];
  }
  return gray;
}

/**
 * Fast blur: averages each pixel with its neighbours within `radius`,
 * first along rows, then along columns. Returns a new array.
 */
function boxBlur(gray, width, height, radius) {
  if (radius < 1) return gray;
  const across = new Float32Array(width * height);
  const result = new Float32Array(width * height);
  const windowSize = 2 * radius + 1;
  const clampX = x => Math.min(width - 1, Math.max(0, x));
  const clampY = y => Math.min(height - 1, Math.max(0, y));

  // Horizontal pass: slide a window along each row, keeping a running sum.
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let x = -radius; x <= radius; x++) sum += gray[row + clampX(x)];
    for (let x = 0; x < width; x++) {
      across[row + x] = sum / windowSize;
      sum += gray[row + clampX(x + radius + 1)] - gray[row + clampX(x - radius)];
    }
  }
  // Vertical pass: same idea down each column.
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) sum += across[clampY(y) * width + x];
    for (let y = 0; y < height; y++) {
      result[y * width + x] = sum / windowSize;
      sum += across[clampY(y + radius + 1) * width + x] - across[clampY(y - radius) * width + x];
    }
  }
  return result;
}

/**
 * Otsu's method: tries every possible cut-off and keeps the one that best
 * separates the image into two groups (ink and paper). Returns 1..255.
 */
function otsuThreshold(gray) {
  const histogram = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) histogram[Math.min(255, Math.max(0, gray[i] | 0))]++;

  const total = gray.length;
  let sumAll = 0;
  for (let level = 0; level < 256; level++) sumAll += level * histogram[level];

  let darkCount = 0, darkSum = 0, bestSeparation = 0, bestThreshold = 128;
  for (let level = 0; level < 256; level++) {
    darkCount += histogram[level];
    if (darkCount === 0) continue;
    const lightCount = total - darkCount;
    if (lightCount === 0) break;
    darkSum += level * histogram[level];
    const darkMean = darkSum / darkCount;
    const lightMean = (sumAll - darkSum) / lightCount;
    const separation = darkCount * lightCount * (darkMean - lightMean) ** 2;
    if (separation > bestSeparation) { bestSeparation = separation; bestThreshold = level + 1; }
  }
  return bestThreshold;
}

/**
 * Pixels darker than `threshold` become ink.
 * invertMode: 'off' = dark ink on light paper, 'on' = light ink on dark paper,
 * 'auto' = flip when more than half the picture came out as "ink"
 * (which almost always means the background is the dark part).
 */
function makeInkMask(gray, threshold, invertMode) {
  const mask = new Uint8Array(gray.length);
  let inkCount = 0;
  for (let i = 0; i < gray.length; i++) {
    mask[i] = gray[i] < threshold ? 1 : 0;
    inkCount += mask[i];
  }
  const inverted = invertMode === 'on' || (invertMode === 'auto' && inkCount > gray.length / 2);
  if (inverted) for (let i = 0; i < mask.length; i++) mask[i] ^= 1;
  return { mask, inverted };
}

/**
 * Cleans the mask in place:
 *   - ink blobs smaller than minArea pixels are erased (dust, stray marks)
 *   - paper holes smaller than minArea pixels are filled (pinholes inside shapes),
 *     except holes touching the image border, which are really background.
 */
function removeSpecks(mask, width, height, minArea) {
  if (minArea < 1) return;
  const visited = new Uint8Array(width * height);
  const stack = [];
  const piece = [];

  for (const value of [1, 0]) {            // first ink blobs, then paper holes
    visited.fill(0);
    for (let start = 0; start < width * height; start++) {
      if (visited[start] || mask[start] !== value) continue;

      // Flood-fill one connected piece and remember its pixels.
      stack.length = 0; piece.length = 0;
      stack.push(start); visited[start] = 1;
      let touchesBorder = false;
      while (stack.length) {
        const i = stack.pop();
        piece.push(i);
        const x = i % width, y = (i / width) | 0;
        if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesBorder = true;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            if (value === 0 && dx !== 0 && dy !== 0) continue;   // paper only connects through edges
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const j = ny * width + nx;
            if (!visited[j] && mask[j] === value) { visited[j] = 1; stack.push(j); }
          }
        }
      }

      const isSmall = piece.length < minArea;
      const shouldFlip = isSmall && (value === 1 || !touchesBorder);
      if (shouldFlip) for (const i of piece) mask[i] = 1 - value;
    }
  }
}
