/*
 * welcome.js — the quick start guide pop-up (#welcomeDialog).
 *
 * It opens when the page loads, so new people see how the app works before
 * anything else. Untick "Show this when the page opens" and this browser
 * remembers not to. "? Quick start" in the header (and the button on the empty
 * page) open it again any time.
 *
 * Buttons inside it marked data-close (Let's go, Draw right here, Try the fox
 * sample) close it first, then do their own job. Esc or a click outside closes it too.
 */
'use strict';

const WELCOME_KEY = 'laserFrameStudio.hideWelcome';   // "1" = don't open on start

function openWelcome() {
  const dialog = document.getElementById('welcomeDialog');
  if (!dialog.open) dialog.showModal();
}

function setUpWelcome() {
  const dialog = document.getElementById('welcomeDialog');
  const showOnStart = document.getElementById('welcomeShowOnStart');

  let hidden = false;
  try { hidden = localStorage.getItem(WELCOME_KEY) === '1'; } catch (error) { /* storage blocked: just show it */ }
  showOnStart.checked = !hidden;
  showOnStart.onchange = () => {
    try {
      if (showOnStart.checked) localStorage.removeItem(WELCOME_KEY);
      else localStorage.setItem(WELCOME_KEY, '1');
    } catch (error) { /* storage blocked: it will just show next time */ }
  };

  // Close on data-close buttons (before their own click handlers run) and on the dark area outside.
  dialog.addEventListener('click', event => {
    if (event.target === dialog || event.target.closest('[data-close]')) dialog.close();
  }, true);

  document.getElementById('guideSampleButton').addEventListener('click', loadSampleAnimation);
  document.getElementById('quickStartButton').onclick = openWelcome;
  document.getElementById('emptyGuideButton').onclick = openWelcome;
  document.getElementById('emptySampleButton').onclick = loadSampleAnimation;
  document.getElementById('emptyDrawButton').onclick = showDrawPad;

  if (!hidden) openWelcome();
}

setUpWelcome();
