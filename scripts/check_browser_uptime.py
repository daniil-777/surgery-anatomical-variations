"""Public availability probe, with no authentication credentials or state changes."""
import argparse
import urllib.error
import urllib.request
from urllib.parse import urlsplit


def check(origin: str):
    parsed = urlsplit(origin)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise ValueError("Expected a public HTTPS origin")
    origin = origin.rstrip("/")
    with urllib.request.urlopen(origin + "/auth/login", timeout=15) as response:
        if response.status != 200 or b'type="password"' not in response.read(256_000):
            raise RuntimeError("Login form is unavailable")
    for path in ("/auth/session", "/static/api/atlas/catalog.json", "/models/joint-v2/model.json"):
        try:
            urllib.request.urlopen(origin + path, timeout=15).close()
        except urllib.error.HTTPError as error:
            if error.code == 401:
                continue
        raise RuntimeError(f"Authentication boundary failed for {path}")
    print("Public login is healthy; studio assets require authentication.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", required=True)
    check(parser.parse_args().origin)
