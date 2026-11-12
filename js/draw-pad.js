/*
 * draw-pad.js — the drawing pad: draw laser lines right in the browser.
 *
 * The pad works on the same frames as the studio (state.frames in app.js). Each
 * frame has two layers:
 *   - uploaded: a picture or .ild frame added in "1 Draw or upload frames". The pad
 *     shows it underneath, exactly as the laser will draw it, so Tracing, Color and
 *     Scale & position (in the sidebar) change what you see here too. It can be sent
 *     to the laser along with your lines, or used only as a guide to trace over.
 *   - drawn: your pen strokes, on top. Each stroke is kept as a real line (a list
 *     of points plus a colour), not as pixels, and goes straight to the laser (see
 *     traceDrawing() in trace-frame.js). It lands exactly where you drew it.
 * The pad covers the wall canvas exactly (its shape follows the Wall canvas
 * settings), so what you see is where it goes on the wall.
 *
 * Features, kept simple on purpose:
 *   - a few bright laser colours (line thickness is fixed: the laser has one width)
 *   - pen, eraser (removes whole drawn lines), undo, clear
 *   - onion skin: faint copies of the drawn lines on the frames before (and after),
 *     and of the first frame (for loops that lead back to the start)
 *   - frames: copy to the next frame, add a blank frame, delete, step back and forward
 *   - a quick play preview
 *
 * The drawn lines are autosaved in this browser, so a page reload doesn't lose them
 * (uploaded pictures are not saved). Loaded after app.js, and uses its state,
 * wallSpace, makeFrame(), readSettings(), uploadedLinesOnWall() and friends.
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
const UPLOAD_LINE_WIDTH = 3;           // uploaded lines are drawn a little thinner, so your own lines stand out
const MIN_POINT_GAP = 2;               // ignore pen movements smaller than this (pad pixels)
const ERASER_RADIUS = 12;              // how close the eraser must come to a line to remove it
const CLOSE_LOOP_DISTANCE = 12;        // a stroke ending this close to its start becomes a closed loop
const ONION_BEFORE_COLOR = '159, 180, 255';   // faint blue: frames before this one
const ONION_AFTER_COLOR = '255, 179, 107';    // faint orange: the frame after this one
const ONION_FIRST_COLOR = '120, 255, 200';    // faint mint: frame 1, so a loop can lead back to it
const MAX_UNDO = 60;
const DRAFT_KEY = 'laserFrameStudio.drawing';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const pad = {
  // The pad's size is the drawing space (wallSpace in app.js), and its frames are
  // the studio's frames, so there is only ever one copy of each.
  get width() { return wallSpace.width; },
  set width(value) { wallSpace.width = value; },
  get height() { return wallSpace.height; },
  set height(value) { wallSpace.height = value; },
  get frames() { return state.frames; },

  current: 0,
  tool: 'pen',                 // 'pen' | 'eraser'
  color: DRAW_COLORS[3].rgb,   // green
  activeStroke: null,          // the stroke being drawn right now
  erasing: false,
  undo: [],                    // [{ frameIndex, strokes }] snapshots taken before each change
  playTimer: null,
  stripTimer: null,            // waits for sidebar sliders to settle before redrawing every small picture
};

const padCanvas = () => document.getElementById('drawCanvas');
const padIsOpen = () => !document.getElementById('drawView').hidden;
const currentDrawFrame = () => pad.frames[pad.current];
const rgbText = (rgb, alpha = 1) => `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
const copyStrokes = strokes => strokes.map(s => ({ rgb: s.rgb.slice(), pts: s.pts.map(p => p.slice()), closed: s.closed }));
const checked = id => document.getElementById(id).checked;

/** Call after a frame's drawn lines change, so the studio and the small picture update. */
function markFrameChanged(frame) {
  frame.strokesVersion++;
  frame.thumb = null;
}

// ---------------------------------------------------------------------------
// Drawing onto a canvas
// ---------------------------------------------------------------------------

/**
 * Draws pen strokes onto a 2D context. `scale` shrinks them for thumbnails.
 * `style` picks the look: 'laser' (glowing, for the pad) or a ghost colour
 * string for the onion skin.
 */
