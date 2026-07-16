// Custom play/pause-only control for the software showcase video

const TTSP_THUMBNAIL_TIME = 13.23;

document.addEventListener('DOMContentLoaded', () => {
  const video = document.getElementById('ttsp-video');
  const toggle = document.getElementById('ttsp-video-toggle');
  if (!video || !toggle) return;

  const iconPlay = toggle.querySelector('.icon-play');
  const iconPause = toggle.querySelector('.icon-pause');

  const showPauseIcon = () => {
    iconPlay.style.display = 'none';
    iconPause.style.display = '';
    toggle.setAttribute('aria-label', 'Pause video');
  };

  const showPlayIcon = () => {
    iconPlay.style.display = '';
    iconPause.style.display = 'none';
    toggle.setAttribute('aria-label', 'Play video');
  };

  toggle.addEventListener('click', () => {
    if (video.paused) {
      video.play();
    } else {
      video.pause();
    }
  });

  video.addEventListener('play', showPauseIcon);
  video.addEventListener('pause', showPlayIcon);
  video.addEventListener('ended', () => {
    showPlayIcon();
    video.currentTime = TTSP_THUMBNAIL_TIME;
  });
});
