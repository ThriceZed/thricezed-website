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
