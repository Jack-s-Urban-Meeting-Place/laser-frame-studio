/*
 * laser-videos.js — "See it on the wall" videos in Examples & tips.
 *
 * Each button plays a video of a real laser animation on the JUMP wall in the
 * main area, instead of the how-to guide (or the previews, or the drawing pad).
 * The buttons are toggles: click again (or "Close video") to go back to what was
 * there before.
 *
 * To add a video: put the file in examples/videos/ and add a line to LASER_VIDEOS.
 * The videos are big, so they are left out of the GitHub copy (see .gitignore).
 * If a file is missing, the page says so instead of breaking.
 */
'use strict';

/** The videos: button label, file in examples/videos/, and a short caption. */
const LASER_VIDEOS = [
  { label: 'Cello',   file: 'cello.mov',   caption: 'Cello, filmed from the middle of the plaza.' },
  { label: 'Bubbles', file: 'bubbles.mov', caption: 'Bubbles, filmed from the middle of the plaza (zoomed in).' },
  { label: 'Circle',  file: 'circle.mov',  caption: 'Circle, filmed from the middle of the plaza.' },
  { label: 'Wave',    file: 'wave.mov',    caption: 'Wave, filmed from the middle of the plaza.' },
  { label: 'Worm',    file: 'worm.mov',    caption: 'Worm, filmed from the middle of the plaza.' },
];
const VIDEO_FOLDER = 'examples/videos/';

/** Which main-area view was showing before the video, so closing it goes back there. */
let viewBeforeVideo = null;
let currentVideoButton = null;

function openLaserVideo(video, button) {
  const view = document.getElementById('videoView');
  if (view.hidden) {
    // Remember what was showing, then hide it.
    viewBeforeVideo = ['studioView', 'drawView'].find(id => !document.getElementById(id).hidden) || 'studioView';
    if (viewBeforeVideo === 'drawView' && pad.playTimer) stopDrawPlayback();
    if (state.playing) setPlaying(false);
    document.getElementById(viewBeforeVideo).hidden = true;
    view.hidden = false;
  }
  if (currentVideoButton) currentVideoButton.setAttribute('aria-pressed', 'false');
  currentVideoButton = button;
  button.setAttribute('aria-pressed', 'true');

  const player = document.getElementById('laserVideo');
  document.getElementById('videoTitle').textContent = `On the wall: ${video.label}`;
  document.getElementById('videoNote').textContent = video.caption;
  player.src = VIDEO_FOLDER + video.file;
  player.play().catch(() => {});      // some browsers wait for a click on the video; that's fine
}

/** Hides the video and shows whatever was in the main area before. */
function closeLaserVideo() {
  const view = document.getElementById('videoView');
  if (view.hidden) return;
  const player = document.getElementById('laserVideo');
  player.pause();
  player.removeAttribute('src');
  player.load();                       // lets go of the file
  view.hidden = true;
  document.getElementById(viewBeforeVideo || 'studioView').hidden = false;
  if (currentVideoButton) currentVideoButton.setAttribute('aria-pressed', 'false');
  currentVideoButton = null;
}

function setUpLaserVideos() {
  const holder = document.getElementById('videoButtons');
  for (const video of LASER_VIDEOS) {
    const button = document.createElement('button');
    button.textContent = '▶ ' + video.label;
    button.setAttribute('aria-pressed', 'false');
    button.onclick = () => (button === currentVideoButton ? closeLaserVideo() : openLaserVideo(video, button));
    holder.appendChild(button);
  }
  document.getElementById('videoCloseButton').onclick = closeLaserVideo;

  document.getElementById('laserVideo').addEventListener('error', () => {
    if (document.getElementById('videoView').hidden) return;
    document.getElementById('videoNote').textContent =
      "This video can't play here. It may not be included in this copy of the app (the videos are " +
      'left out of the GitHub download to keep it small), or this browser may not play .mov files. Try Chrome or Edge.';
  });

  // Starting real work (loading frames, opening the pad…) closes the video first,
  // so people see what they just asked for. 'true' = run before the button's own action.
  const closeFirst = ['#openDrawPadButton', '#sidebarOpenIldaButton', '#sampleButton', '#dropZone', '#guideDrawButton',
                      '#guideSampleButton', '#emptySampleButton', '#emptyDrawButton'];
  document.querySelectorAll(closeFirst.join(',')).forEach(element => element.addEventListener('click', closeLaserVideo, true));
  document.body.addEventListener('drop', closeLaserVideo, true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeLaserVideo(); });
}

setUpLaserVideos();
