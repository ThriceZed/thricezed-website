// Mobile nav toggle
const navToggle = document.querySelector('.nav-toggle');
const navLinks = document.querySelector('.nav-links');

if (navToggle) {
  navToggle.addEventListener('click', () => {
    navToggle.classList.toggle('open');
    navLinks.classList.toggle('open');
  });

  navLinks.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', () => {
      navToggle.classList.remove('open');
      navLinks.classList.remove('open');
    });
  });
}

// GSAP scroll reveal for anything marked .reveal
if (window.gsap) {
  gsap.registerPlugin(ScrollTrigger);

  gsap.utils.toArray('.reveal').forEach((el) => {
    gsap.to(el, {
      opacity: 1,
      y: 0,
      duration: 0.9,
      ease: 'power3.out',
      scrollTrigger: {
        trigger: el,
        start: 'top 85%',
      },
    });
  });

  // Hero headline line-by-line reveal
  gsap.to('.hero h1 .line', {
    opacity: 1,
    y: 0,
    duration: 0.9,
    stagger: 0.15,
    ease: 'power3.out',
  });

  gsap.to('.hero-eyebrow, .hero p.sub, .hero-actions', {
    opacity: 1,
    y: 0,
    duration: 0.8,
    delay: 0.6,
    stagger: 0.15,
    ease: 'power3.out',
  });
} else {
  // GSAP failed to load (e.g. offline) — reveal everything instantly instead of staying hidden
  document.querySelectorAll('.reveal, .hero-eyebrow, .hero p.sub, .hero-actions, .hero h1 .line')
    .forEach((el) => {
      el.style.opacity = 1;
      el.style.transform = 'none';
    });
}

// Hero logo animation: force playback explicitly rather than relying solely on
// the autoplay attribute. Safari in particular can silently refuse to autoplay
// even muted+playsinline video, so fall back to starting it on the very first
// interaction anywhere on the page, not just a click on the video itself.
const heroVideo = document.querySelector('.hero-visual video');
if (heroVideo) {
  heroVideo.muted = true;
  heroVideo.playsInline = true;

  const tryPlay = () => heroVideo.play().catch(() => {});
  tryPlay();

  // Harmless if autoplay already succeeded — play() on a playing video is a no-op
  const unlockEvents = ['click', 'touchstart', 'scroll', 'keydown'];
  const unlock = () => {
    tryPlay();
    unlockEvents.forEach((evt) => document.removeEventListener(evt, unlock));
  };
  unlockEvents.forEach((evt) => document.addEventListener(evt, unlock, { passive: true }));
}
