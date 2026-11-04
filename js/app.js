/*
 * app.js — the user interface: loading frames, reading settings, previews, export.
 *
 * The heavy lifting lives in the other files (loaded before this one, see the
 * <script> tags at the bottom of laser-frame-studio.html):
 *   image-cleanup.js, tracing.js, path-cleanup.js, trace-frame.js   picture -> vector paths
 *   laser-path.js                                                     vector paths -> laser points
 *   ilda-writer.js                                                    laser points -> .ild file
 *   sample-fox.js                                                     built-in sample animation
 *
 * Data flow for each frame:
 *   frame.bitmap  --traceFrame()-->  frame.trace  --buildLaserFrame()-->  frame.laser
 * Changing a "trace" setting re-traces every frame (slow-ish, done in the background).
 * Changing a "laser" setting only rebuilds frame.laser (fast). Each input in the HTML
 * says which kind it is with data-stage="trace" or data-stage="laser".
 */
'use strict';

const $ = selector => document.querySelector(selector);

const state = {
  frames: [],          // [{ name, bitmap, thumbUrl, working, trace, traceKey, laser, cleanPreview }]
  current: 0,          // index of the frame shown in the preview
  traceRun: 0,         // bumps on every re-trace, so an outdated run can stop early
  playing: false,
  playTimer: null,
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Reads every setting from the page. Defaults are the value="" attributes in the HTML. */
function readSettings() {
  const number = id => Number($('#' + id).value);
  return {
    // tracing
    artStyle: $('#artStyle').value,              // 'auto' | 'centerline' | 'outline'
    detail: number('detail'),                    // working image size, longest side in px
    autoThreshold: $('#autoThreshold').checked,
    threshold: number('threshold'),              // 1..254, used when autoThreshold is off
    invert: $('#invert').value,                  // 'auto' | 'off' | 'on'
    blur: number('blur'),
    speckSize: number('speckSize'),              // px² at reference detail
    // simplify
    simplify: number('simplify'),                // px tolerance at reference detail
    smoothing: number('smoothing'),              // smoothing passes
    minLineLength: number('minLineLength'),      // px at reference detail
    stubLength: number('stubLength'),            // px at reference detail
    // colour
    colorMode: $('#colorMode').value,            // 'solid' | 'image'
    color: hexToRgb($('#color').value),
    // wall canvas (fractions of the full laser range)
    fitToCanvas: $('#fitToCanvas').checked,      // fit the art inside the canvas box
    canvasWidth: number('canvasWidth') / 100,
    canvasHeight: number('canvasHeight') / 100,
    canvasX: number('canvasX') / 100,            // centre offset, + = right
    canvasY: number('canvasY') / 100,            // centre offset, + = up
    // laser output
    size: number('size') / 100,                  // fraction of the canvas (or of the whole range)
    maxPoints: number('maxPoints'),
    pointSpacing: number('pointSpacing'),        // ILDA units between lit points
    cornerHold: number('cornerHold'),            // repeated points at corners
    blankHold: number('blankHold'),              // repeated beam-off points around jumps
    scanRate: number('scanRate'),                // points per second, for estimates only
    holdFrames: number('holdFrames'),            // times each frame is repeated in the file
  };
}

// ---------------------------------------------------------------------------
// Wall canvas: defaults and remembering the user's choice
// ---------------------------------------------------------------------------

/**
 * The JUMP wall, measured from the boundary show used on site (see the comment
 * above the "Wall canvas" group in the HTML). Keep in sync with the value="" there.
 */
const WALL_CANVAS_DEFAULTS = {
  fitToCanvas: true, showCanvas: true,
  canvasWidth: 57, canvasHeight: 90, canvasX: 1.5, canvasY: 2,
};
const REMEMBER_KEY = 'laserFrameStudio.wallCanvas';

/** Saves every input marked data-remember, so the canvas survives a page reload. */
function rememberSettings() {
  const saved = {};
  document.querySelectorAll('[data-remember]').forEach(input => {
    saved[input.id] = input.type === 'checkbox' ? input.checked : input.value;
  });
  try { localStorage.setItem(REMEMBER_KEY, JSON.stringify(saved)); } catch (error) { /* storage blocked: fine */ }
}

/** Puts back what rememberSettings() saved last time, if anything. */
function restoreSettings() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(REMEMBER_KEY)); } catch (error) { /* storage blocked: fine */ }
  if (saved) applyValues(saved);
}

