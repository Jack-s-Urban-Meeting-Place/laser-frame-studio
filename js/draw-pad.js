/*
 * draw-pad.js — "Draw an animation": draw frames right in the browser.
 *
 * People draw one frame at a time on a dark pad that looks like the laser wall.
 * Each pen stroke is kept as a real line (a list of points plus a colour), not
 * as pixels. So when the drawing is sent to the laser, the strokes become laser
 * lines directly (see traceDrawing() in trace-frame.js). No picture tracing is
 * needed, and the lines come out exactly as drawn.
 *
 * Features, kept simple on purpose:
 *   - a few bright laser colours (line thickness is fixed: the laser has one width)
 *   - pen, eraser (removes whole lines), undo, clear
 *   - onion skin: faint copies of the previous (and optionally next) frames,
 *     so each new frame can be drawn a little further along
 *   - frames: add a blank frame, copy this frame, delete, step back and forward
 *   - a quick play preview
 *   - "Use these frames on the laser" hands the frames to the studio (app.js)
 *
 * The drawing is autosaved in this browser, so a page reload doesn't lose it.
 * Loaded after app.js, and uses its loadDrawnFrames() and readSettings().
 */
'use strict';

// ---------------------------------------------------------------------------
// Settings you might want to change
// ---------------------------------------------------------------------------

/** Bright colours that show up well on the laser. Black can't be drawn by a laser. */
const DRAW_COLORS = [
  { name: 'Red',    rgb: [255, 40, 40] },
  { name: 'Orange', rgb: [255, 140, 0] },
  { name: 'Yellow', rgb: [255, 230, 0] },
  { name: 'Green',  rgb: [0, 255, 64] },
  { name: 'Cyan',   rgb: [0, 229, 255] },
  { name: 'Blue',   rgb: [40, 90, 255] },
  { name: 'Purple', rgb: [176, 75, 255] },
  { name: 'Pink',   rgb: [255, 60, 200] },
  { name: 'White',  rgb: [255, 255, 255] },
];

const PAD_WIDTH = 600;                 // drawing size in pad pixels; the height follows the wall canvas shape
const LINE_WIDTH = 5;                  // every line is this thick: the laser only has one line width
const MIN_POINT_GAP = 2;               // ignore pen movements smaller than this (pad pixels)
const ERASER_RADIUS = 12;              // how close the eraser must come to a line to remove it
const CLOSE_LOOP_DISTANCE = 12;        // a stroke ending this close to its start becomes a closed loop
const ONION_BEFORE_COLOR = '159, 180, 255';   // faint blue: frames before this one
const ONION_AFTER_COLOR = '255, 179, 107';    // faint orange: the frame after this one
const MAX_UNDO = 60;
const DRAFT_KEY = 'laserFrameStudio.drawing';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const pad = {
  width: PAD_WIDTH,
  height: 900,
  frames: [{ strokes: [] }],   // each stroke: { rgb: [r, g, b], pts: [[x, y], …], closed }
  current: 0,
  tool: 'pen',                 // 'pen' | 'eraser'
  color: DRAW_COLORS[3].rgb,   // green
  activeStroke: null,          // the stroke being drawn right now
  erasing: false,
  undo: [],                    // [{ frameIndex, strokes }] snapshots taken before each change
  playTimer: null,
};

