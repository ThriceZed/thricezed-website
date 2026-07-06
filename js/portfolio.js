// Reads portfolio-links.txt (plain text, one YouTube link per line) and
// fills each portfolio slot in order. Blank or missing lines show "Coming Soon".

function extractYouTubeId(url) {
  const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

function parseLinksFile(text) {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .map((line) => line.trim());
}

function fillSlot(slotEl, link) {
  const placeholder = slotEl.querySelector('.portfolio-placeholder');
  const videoId = link ? extractYouTubeId(link) : null;

  if (!videoId) {
    if (placeholder) placeholder.textContent = 'Coming Soon';
    return;
  }

  slotEl.innerHTML = `<iframe src="https://www.youtube.com/embed/${videoId}" title="ThriceZed portfolio video" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe>`;
}

document.addEventListener('DOMContentLoaded', () => {
  const slots = document.querySelectorAll('.portfolio-item[data-slot]');
  if (!slots.length) return;

  fetch('portfolio-links.txt')
    .then((res) => (res.ok ? res.text() : Promise.reject(new Error('not found'))))
    .then((text) => {
      const links = parseLinksFile(text);
      slots.forEach((slotEl) => {
        const index = Number(slotEl.dataset.slot) - 1;
        fillSlot(slotEl, links[index]);
      });
    })
    .catch(() => {
      slots.forEach((slotEl) => fillSlot(slotEl, null));
    });
});