function applyValues(values) {
  for (const [id, value] of Object.entries(values)) {
    const input = document.getElementById(id);
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = value;
    showSliderValue(input);
  }
}

function resetWallCanvas() {
  applyValues(WALL_CANVAS_DEFAULTS);
  rememberSettings();
  rebuildAllLaserFrames();
  render();
}

/** "Shape: about 2 wide × 3 tall", so people know what paper to draw on. */
function describeCanvasShape(settings) {
  const ratio = settings.canvasWidth / settings.canvasHeight;
  const shapes = [[1, 3], [1, 2], [2, 3], [3, 4], [1, 1], [4, 3], [3, 2], [2, 1], [3, 1]];
  const [w, h] = shapes.reduce((best, s) =>
    Math.abs(Math.log(s[0] / s[1] / ratio)) < Math.abs(Math.log(best[0] / best[1] / ratio)) ? s : best);
  const kind = ratio < 0.9 ? 'taller than wide: draw on portrait paper'
             : ratio > 1.1 ? 'wider than tall: draw on landscape paper' : 'about square';
  return `Shape: about ${w} wide × ${h} tall (${kind}).`;
}

/** Frames only need re-tracing when one of these settings changed. */
function traceSettingsKey(s) {
  return [s.artStyle, s.detail, s.autoThreshold, s.threshold, s.invert, s.blur, s.speckSize,
          s.simplify, s.smoothing, s.minLineLength, s.stubLength].join('|');
}

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------

const nextTick = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * Re-traces every frame whose trace is out of date. The visible frame goes
 * first so the preview updates quickly; the page stays responsive between frames.
 */
async function retraceAllFrames() {
  const run = ++state.traceRun;
  const settings = readSettings();
  const key = traceSettingsKey(settings);
  const count = state.frames.length;
  const order = [state.current, ...state.frames.map((_, i) => i).filter(i => i !== state.current)];

  let done = 0;
  for (const index of order) {
    if (run !== state.traceRun) return;     // settings changed again; a newer run takes over
    const frame = state.frames[index];
    if (!frame) continue;
    if (frame.traceKey !== key) {
      setStatus(`Tracing ${done + 1} / ${count}…`);
      frame.trace = traceFrame(frame, settings);
      frame.traceKey = key;
      frame.cleanPreview = null;
      frame.laser = buildLaserFrame(frame.trace, settings, [0, 0]);
      if (index === state.current) render();
      await nextTick();
    }
    done++;
  }
  if (run !== state.traceRun) return;
  rebuildAllLaserFrames();
  setStatus('');
  render();
}

let retraceDelay = null;
function scheduleRetrace() {
  clearTimeout(retraceDelay);
  retraceDelay = setTimeout(retraceAllFrames, 120);   // wait until the slider stops moving
}

/** Rebuilds every laser frame in order, each starting where the previous one ended. */
function rebuildAllLaserFrames() {
  const settings = readSettings();
  let beamPosition = [0, 0];
  for (const frame of state.frames) {
    frame.laser = frame.trace ? buildLaserFrame(frame.trace, settings, beamPosition) : null;
    if (frame.laser) beamPosition = frame.laser.endPosition;
  }
}

const allFramesReady = () => state.frames.length > 0 && state.frames.every(f => f.laser);

// ---------------------------------------------------------------------------
// Loading and removing frames
// ---------------------------------------------------------------------------