const padCanvas = () => document.getElementById('drawCanvas');
const currentDrawFrame = () => pad.frames[pad.current];
const rgbText = (rgb, alpha = 1) => `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
const copyStrokes = strokes => strokes.map(s => ({ rgb: s.rgb.slice(), pts: s.pts.map(p => p.slice()), closed: s.closed }));

// ---------------------------------------------------------------------------
// Drawing strokes onto a canvas
// ---------------------------------------------------------------------------

/**
 * Draws strokes onto a 2D context. `scale` shrinks them for thumbnails.
 * `style` picks the look: 'laser' (glowing, for the pad), 'paper' (on white, for
 * the studio's source view) or a ghost colour string for the onion skin.
 */
function drawStrokes(ctx, strokes, scale, style, alpha = 1) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1, LINE_WIDTH * scale);
  for (const stroke of strokes) {
    const color = style === 'laser' || style === 'paper' ? rgbText(stroke.rgb, alpha) : `rgba(${style}, ${alpha})`;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.shadowColor = style === 'laser' ? color : 'transparent';
    ctx.shadowBlur = style === 'laser' ? 8 * scale : 0;
    const pts = stroke.pts;
    if (pts.length === 1) {                 // a tap makes a dot
      ctx.beginPath();
      ctx.arc(pts[0][0] * scale, pts[0][1] * scale, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(pts[0][0] * scale, pts[0][1] * scale);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * scale, pts[i][1] * scale);
    if (stroke.closed) ctx.closePath();
    ctx.stroke();
  }
  ctx.restore();
}

/** Redraws the pad: background, onion skin, then the current frame. */
function renderPad() {
  const canvas = padCanvas(), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#050608';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!pad.playTimer) {
    // Onion skin: earlier frames fade the further back they are.
    const before = Number(document.getElementById('onionBefore').value);
    for (let k = before; k >= 1; k--) {
      const frame = pad.frames[pad.current - k];
      if (frame) drawStrokes(ctx, frame.strokes, 1, ONION_BEFORE_COLOR, 0.45 * (1 - (k - 1) / before));
    }
    const next = pad.frames[pad.current + 1];
    if (document.getElementById('onionAfter').checked && next) drawStrokes(ctx, next.strokes, 1, ONION_AFTER_COLOR, 0.4);
  }
  drawStrokes(ctx, currentDrawFrame().strokes, 1, 'laser');

  document.getElementById('drawFrameLabel').textContent = `Frame ${pad.current + 1} of ${pad.frames.length}`;
  document.getElementById('drawUndoButton').disabled = pad.undo.length === 0;
  document.getElementById('drawDeleteButton').disabled = pad.frames.length < 2;
}

/** Re-draws the small frame pictures under the pad. */
function renderDrawStrip() {
  const strip = document.getElementById('drawStrip');
  strip.innerHTML = '';
  const scale = 56 / pad.width;
  pad.frames.forEach((frame, index) => {
    const button = document.createElement('button');
    button.className = 'draw-thumb' + (index === pad.current ? ' current' : '');
    button.title = `Frame ${index + 1}`;
    const thumb = document.createElement('canvas');
    thumb.width = 56;
    thumb.height = Math.round(pad.height * scale);
    const ctx = thumb.getContext('2d');
    ctx.fillStyle = '#050608';
    ctx.fillRect(0, 0, thumb.width, thumb.height);
    drawStrokes(ctx, frame.strokes, scale, 'laser');
    button.append(thumb, Object.assign(document.createElement('span'), { textContent: index + 1 }));
    button.onclick = () => goToDrawFrame(index);
    strip.appendChild(button);
  });
}

function refreshPad() {
  renderPad();
  renderDrawStrip();
  saveDraft();
}

// ---------------------------------------------------------------------------
// Pen and eraser
// ---------------------------------------------------------------------------

/** Pointer position in pad pixels (the canvas is shown smaller than its real size). */
function pointerToPad(event) {
  const rect = padCanvas().getBoundingClientRect();
  return [
    (event.clientX - rect.left) * pad.width / rect.width,
    (event.clientY - rect.top) * pad.height / rect.height,
  ];
}

function rememberForUndo() {
  pad.undo.push({ frameIndex: pad.current, strokes: copyStrokes(currentDrawFrame().strokes) });
  if (pad.undo.length > MAX_UNDO) pad.undo.shift();
}

/** Removes every line on this frame that passes within ERASER_RADIUS of point p. */
function eraseAt(p) {
  const frame = currentDrawFrame();
  const before = frame.strokes.length;
  frame.strokes = frame.strokes.filter(stroke => {
    const pts = stroke.closed ? stroke.pts.concat([stroke.pts[0]]) : stroke.pts;
    if (pts.length === 1) return distance(p, pts[0]) > ERASER_RADIUS;
    for (let i = 1; i < pts.length; i++) if (distanceToSegment(p, pts[i - 1], pts[i]) <= ERASER_RADIUS) return false;
    return true;
  });
  if (frame.strokes.length !== before) renderPad();
}

function startStroke(event) {
  if (pad.playTimer) stopDrawPlayback();
  // Keep receiving the pen's movements even if it slips off the edge of the pad.
  try { padCanvas().setPointerCapture(event.pointerId); } catch (error) { /* not supported: fine */ }
  const p = pointerToPad(event);
  rememberForUndo();
  if (pad.tool === 'eraser') {
    pad.erasing = true;
    eraseAt(p);
  } else {
    pad.activeStroke = { rgb: pad.color.slice(), pts: [p], closed: false };
    currentDrawFrame().strokes.push(pad.activeStroke);
    renderPad();
  }
}

function continueStroke(event) {
  if (pad.erasing) return eraseAt(pointerToPad(event));
  if (!pad.activeStroke) return;
  const p = pointerToPad(event);
  const pts = pad.activeStroke.pts;
  if (distance(p, pts[pts.length - 1]) < MIN_POINT_GAP) return;
  pts.push(p);
  renderPad();
}

function endStroke() {
  const stroke = pad.activeStroke;
  if (stroke && stroke.pts.length > 3) {
    // A stroke that ends where it started (a circle, a box) becomes a closed loop.
    const pts = stroke.pts;
    if (distance(pts[0], pts[pts.length - 1]) < CLOSE_LOOP_DISTANCE && pathLength(pts, false) > CLOSE_LOOP_DISTANCE * 4) {
      stroke.closed = true;
      pts.pop();
    }
    // Keep the shape, drop points that add nothing (smaller save, cleaner laser lines).
    stroke.pts = simplifyOpenPath(pts, 0.6);
  }
  const changed = stroke || pad.erasing;
  pad.activeStroke = null;
  pad.erasing = false;
  if (changed) refreshPad();
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

function goToDrawFrame(index) {
  pad.current = Math.max(0, Math.min(pad.frames.length - 1, index));
  renderPad();
  document.querySelectorAll('.draw-thumb').forEach((b, i) => b.classList.toggle('current', i === pad.current));
  document.querySelector('.draw-thumb.current')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function addBlankFrame() {
  pad.frames.splice(pad.current + 1, 0, { strokes: [] });
  pad.current++;
  refreshPad();
}

/** Copies this frame to a new frame after it: the quickest way to animate small changes. */
function copyFrame() {
  pad.frames.splice(pad.current + 1, 0, { strokes: copyStrokes(currentDrawFrame().strokes) });
  pad.current++;
  refreshPad();
}

function deleteFrame() {
  if (pad.frames.length < 2) return;
  if (currentDrawFrame().strokes.length && !confirm(`Delete frame ${pad.current + 1}? This can't be undone.`)) return;
  pad.frames.splice(pad.current, 1);
  pad.undo = pad.undo.filter(u => u.frameIndex !== pad.current).map(u => ({ ...u, frameIndex: u.frameIndex > pad.current ? u.frameIndex - 1 : u.frameIndex }));
  pad.current = Math.min(pad.current, pad.frames.length - 1);
  refreshPad();
}

