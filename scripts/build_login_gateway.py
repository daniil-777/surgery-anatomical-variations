"""Build only a sign-in redirect for GitHub Pages, never the unprotected studio."""
import argparse
import html
import json
from pathlib import Path
from urllib.parse import urlsplit


def build(out: Path, origin: str):
    parsed = urlsplit(origin)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.path not in {"", "/"} or parsed.query or parsed.fragment):
        raise ValueError("The studio origin must be an HTTPS origin without credentials or a path.")
    if out.exists() and any(out.iterdir()):
        raise ValueError("Use an empty output directory so no unprotected app files can survive.")
    out.mkdir(parents=True, exist_ok=True)
    login = origin.rstrip("/") + "/auth/login"
    document = f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>Sign in · Viscera Studio</title>
<style>body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#eaf3e2;color:#213b2c;font:18px system-ui,sans-serif}}main{{max-width:34rem;padding:2rem}}h1{{font-size:2rem}}a{{color:inherit;text-underline-offset:4px}}p{{line-height:1.6}}</style>
</head><body><main><h1>Viscera Studio</h1><p>Sign in to enter your workspace.</p>
<p><a id="signin" href="{html.escape(login, quote=True)}">Continue to sign in</a></p>
<p id="status" role="status" aria-live="polite">Checking the studio…</p>
<button id="retry" type="button" hidden>Try again</button>
<p><a href="https://daniil-777.github.io/generation-lab/">Open 2D / 3D Generation Lab</a></p></main>
<script src="/surgery-anatomical-variations/gateway.js"></script></body></html>'''
    script = f'''const destination = new URL({json.dumps(login)});
const prefix = '/surgery-anatomical-variations';
const route = location.pathname.startsWith(prefix + '/') ? location.pathname.slice(prefix.length) : '/';
const next = route + location.search;
destination.searchParams.set('next', next);
document.querySelector('#signin').href = destination.href;
let attempt = 0;
let retryTimer;
function checkStudio() {{
  const current = ++attempt;
  clearTimeout(retryTimer);
  const status = document.querySelector('#status');
  const retry = document.querySelector('#retry');
  status.textContent = 'Checking the studio…';
  retry.hidden = true;
  // A public login image verifies a real response without CORS privileges,
  // authentication cookies, or navigating away from the working gateway.
  const probe = new Image();
  probe.referrerPolicy = 'no-referrer';
  let finished = false;
  const finish = (online) => {{
    if (finished || current !== attempt) return;
    finished = true;
    clearTimeout(timeout);
    if (online) {{
      location.replace(destination.href);
    }} else {{
      status.textContent = 'The studio is temporarily unavailable. We will try again shortly.';
      retry.hidden = false;
      retryTimer = setTimeout(checkStudio, 30000);
    }}
  }};
  const timeout = setTimeout(() => finish(false), 8000);
  probe.onload = () => finish(true);
  probe.onerror = () => finish(false);
  probe.src = new URL('/auth/ui/mark.svg?availability=' + Date.now(), destination).href;
}}
document.querySelector('#retry').addEventListener('click', checkStudio);
checkStudio();
'''
    (out / "index.html").write_text(document)
    (out / "404.html").write_text(document)
    (out / "gateway.js").write_text(script)
    (out / ".nojekyll").touch()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--origin", required=True)
    args = parser.parse_args()
    build(args.out, args.origin)