async function addFrameFiles(files) {
  const images = [...files].filter(file => file.type.startsWith('image/'));
  if (!images.length) return;
  setStatus('Loading images…');

  for (const file of images) {
    try {
      const bitmap = await createImageBitmap(file);
      state.frames.push({ name: file.name, bitmap, thumbUrl: URL.createObjectURL(file) });
    } catch (error) {
      console.warn('Could not read', file.name, error);
    }
  }
  // Natural sort, so "frame2" comes before "frame10".
  state.frames.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

  // Suggest a file name from the frames, e.g. "Fox_001.jpg" -> "Fox".
  const fileName = $('#fileName');
  if (fileName.value === 'laser-animation' && state.frames[0]) {
    const base = state.frames[0].name.replace(/\.[^.]+$/, '').replace(/[-_ ]*\d+$/, '');
    if (base) fileName.value = base;
  }

  $('#examplesGroup').open = false;          // make room once real frames are in
  render();
  retraceAllFrames();
}

/** Loads the built-in fox animation from sample-fox.js. */
function loadSampleAnimation() {
  const files = SAMPLE_FRAMES.map(({ name, base64 }) => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], name, { type: 'image/jpeg' });
  });
  return addFrameFiles(files);
}

function removeFrame(index) {
  URL.revokeObjectURL(state.frames[index].thumbUrl);
  state.frames.splice(index, 1);
  state.current = Math.min(state.current, Math.max(0, state.frames.length - 1));
  rebuildAllLaserFrames();
  render();
}

function clearAllFrames() {
  setPlaying(false);
  state.frames.forEach(frame => URL.revokeObjectURL(frame.thumbUrl));
  state.frames = [];
  state.current = 0;
  render();
}

// ---------------------------------------------------------------------------
// Drawing the previews
// ---------------------------------------------------------------------------

function setStatus(text) { $('#status').textContent = text; }

/** Left preview: the original picture, or the cleaned ink mask that actually gets traced. */
function renderSource() {
  const frame = state.frames[state.current];
  if (!frame) return;
  const canvas = $('#sourceCanvas'), ctx = canvas.getContext('2d');
  const showCleaned = $('#sourceView').value === 'clean' && frame.trace;
  const w = showCleaned ? frame.trace.width : frame.bitmap.width;
  const h = showCleaned ? frame.trace.height : frame.bitmap.height;
  const scale = 400 / Math.max(w, h);
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  ctx.imageSmoothingEnabled = !showCleaned;   // keep the mask's pixels crisp

  if (showCleaned) {
    if (!frame.cleanPreview) frame.cleanPreview = maskToCanvas(frame.trace.mask, w, h);
    ctx.drawImage(frame.cleanPreview, 0, 0, canvas.width, canvas.height);
  } else {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(frame.bitmap, 0, 0, canvas.width, canvas.height);
  }
  if (readSettings().autoThreshold && frame.trace) {
    $('output[for=threshold]').textContent = 'auto ' + frame.trace.threshold;
  }
}