function clearFrame() {
  if (!currentDrawFrame().strokes.length) return;
  rememberForUndo();
  currentDrawFrame().strokes = [];
  refreshPad();
}

function undoLastChange() {
  const last = pad.undo.pop();
  if (!last || !pad.frames[last.frameIndex]) return renderPad();
  pad.frames[last.frameIndex].strokes = last.strokes;
  pad.current = last.frameIndex;
  refreshPad();
}

/** Starts again with one empty frame (asks first). */
function startNewDrawing() {
  const hasLines = pad.frames.some(f => f.strokes.length);
  if (hasLines && !confirm('Start a new drawing? Your current frames will be cleared.')) return;
  setPadSize();
  pad.frames = [{ strokes: [] }];
  pad.current = 0;
  pad.undo = [];
  refreshPad();
}

// ---------------------------------------------------------------------------
// Play preview
// ---------------------------------------------------------------------------

function startDrawPlayback() {
  if (pad.frames.length < 2) return;
  const fps = Number(document.getElementById('drawFps').value);
  pad.playTimer = setInterval(() => goToDrawFrame((pad.current + 1) % pad.frames.length), 1000 / fps);
  document.getElementById('drawPlayButton').textContent = '❚❚ Stop';
  renderPad();
}

function stopDrawPlayback() {
  clearInterval(pad.playTimer);
  pad.playTimer = null;
  document.getElementById('drawPlayButton').textContent = '▶ Play';
  renderPad();
}

// ---------------------------------------------------------------------------
// Size, autosave, and handing frames to the studio
// ---------------------------------------------------------------------------

/** Makes the pad the same shape as the wall canvas (tall for the JUMP wall). */
function setPadSize() {
  const settings = readSettings();
  const ratio = settings.canvasWidth / settings.canvasHeight || 1;
  pad.width = PAD_WIDTH;
  pad.height = Math.round(PAD_WIDTH / ratio);
  const canvas = padCanvas();
  canvas.width = pad.width;
  canvas.height = pad.height;
}

function saveDraft() {
  const round = n => Math.round(n * 10) / 10;
  const draft = {
    width: pad.width, height: pad.height,
    frames: pad.frames.map(f => f.strokes.map(s => ({ rgb: s.rgb, closed: s.closed, pts: s.pts.map(([x, y]) => [round(x), round(y)]) }))),
  };
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch (error) { /* storage full or blocked: keep going */ }
}

function loadDraft() {
  let draft = null;
  try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch (error) { /* nothing saved */ }
  if (!draft || !Array.isArray(draft.frames) || !draft.frames.length) return setPadSize();
  pad.width = draft.width;
  pad.height = draft.height;
  pad.frames = draft.frames.map(strokes => ({ strokes }));
  padCanvas().width = pad.width;
  padCanvas().height = pad.height;
}