function drawStrokes(ctx, strokes, scale, style, alpha = 1) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1, LINE_WIDTH * scale);
  for (const stroke of strokes) {
    const color = style === 'laser' ? rgbText(stroke.rgb, alpha) : `rgba(${style}, ${alpha})`;
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

/** Draws laser paths ({ pts, closed, color }, in pad pixels): the uploaded layer. */
function drawLaserPaths(ctx, paths, scale, alpha, width) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1, width * scale);
  for (const path of paths) {
    ctx.strokeStyle = rgbText(path.color, alpha);
    ctx.beginPath();
    path.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * scale, y * scale) : ctx.moveTo(x * scale, y * scale)));
    if (path.closed) ctx.closePath();
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * The frame's uploaded layer, under the drawing: the original picture (if asked),
 * then its laser lines. Both are placed by the sidebar's Scale & position, so they
 * sit exactly where the laser will draw them.
 */
function drawUploadedLayer(ctx, frame) {
  const settings = readSettings();
  const strength = Number(document.getElementById('uploadStrength').value) / 100;
  if (frame.bitmap && checked('uploadShowPicture')) {
    const toLaser = pictureToLaser(frame.bitmap.width, frame.bitmap.height, settings);
    const toPad = laserToWallSpace(pad.width, pad.height, settings);
    const [left, top] = toPad(toLaser([0, 0]));
    const [right, bottom] = toPad(toLaser([frame.bitmap.width, frame.bitmap.height]));
    ctx.save();
    ctx.globalAlpha = strength;
    // Light lines on dark: white paper turns dark, so the pad stays dark like the wall.
    if (checked('uploadInvert')) ctx.filter = 'invert(1)';
    ctx.fillStyle = '#fff';                 // transparent pictures count as white paper
    ctx.fillRect(left, top, right - left, bottom - top);
    ctx.drawImage(frame.bitmap, left, top, right - left, bottom - top);
    ctx.restore();
  }
  if (checked('uploadShowLines')) {
    drawLaserPaths(ctx, uploadedLinesOnWall(frame, settings), 1, strength, UPLOAD_LINE_WIDTH);
  }
}

/** Redraws the pad: background, uploaded layer, onion skin, then the current frame's drawn lines. */
function renderPad() {
  const canvas = padCanvas(), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#050608';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const frame = currentDrawFrame();
  if (!frame) return;
  drawUploadedLayer(ctx, frame);

  if (!pad.playTimer) {
    // Onion skin: earlier frames fade the further back they are.
    const before = Number(document.getElementById('onionBefore').value);
    for (let k = before; k >= 1; k--) {
      const other = pad.frames[pad.current - k];
      if (other) drawStrokes(ctx, other.strokes, 1, ONION_BEFORE_COLOR, 0.45 * (1 - (k - 1) / before));
    }
    const next = pad.frames[pad.current + 1];
    if (checked('onionAfter') && next) drawStrokes(ctx, next.strokes, 1, ONION_AFTER_COLOR, 0.4);
    // The first frame, for loops. Skipped if it's already showing as one of the "frames before".
    const firstAlreadyShown = pad.current - before <= 0;
    if (checked('onionFirst') && pad.current > 0 && !firstAlreadyShown) {
      drawStrokes(ctx, pad.frames[0].strokes, 1, ONION_FIRST_COLOR, 0.4);
    }
  }
  drawStrokes(ctx, frame.strokes, 1, 'laser');

  document.getElementById('drawFrameLabel').textContent = `Frame ${pad.current + 1} of ${pad.frames.length}`;
  document.getElementById('padUseUploads').checked = checked('useUploads');
  updateUploadInfo();
  document.getElementById('drawUndoButton').disabled = pad.undo.length === 0;
  document.getElementById('drawDeleteButton').disabled = pad.frames.length < 2;
}

/** "Under this frame: fox_03.jpg", so people know what they're tracing over. */
function updateUploadInfo() {
  const frame = currentDrawFrame();
  const uploads = pad.frames.filter(hasUpload).length;
  document.getElementById('uploadInfo').textContent =
    !uploads ? 'Nothing uploaded yet. Add pictures or a .ild file in "1 Draw or upload frames".'
    : hasUpload(frame) ? `Under this frame: ${frame.name}`
    : 'No upload under this frame.';
}

