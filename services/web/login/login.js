const form = document.querySelector('#login-form');
const username = document.querySelector('#username');
const password = document.querySelector('#password');
const toggle = document.querySelector('#toggle-password');
const feedback = document.querySelector('#form-feedback');
const submit = document.querySelector('#submit-login');
const label = document.querySelector('#submit-label');
const caps = document.querySelector('#caps-hint');
document.querySelector('#script-required').hidden = true;
let busy = false;
let retryTimer;
const next = new URLSearchParams(location.search).get('next') || '/';

toggle.addEventListener('click', () => {
  const show = password.type === 'password';
  password.type = show ? 'text' : 'password';
  toggle.setAttribute('aria-pressed', String(show));
  toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
});
for (const event of ['keyup', 'keydown']) password.addEventListener(event, e => {
  caps.hidden = !e.getModifierState('CapsLock');
});
password.addEventListener('blur', () => { caps.hidden = true; });
for (const input of [username, password]) input.addEventListener('input', () => {
  input.removeAttribute('aria-invalid');
  if (!busy && !retryTimer) feedback.textContent = '';
});
function setBusy(value) {
  busy = value;
  form.setAttribute('aria-busy', String(value));
  submit.disabled = value;
  username.readOnly = password.readOnly = value;
  label.textContent = value ? 'Signing in…' : 'Enter studio';
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || retryTimer || !form.reportValidity()) return;
  feedback.textContent = '';
  feedback.dataset.state = '';
  setBusy(true);
  try {
    const response = await fetch('/auth/login', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username.value, password: password.value, next }),
      signal: AbortSignal.timeout(12000),
    });
    if (response.status === 429) {
      let seconds = Math.min(120, Math.max(1, Number(response.headers.get('Retry-After')) || 60));
      setBusy(false);
      const tick = () => {
        submit.disabled = seconds > 0;
        feedback.textContent = seconds > 0 ? `Too many attempts. Try again in ${seconds--} seconds.` : 'You can try signing in again.';
        if (!submit.disabled) { clearInterval(retryTimer); retryTimer = undefined; }
      };
      tick(); retryTimer = setInterval(tick, 1000);
      return;
    }
    if (response.status === 401) {
      feedback.textContent = 'Username or password is incorrect. Please try again.';
      username.setAttribute('aria-invalid', 'true'); password.setAttribute('aria-invalid', 'true');
      password.value = ''; setBusy(false); password.focus(); return;
    }
    if (!response.ok) throw new Error('unavailable');
    const result = await response.json();
    const destination = new URL(result.next, location.origin);
    if (destination.origin !== location.origin) throw new Error('invalid redirect');
    password.value = '';
    feedback.dataset.state = 'success'; feedback.textContent = 'Signed in. Opening your workspace…';
    label.textContent = 'Opening studio…';
    location.replace(destination.href);
  } catch {
    setBusy(false);
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