/** Turns the pad's frames into studio frames (with a paper-style picture for previews). */
async function sendDrawingToStudio() {
  const drawn = pad.frames.filter(f => f.strokes.length);
  if (!drawn.length) return alert('Draw something first!');
  const loaded = LaserFrameStudio.state.frames;
  const hasUploads = loaded.some(f => !f.drawing);
  if (hasUploads && !confirm(`This replaces the ${loaded.length} frame${loaded.length > 1 ? 's' : ''} already in the studio. Continue?`)) return;
  if (pad.playTimer) stopDrawPlayback();

  const frames = [];
  for (const [index, frame] of drawn.entries()) {
    const picture = document.createElement('canvas');
    picture.width = pad.width;
    picture.height = pad.height;
    const ctx = picture.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, pad.width, pad.height);
    drawStrokes(ctx, frame.strokes, 1, 'paper');
    const blob = await new Promise(resolve => picture.toBlob(resolve, 'image/png'));
    frames.push({
      name: `drawing_${String(index + 1).padStart(2, '0')}.png`,
      bitmap: await createImageBitmap(picture),
      thumbUrl: URL.createObjectURL(blob),
      drawing: { width: pad.width, height: pad.height, strokes: copyStrokes(frame.strokes) },
    });
  }
  showStudio();
  loadDrawnFrames(frames);
}

// ---------------------------------------------------------------------------
// Switching between the studio and the drawing pad
// ---------------------------------------------------------------------------

function showDrawPad() {
  setPlaying(false);
  document.getElementById('studioView').hidden = true;
  document.getElementById('drawView').hidden = false;
  refreshPad();
}

function showStudio() {
  if (pad.playTimer) stopDrawPlayback();
  document.getElementById('drawView').hidden = true;
  document.getElementById('studioView').hidden = false;
}

function setUpDrawPad() {
  // Colour swatches.
  const swatches = document.getElementById('drawColors');
  DRAW_COLORS.forEach(({ name, rgb }, index) => {
    const swatch = document.createElement('button');
    swatch.className = 'swatch' + (index === 3 ? ' current' : '');
    swatch.style.background = rgbText(rgb);
    swatch.title = name;
    swatch.setAttribute('aria-label', name);
    swatch.onclick = () => {
      pad.color = rgb;
      setTool('pen');
      swatches.querySelectorAll('.swatch').forEach(s => s.classList.toggle('current', s === swatch));
    };
    swatches.appendChild(swatch);
  });

  const setTool = tool => {
    pad.tool = tool;
    document.getElementById('drawPenButton').classList.toggle('current', tool === 'pen');
    document.getElementById('drawEraserButton').classList.toggle('current', tool === 'eraser');
    padCanvas().classList.toggle('erasing', tool === 'eraser');
  };

  const canvas = padCanvas();
  canvas.addEventListener('pointerdown', startStroke);
  canvas.addEventListener('pointermove', continueStroke);
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);

  const on = (id, handler) => { document.getElementById(id).onclick = handler; };
  on('openDrawPadButton', showDrawPad);
  on('guideDrawButton', showDrawPad);
  on('drawBackButton', showStudio);
  on('drawPenButton', () => setTool('pen'));
  on('drawEraserButton', () => setTool('eraser'));
  on('drawUndoButton', undoLastChange);
  on('drawClearButton', clearFrame);
  on('drawAddButton', addBlankFrame);
  on('drawCopyButton', copyFrame);
  on('drawDeleteButton', deleteFrame);
  on('drawPrevButton', () => goToDrawFrame(pad.current - 1));
  on('drawNextButton', () => goToDrawFrame(pad.current + 1));
  on('drawPlayButton', () => (pad.playTimer ? stopDrawPlayback() : startDrawPlayback()));
  on('drawNewButton', startNewDrawing);
  on('drawSendButton', sendDrawingToStudio);
  document.getElementById('onionBefore').onchange = renderPad;
  document.getElementById('onionAfter').onchange = renderPad;
  document.getElementById('drawFps').onchange = () => { if (pad.playTimer) { stopDrawPlayback(); startDrawPlayback(); } };

  // Keyboard on the pad: Ctrl+Z undo, ← → change frame.
  document.addEventListener('keydown', event => {
    if (document.getElementById('drawView').hidden || event.target.matches('input, select')) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undoLastChange(); }
    else if (event.key === 'ArrowLeft') goToDrawFrame(pad.current - 1);
    else if (event.key === 'ArrowRight') goToDrawFrame(pad.current + 1);
  });

  loadDraft();
}

setUpDrawPad();