/**
 * Re-draws the strip of small frame pictures under the pad. Each picture is
 * cached on its frame (frame.thumb) and only redrawn after that frame changes,
 * so files with hundreds of frames stay quick.
 */
function renderDrawStrip() {
  const strip = document.getElementById('drawStrip');
  strip.innerHTML = '';
  const scale = 56 / pad.width;
  const settings = readSettings();
  pad.frames.forEach((frame, index) => {
    const button = document.createElement('button');
    button.className = 'draw-thumb' + (index === pad.current ? ' current' : '');
    button.title = `Frame ${index + 1}` + (frame.name ? `: ${frame.name}` : '');
    if (!frame.thumb) {
      frame.thumb = document.createElement('canvas');
      frame.thumb.width = 56;
      frame.thumb.height = Math.round(pad.height * scale);
      const ctx = frame.thumb.getContext('2d');
      ctx.fillStyle = '#050608';
      ctx.fillRect(0, 0, frame.thumb.width, frame.thumb.height);
      drawLaserPaths(ctx, uploadedLinesOnWall(frame, settings), scale, 0.5, UPLOAD_LINE_WIDTH);
      drawStrokes(ctx, frame.strokes, scale, 'laser');
    }
    button.append(frame.thumb, Object.assign(document.createElement('span'), { textContent: index + 1 }));
    button.onclick = () => goToDrawFrame(index);
    strip.appendChild(button);
  });
}

/** After a change to the current frame: redraw the pad and the strip, then autosave. */
function refreshPad() {
  markFrameChanged(currentDrawFrame());     // changes always happen on the current frame
  renderPad();
  renderDrawStrip();
  saveDraft();
}

/**
 * Called by app.js whenever the studio redraws (a sidebar setting changed, a
 * picture finished tracing…), so the uploaded layer on the pad follows along.
 */
function renderPadIfOpen() {
  if (!padIsOpen()) return;
  renderPad();
  // The small pictures show uploaded lines too. Redraw them once the sliders stop moving.
  clearTimeout(pad.stripTimer);
  pad.stripTimer = setTimeout(() => {
    pad.frames.forEach(frame => { frame.thumb = null; });
    renderDrawStrip();
  }, 300);
}

/** Called by app.js after frames were added or removed in the studio. */
function padFrameListChanged() {
  pad.undo = [];                            // undo steps point at frame numbers, which just moved
  pad.current = Math.max(0, Math.min(pad.current, pad.frames.length - 1));
  saveDraft();
  if (!padIsOpen()) return;
  if (!pad.frames.length) state.frames.push(makeFrame());
  renderPad();
  renderDrawStrip();
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

/** Removes every drawn line on this frame that passes within ERASER_RADIUS of point p. */
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
  pad.frames.splice(pad.current + 1, 0, makeFrame());
  pad.undo = [];
  pad.current++;
  refreshPad();
}

/**
 * Copies this frame's drawn lines to the next frame: the quickest way to animate
 * small changes. If the next frame already has drawn lines (or there is no next
 * frame), a new frame is added for the copy. A next frame that only has an
 * upload gets the copy on top, so tracing along a set of pictures stays lined up.
 */
function copyFrame() {
  const lines = copyStrokes(currentDrawFrame().strokes);
  const next = pad.frames[pad.current + 1];
  if (next && !next.strokes.length) {
    next.strokes = lines;
  } else {
    pad.frames.splice(pad.current + 1, 0, makeFrame({ strokes: lines }));
    pad.undo = [];
  }
  pad.current++;
  refreshPad();
}

