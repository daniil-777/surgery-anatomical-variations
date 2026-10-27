import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';

function fixture(origin = 'https://fixture.example') {
  const output = mkdtempSync(path.join(tmpdir(), 'viscera-gateway-'));
  execFileSync('python3', ['scripts/build_login_gateway.py', '--out', output, '--origin', origin]);
  const source = readFileSync(path.join(output, 'gateway.js'), 'utf8');
  const html = readFileSync(path.join(output, 'index.html'), 'utf8');
  assert.deepEqual(readdirSync(output).sort(), ['.nojekyll', '404.html', 'gateway.js', 'index.html']);
  rmSync(output, { recursive: true });
  const images = [], redirects = [], timers = new Map();
  let timerId = 0;
  const elements = Object.fromEntries(['#signin', '#status', '#retry'].map(id => [id, { addEventListener(event, fn) { this[event] = fn; } }]));
  vm.runInNewContext(source, {
    URL, Date,
    location: { pathname: '/surgery-anatomical-variations/tissues.html', search: '?mode=scene&scene=virtamed', replace: href => redirects.push(href) },
    document: { querySelector: id => elements[id] },
    Image: class { constructor() { images.push(this); } },
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout: id => timers.delete(id),
  });
  return { images, redirects, elements, timers, html };
}

test('changing the destination loads a new script URL instead of a cached redirect', () => {
  const before = fixture();
  const after = fixture('https://replacement.example');
  const scriptUrl = html => html.match(/<script src="([^"]+)"/)[1];
  assert.notEqual(scriptUrl(before.html), scriptUrl(after.html));
  after.images[0].onload();
  assert.equal(new URL(after.redirects[0]).origin, 'https://replacement.example');
});

test('a healthy studio preserves the requested workspace through login', () => {
  const f = fixture();
  assert.equal(f.redirects.length, 0);
  assert.match(f.images[0].src, /^https:\/\/fixture.example\/auth\/ui\/mark.svg/);
  f.images[0].onload();
  const destination = new URL(f.redirects[0]);
  assert.equal(destination.pathname, '/auth/login');
  assert.equal(destination.searchParams.get('next'), '/tissues.html?mode=scene&scene=virtamed');
});

test('a failed studio keeps the working entry page and retries automatically', () => {
  const f = fixture();
  f.images[0].onerror();
  assert.equal(f.redirects.length, 0);
  assert.equal(f.elements['#retry'].hidden, false);
  assert.match(f.elements['#status'].textContent, /temporarily unavailable/);
  [...f.timers.values()].find(t => t.ms === 30000).fn();
  f.images[1].onload();
  assert.equal(f.redirects.length, 1);
});

test('timeouts and stale probe responses cannot navigate to a dead endpoint', () => {
  const f = fixture();
  [...f.timers.values()].find(t => t.ms === 8000).fn();
  f.images[0].onload();
  assert.equal(f.redirects.length, 0);
  f.elements['#retry'].click();
  f.images[1].onerror();
  assert.equal(f.redirects.length, 0);
});
