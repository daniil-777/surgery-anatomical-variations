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
        document = response.read(256_000)
        welcome = b'id="welcome-button"' in document
        if response.status != 200 or not (welcome or b'type="password"' in document):
            raise RuntimeError("Studio entrance is unavailable")
        if welcome and b'type="password"' in document:
            raise RuntimeError("Public entrance unexpectedly contains a password field")
    for path in ("/auth/session", "/static/api/atlas/catalog.json", "/models/joint-v2/model.json"):
        try:
            urllib.request.urlopen(origin + path, timeout=15).close()
        except urllib.error.HTTPError as error:
            if error.code == 401:
                continue
        raise RuntimeError(f"Authentication boundary failed for {path}")
    print("Studio entrance is healthy; assets require an entrance session.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", required=True)
    check(parser.parse_args().origin)
