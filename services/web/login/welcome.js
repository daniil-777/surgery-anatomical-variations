const form = document.querySelector('#welcome-form');
const button = document.querySelector('#welcome-button');
const label = document.querySelector('#welcome-label');
const feedback = document.querySelector('#welcome-feedback');
document.querySelector('#script-required').hidden = true;
let busy = false;
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  button.disabled = true;
  form.setAttribute('aria-busy', 'true');
  feedback.textContent = '';
  label.textContent = 'Opening studio…';
  try {
    const next = new URLSearchParams(location.search).get('next') || '/';
    const response = await fetch('/auth/enter?next=' + encodeURIComponent(next), {
      method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error('unavailable');
    const result = await response.json();
    const destination = new URL(result.next, location.origin);
    if (destination.origin !== location.origin) throw new Error('invalid redirect');
    location.replace(destination.href);
  } catch {
    busy = false;
    button.disabled = false;
    form.setAttribute('aria-busy', 'false');
    label.textContent = 'Welcome';
    feedback.textContent = 'The studio could not be reached. Please try again.';
  }
});
// GIFs have no native pause API. A paused preview displays its recorded poster.
// Load animation only when allowed; no JavaScript also leaves useful stills.
const previews = [...document.querySelectorAll('.study img[data-motion-src]')];
const motionToggle = document.querySelector('#toggle-previews');
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
let playRequested = !motionPreference.matches;
function updatePreviews() {
  const playing = playRequested && !document.hidden;
  for (const img of previews) {
    const source = playing && !img.dataset.motionFailed ? img.dataset.motionSrc : img.dataset.poster;
    if (img.getAttribute('src') !== source) img.src = source;
  }
  motionToggle.setAttribute('aria-label', playRequested ? 'Pause previews' : 'Play previews');
  motionToggle.querySelector('.motion-label').textContent = playRequested ? 'Pause previews' : 'Play previews';
  motionToggle.querySelector('.motion-icon').textContent = playRequested ? 'Ⅱ' : '▶';
}
for (const img of previews) {
  img.addEventListener('load', () => {
    img.hidden = false;
    img.parentElement.classList.remove('image-unavailable');
  });
  const fallback = () => {
    if (img.getAttribute('src') === img.dataset.motionSrc) {
      img.dataset.motionFailed = 'true';
      img.src = img.dataset.poster;
    } else {
      img.hidden = true;
      img.parentElement.classList.add('image-unavailable');
    }
  };
  img.addEventListener('error', fallback);
  if (img.complete && !img.naturalWidth) fallback();
}
motionToggle.hidden = false;
motionToggle.addEventListener('click', () => { playRequested = !playRequested; updatePreviews(); });
motionPreference.addEventListener('change', event => { playRequested = !event.matches; updatePreviews(); });
document.addEventListener('visibilitychange', updatePreviews);
updatePreviews();