function deleteFrame() {
  if (pad.frames.length < 2) return;
  const frame = currentDrawFrame();
  const losing = [frame.strokes.length && 'its drawn lines', hasUpload(frame) && 'its uploaded picture'].filter(Boolean);
  if (losing.length && !confirm(`Delete frame ${pad.current + 1} and ${losing.join(' and ')}? This can't be undone.`)) return;
  if (frame.thumbUrl) URL.revokeObjectURL(frame.thumbUrl);
  pad.frames.splice(pad.current, 1);
  pad.undo = [];
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

/** Removes every drawn line (asks first). Uploaded frames stay. */
function startNewDrawing() {
  if (!pad.frames.some(f => f.strokes.length)) return;
  if (!confirm('Remove all the lines you drew, on every frame? Uploaded frames stay.')) return;
  pad.frames.forEach(frame => { frame.strokes = []; markFrameChanged(frame); });
  // Frames with nothing left in them go too, but there's always at least one.
  state.frames = state.frames.filter(hasUpload);
  if (!state.frames.length) state.frames.push(makeFrame());
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
// Size and autosave
// ---------------------------------------------------------------------------

/** The pad size (in pad pixels) that has the same shape as the wall canvas. */
function wallCanvasPadSize() {
  const settings = readSettings();
  const ratio = settings.canvasWidth / settings.canvasHeight || 1;   // width ÷ height; about 0.63 for the JUMP wall
  // Tall walls: 600 wide. Wide walls: 600 tall. So the pad never gets huge.
  return ratio <= 1
    ? { width: PAD_WIDTH, height: Math.round(PAD_WIDTH / ratio) }
    : { width: Math.round(PAD_WIDTH * ratio), height: PAD_WIDTH };
}

/**
 * If the wall canvas shape changed since these lines were drawn, reshapes the pad
 * to match. The drawn lines are scaled evenly (never stretched) and centred, so they fit.
 * Returns true if anything changed.
 */
function matchPadToWallCanvas() {
  const { width, height } = wallCanvasPadSize();
  if (width === pad.width && height === pad.height) { fitPadOnScreen(); return false; }
  const scale = Math.min(width / pad.width, height / pad.height);
  const shiftX = (width - pad.width * scale) / 2, shiftY = (height - pad.height * scale) / 2;
  const move = ([x, y]) => [shiftX + x * scale, shiftY + y * scale];
  for (const frame of pad.frames) {
    frame.strokes.forEach(stroke => { stroke.pts = stroke.pts.map(move); });
    markFrameChanged(frame);
  }
  pad.undo.forEach(entry => entry.strokes.forEach(stroke => { stroke.pts = stroke.pts.map(move); }));
  pad.width = width;
  pad.height = height;
  padCanvas().width = width;
  padCanvas().height = height;
  fitPadOnScreen();
  saveDraft();
  return true;
}

/**
 * Sizes the pad on screen: as big as fits, always in its true shape so nothing
 * looks stretched. On computer screens the app is a fixed 16:9 frame, so the pad
 * gets the height left over in its column after the toolbar, frame strip and hint.
 * On narrow screens (the page scrolls) it's at most about 2/3 of the window height.
 */
function fitPadOnScreen() {
  const canvas = padCanvas();
  const area = canvas.parentElement;
  if (!area || !padIsOpen()) return;
  const availableWidth = area.clientWidth;
  let availableHeight = Math.min(window.innerHeight * 0.68, 900);
  if (window.matchMedia('(min-width: 901px)').matches) {
    let others = 0;
    for (const child of area.children) if (child !== canvas) others += child.offsetHeight;
    availableHeight = Math.max(160, area.clientHeight - others - 20);   // 20 = the gaps between them
  }
  const scale = Math.min(availableWidth / pad.width, availableHeight / pad.height);
  canvas.style.width = Math.floor(pad.width * scale) + 'px';
  canvas.style.height = Math.floor(pad.height * scale) + 'px';
}

/** Saves every frame's drawn lines (not the uploads) in this browser. */
function saveDraft() {
  const round = n => Math.round(n * 10) / 10;
  const frames = pad.frames.map(f => f.strokes.map(s => ({ rgb: s.rgb, closed: s.closed, pts: s.pts.map(([x, y]) => [round(x), round(y)]) })));
  while (frames.length && !frames[frames.length - 1].length) frames.pop();   // empty frames at the end aren't worth keeping
  try {
    if (frames.length) localStorage.setItem(DRAFT_KEY, JSON.stringify({ width: pad.width, height: pad.height, frames }));
    else localStorage.removeItem(DRAFT_KEY);
  } catch (error) { /* storage full or blocked: keep going */ }
}

/** Brings back drawn lines saved last time, as frames (re-upload pictures to put them underneath). */
function loadDraft() {
  let draft = null;
  try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch (error) { /* nothing saved */ }
  if (draft && Array.isArray(draft.frames) && draft.frames.length && !state.frames.length) {
    pad.width = draft.width;
    pad.height = draft.height;
    state.frames = draft.frames.map(strokes => makeFrame({ strokes }));
  }
  padCanvas().width = pad.width;
  padCanvas().height = pad.height;
  matchPadToWallCanvas();
  if (state.frames.length) { rebuildAllLaserFrames(); render(); }
}

// ---------------------------------------------------------------------------
// Switching between the studio and the drawing pad
// ---------------------------------------------------------------------------

function showDrawPad() {
  setPlaying(false);
  if (!state.frames.length) state.frames.push(makeFrame());
  pad.current = Math.max(0, Math.min(currentFrameIndex(), pad.frames.length - 1));   // start on the frame the studio was showing
  document.getElementById('studioView').hidden = true;
  document.getElementById('drawView').hidden = false;
  matchPadToWallCanvas();                   // follow the wall canvas shape
  renderPad();
  renderDrawStrip();
  fitPadOnScreen();                         // after the strip is drawn, so its height is known
}

/** Back to the laser preview, showing the frame that was on the pad. */
function showStudio() {
  if (pad.playTimer) stopDrawPlayback();
  document.getElementById('drawView').hidden = true;
  document.getElementById('studioView').hidden = false;
  // Nothing drawn and nothing uploaded: back to the empty "how to" page.
  if (state.frames.every(frame => !hasUpload(frame) && !frame.strokes.length)) state.frames = [];
  rebuildAllLaserFrames();
  const position = state.playList.findIndex(entry => entry.kind === 'drawn' && entry.frameIndex === pad.current);
  state.position = Math.max(0, position);
  render();
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
  on('drawDoneButton', showStudio);
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

  // Opening .ild files (from the pad's toolbar or the sidebar): they're uploads, like pictures.
  const ildaInput = document.getElementById('ildaFileInput');
  on('drawOpenIldaButton', () => ildaInput.click());
  on('sidebarOpenIldaButton', () => ildaInput.click());
  ildaInput.onchange = () => { if (ildaInput.files.length) addFrameFiles(ildaInput.files); ildaInput.value = ''; };

  for (const id of ['onionBefore', 'onionAfter', 'onionFirst', 'uploadShowLines', 'uploadShowPicture', 'uploadInvert']) {
    document.getElementById(id).onchange = renderPad;
  }
  document.getElementById('uploadStrength').addEventListener('input', renderPad);

  // "Use with Export" on the pad is the same setting as the one in the sidebar.
  document.getElementById('padUseUploads').onchange = event => {
    const sidebarBox = document.getElementById('useUploads');
    sidebarBox.checked = event.target.checked;
    sidebarBox.dispatchEvent(new Event('input'));       // rebuilds the laser frames like any other setting
  };

  document.getElementById('drawFps').onchange = () => { if (pad.playTimer) { stopDrawPlayback(); startDrawPlayback(); } };

  // The drawing space follows the wall canvas: reshape it (and the drawn lines) when
  // the Wall canvas Width or Height slider is let go, or reset. 'change' fires when
  // the slider is let go; reshaping on every tiny move would wear the drawing down.
  const reshape = () => {
    if (!matchPadToWallCanvas()) return;
    rebuildAllLaserFrames();
    render();
    if (padIsOpen()) renderDrawStrip();
  };
  for (const id of ['canvasWidth', 'canvasHeight']) document.getElementById(id).addEventListener('change', reshape);
  document.getElementById('resetCanvasButton').addEventListener('click', reshape);
  window.addEventListener('resize', () => { if (padIsOpen()) fitPadOnScreen(); });

  // Keyboard on the pad: Ctrl+Z undo, ← → change frame.
  document.addEventListener('keydown', event => {
    if (!padIsOpen() || event.target.matches('input, select')) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undoLastChange(); }
    else if (event.key === 'ArrowLeft') goToDrawFrame(pad.current - 1);
    else if (event.key === 'ArrowRight') goToDrawFrame(pad.current + 1);
  });

  loadDraft();
}

setUpDrawPad();