function maskToCanvas(mask, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(width, height);
  for (let i = 0; i < mask.length; i++) {
    const shade = mask[i] ? 20 : 245;
    image.data[4 * i] = image.data[4 * i + 1] = image.data[4 * i + 2] = shade;
    image.data[4 * i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** Right preview: simulates what the laser draws, with a soft glow. */
function renderLaser() {
  const canvas = $('#laserCanvas'), ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#14181d';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);

  const settings = readSettings();
  // ILDA units -> canvas pixels (ILDA y points up, canvas y points down).
  const toX = x => (x / 65536 + 0.5) * W;
  const toY = y => (0.5 - y / 65536) * H;
  const showCanvas = $('#showCanvas').checked;
  const box = wallCanvasBox(settings);
  const boxLeft = toX(box.left), boxTop = toY(box.top);
  const boxWidth = toX(box.right) - boxLeft, boxHeight = toY(box.bottom) - boxTop;

  // Outside the wall canvas: tinted like the glass on either side of the wall.
  if (showCanvas) {
    ctx.fillStyle = 'rgba(70, 95, 130, 0.3)';
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.rect(boxLeft, boxTop, boxWidth, boxHeight);
    ctx.fill('evenodd');
  }

  const frame = state.frames[state.current];
  if (frame && $('#showOverlay').checked) {
    const toLaser = pictureToLaser(frame.bitmap.width, frame.bitmap.height, settings);
    const [left, top] = toLaser([0, 0]);
    const [right, bottom] = toLaser([frame.bitmap.width, frame.bitmap.height]);
    ctx.globalAlpha = 0.25;
    ctx.drawImage(frame.bitmap, toX(left), toY(top), toX(right) - toX(left), toY(bottom) - toY(top));
    ctx.globalAlpha = 1;
  }
  if (frame && frame.laser) drawLaserPoints(ctx, frame.laser.points, toX, toY);

  // The canvas outline goes on top, so it's visible even under bright lines.
  if (showCanvas) {
    const outside = frame && frame.laser && frame.laser.outsideCount > 0;
    ctx.setLineDash([10, 8]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = outside ? 'rgba(255, 93, 93, 0.9)' : 'rgba(255, 255, 255, 0.5)';
    ctx.strokeRect(boxLeft, boxTop, boxWidth, boxHeight);
    ctx.setLineDash([]);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.font = '20px system-ui, sans-serif';
    ctx.fillText(outside ? 'Wall canvas: art goes outside!' : 'Wall canvas', boxLeft + 8, boxTop + 26);
  }
}

/** Draws one laser frame's points onto the preview: jumps, glowing lines, dots. */
function drawLaserPoints(ctx, points, toX, toY) {
  // Beam-off jumps as faint dashed lines.
  if ($('#showJumps').checked) {
    ctx.setLineDash([4, 5]);
    ctx.strokeStyle = 'rgba(255,255,255,.28)';
    ctx.beginPath();
    for (let i = 1; i < points.length; i++) {
      if (!points[i].blank) continue;
      ctx.moveTo(toX(points[i - 1].x), toY(points[i - 1].y));
      ctx.lineTo(toX(points[i].x), toY(points[i].y));
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Lit lines, drawn three times (wide+faint to thin+bright) for a glow.
  // Each segment takes the colour of the point it travels to, like a real laser.
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const [lineWidth, alpha] of [[7, 0.18], [3, 0.35], [1.4, 1]]) {
    ctx.lineWidth = lineWidth;
    let i = 1;
    while (i < points.length) {
      if (points[i].blank) { i++; continue; }
      const p = points[i];
      ctx.strokeStyle = `rgba(${p.r},${p.g},${p.b},${alpha})`;
      ctx.beginPath();
      ctx.moveTo(toX(points[i - 1].x), toY(points[i - 1].y));
      // Keep extending the line while the colour stays the same.
      while (i < points.length && !points[i].blank &&
             points[i].r === p.r && points[i].g === p.g && points[i].b === p.b) {
        ctx.lineTo(toX(points[i].x), toY(points[i].y));
        i++;
      }
      ctx.stroke();
    }
  }
  ctx.globalCompositeOperation = 'source-over';

  if ($('#showPoints').checked) {
    for (const p of points) {
      ctx.fillStyle = p.blank ? 'rgba(255,255,255,.35)' : '#fff';
      ctx.fillRect(toX(p.x) - 1, toY(p.y) - 1, 2, 2);
    }
  }
}

/** The chips under the laser preview: line and point counts, flicker warnings. */
function renderStats() {
  const frame = state.frames[state.current];
  const box = $('#stats');
  if (!frame || !frame.laser) { box.innerHTML = ''; return; }

  const settings = readSettings();
  const laser = frame.laser;
  const redrawHz = settings.scanRate / laser.points.length;
  const chip = (label, value, level = '') => `<span class="stat ${level}">${label} <b>${value}</b></span>`;

  let html = chip('Lines', laser.lineCount) +
             chip('Points', laser.points.length) +
             chip('Beam-off points', laser.blankedCount) +
             chip('Redraw', redrawHz.toFixed(0) + ' Hz', redrawHz < 20 ? 'bad' : redrawHz < 30 ? 'warn' : '');
  if (!laser.fitsBudget) {
    html += chip('⚠', 'Too detailed to fit Max points. Raise Simplify or Min line length', 'bad');
  } else if (laser.spacing > settings.pointSpacing * 1.5) {
    html += chip('Note', 'Points spread out to fit Max points', 'warn');
  }
  // The fox sample has ~40 lines per frame and plays well, so warn a bit above that.
  if (laser.outsideCount > 0) {
    html += chip('⚠', 'Some lines are outside the wall canvas. Turn on "Fit art inside the wall canvas" or lower Size', 'bad');
  }
  if (laser.lineCount > 60) html += chip('⚠', `${laser.lineCount} separate lines. Lots of jumps will look dim`, 'warn');
  box.innerHTML = html;
}

/** Thumbnail strip under the previews. */
function renderFilmstrip() {
  const strip = $('#filmstrip');
  strip.innerHTML = '';
  state.frames.forEach((frame, index) => {
    const thumb = document.createElement('div');
    thumb.className = 'thumb' + (index === state.current ? ' current' : '');
    thumb.title = frame.name;
    const pointCount = frame.laser ? frame.laser.points.length : '…';
    thumb.innerHTML =
      `<img alt=""><div class="caption"><b>${index + 1}</b> · ${pointCount} pts</div>` +
      `<button class="remove" title="Remove frame">×</button>`;
    thumb.querySelector('img').src = frame.thumbUrl;
    thumb.onclick = () => { state.current = index; render(); };
    thumb.querySelector('.remove').onclick = event => { event.stopPropagation(); removeFrame(index); };
    strip.appendChild(thumb);
  });
}

function renderExportSummary() {
  const box = $('#exportSummary');
  if (!allFramesReady()) { box.textContent = state.frames.length ? 'Tracing…' : ''; return; }
  const settings = readSettings();
  const pointsPerLoop = state.frames.reduce((sum, f) => sum + f.laser.points.length, 0);
  const framesInFile = state.frames.length * settings.holdFrames;
  const seconds = pointsPerLoop * settings.holdFrames / settings.scanRate;
  const bytes = ILDA_HEADER_BYTES * (framesInFile + 1) + ILDA_POINT_BYTES * pointsPerLoop * settings.holdFrames;
  box.textContent = `${framesInFile} frames in file · ~${(bytes / 1024).toFixed(0)} KB · ` +
                    `one loop ≈ ${seconds.toFixed(2)} s at ${settings.scanRate / 1000}k pts/s`;
}

/** Redraws everything that depends on the current state. */
function render() {
  const count = state.frames.length;
  $('#views').hidden = count === 0;
  $('#emptyMessage').hidden = count > 0;
  $('#frameCount').textContent = count ? `${count} frame${count > 1 ? 's' : ''} loaded` : 'No frames yet';
  $('#clearButton').disabled = count === 0;
  $('#playButton').disabled = count < 2;
  $('#exportButton').disabled = !allFramesReady();

  const slider = $('#frameSlider');
  slider.max = Math.max(0, count - 1);
  slider.value = state.current;
  slider.disabled = count < 2;
  $('#frameLabel').textContent = count ? `${state.current + 1} / ${count}` : '–';

  // Show only the settings that apply right now.
  $('#stubRow').hidden = $('#artStyle').value === 'outline';
  $('#colorRow').hidden = $('#colorMode').value !== 'solid';
  $('#threshold').disabled = $('#autoThreshold').checked;
  $('#canvasShape').textContent = describeCanvasShape(readSettings());

  renderSource();
  renderLaser();
  renderStats();
  renderFilmstrip();
  renderExportSummary();
}

// ---------------------------------------------------------------------------
// Playback and export
// ---------------------------------------------------------------------------

function showFrame(index) {
  state.current = index;
  $('#frameSlider').value = index;
  $('#frameLabel').textContent = `${index + 1} / ${state.frames.length}`;
  renderLaser();
  renderSource();
  renderStats();
  document.querySelectorAll('.thumb').forEach((thumb, i) => thumb.classList.toggle('current', i === index));
}

function setPlaying(on) {
  state.playing = on;
  clearInterval(state.playTimer);
  $('#playButton').textContent = on ? '❚❚ Pause' : '▶ Play';
  if (!on) return;
  state.playTimer = setInterval(() => {
    if (state.frames.length < 2) return setPlaying(false);
    showFrame((state.current + 1) % state.frames.length);
  }, 1000 / Number($('#previewFps').value));
}

function downloadIldaFile() {
  if (!allFramesReady()) return;
  rebuildAllLaserFrames();
  const bytes = writeIldaFile(state.frames, readSettings().holdFrames);
  const name = ($('#fileName').value.trim() || 'laser-animation')
    .replace(/[\\/:*?"<>|]/g, '_')       // characters Windows doesn't allow in file names
    .replace(/\.ild$/i, '') + '.ild';

  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
}

// ---------------------------------------------------------------------------
// Wiring up the page
// ---------------------------------------------------------------------------

/** Shows a slider's value next to it, formatted by its <output data-format>. */
function showSliderValue(input) {
  const output = document.querySelector(`output[for="${input.id}"]`);
  if (!output) return;
  const value = Number(input.value);
  const formats = {
    percent: v => v + '%',
    thousands: v => (v / 1000) + 'k',
    times: v => v + '×',
    px: v => v + 'px',
  };
  output.textContent = (formats[output.dataset.format] || String)(value);
}

function setUpControls() {
  document.querySelectorAll('input[type=range]').forEach(input => {
    showSliderValue(input);
    input.addEventListener('input', () => showSliderValue(input));
  });

  // Settings: re-trace or just rebuild the laser points, depending on data-stage.
  document.querySelectorAll('[data-stage]').forEach(input => {
    input.addEventListener('input', () => {
      if (input.dataset.stage === 'trace') { render(); scheduleRetrace(); }
      else { rebuildAllLaserFrames(); render(); }
    });
  });

  // Uploading: click, keyboard, or drag and drop anywhere on the page.
  const dropZone = $('#dropZone'), fileInput = $('#fileInput');
  dropZone.onclick = () => fileInput.click();
  dropZone.onkeydown = event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileInput.click(); }
  };
  fileInput.onchange = () => { addFrameFiles(fileInput.files); fileInput.value = ''; };
  for (const target of [dropZone, document.body]) {
    target.addEventListener('dragover', event => { event.preventDefault(); dropZone.classList.add('over'); });
    target.addEventListener('dragleave', () => dropZone.classList.remove('over'));
    target.addEventListener('drop', event => {
      event.preventDefault();
      dropZone.classList.remove('over');
      addFrameFiles(event.dataTransfer.files);
    });
  }

  $('#sampleButton').onclick = loadSampleAnimation;
  $('#clearButton').onclick = clearAllFrames;
  $('#frameSlider').oninput = event => { state.current = Number(event.target.value); render(); };
  $('#playButton').onclick = () => setPlaying(!state.playing);
  $('#previewFps').addEventListener('input', () => { if (state.playing) setPlaying(true); });
  for (const id of ['#showJumps', '#showPoints', '#showOverlay', '#showCanvas']) $(id).onchange = renderLaser;
  document.querySelectorAll('[data-remember]').forEach(input => input.addEventListener('input', rememberSettings));
  $('#resetCanvasButton').onclick = resetWallCanvas;
  $('#sourceView').onchange = renderSource;
  $('#exportButton').onclick = downloadIldaFile;

  // Keyboard: ← → step through frames, space plays/pauses.
  document.addEventListener('keydown', event => {
    if (event.target.matches('input[type=text], select')) return;
    const count = state.frames.length;
    if (!count) return;
    if (event.key === 'ArrowRight') { state.current = (state.current + 1) % count; render(); }
    else if (event.key === 'ArrowLeft') { state.current = (state.current - 1 + count) % count; render(); }
    else if (event.key === ' ' && event.target === document.body) { event.preventDefault(); setPlaying(!state.playing); }
  });
}

restoreSettings();
setUpControls();
render();

// Handles for automated tests and debugging from the browser console.
window.LaserFrameStudio = { state, addFrameFiles, loadSampleAnimation, readSettings, rebuildAllLaserFrames, writeIldaFile };
