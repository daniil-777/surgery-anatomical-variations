#!/usr/bin/env bash
# One Ubuntu 24.04 (x86_64) box → the VISCERA web app with HTTPS. Idempotent; run as a sudo-capable user:
#   curl -fsSL https://raw.githubusercontent.com/daniil-777/surgery-anatomical-variations/main/deploy/server/setup.sh | bash -s -- [SITE_HOST]
# or, after cloning the repository yourself:  bash deploy/server/setup.sh [SITE_HOST]
# SITE_HOST defaults to <public-ip>.sslip.io (Let's Encrypt issues for it; use your domain when you have one).
set -euo pipefail
REPO="${VISCERA_REPO:-https://github.com/daniil-777/surgery-anatomical-variations.git}"
DIR="${VISCERA_DIR:-$HOME/viscera}"
SITE_HOST="${1:-}"
if [ -z "$SITE_HOST" ]; then
  IP=$(curl -4 -fsS https://api.ipify.org || curl -4 -fsS https://ifconfig.me)
  SITE_HOST="${IP}.sslip.io"
fi
echo "== site host: $SITE_HOST"

# 1. Docker from Docker's repository (the distro package is older), compose plugin included
if ! command -v docker >/dev/null; then
  APT='sudo apt-get -o DPkg::Lock::Timeout=600'   # cloud-init may still hold the dpkg lock minutes after first boot
  $APT update
  $APT install -y --no-install-recommends ca-certificates curl gnupg git
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  $APT update
  $APT install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo usermod -aG docker "$USER" || true
fi

# 2. Firewall: SSH, HTTP, HTTPS. Oracle's Ubuntu images carry iptables rules that reject everything but SSH and
#    persist them in /etc/iptables/rules.v4; Hetzner images come open. Both end up with the same three ports.
if [ -f /etc/iptables/rules.v4 ] && command -v netfilter-persistent >/dev/null; then
  for p in 80 443; do
    sudo iptables -C INPUT -p tcp --dport $p -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 6 -p tcp --dport $p -m state --state NEW -j ACCEPT
  done
  sudo iptables -C INPUT -p udp --dport 443 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 6 -p udp --dport 443 -j ACCEPT
  sudo netfilter-persistent save
elif command -v ufw >/dev/null; then
  sudo ufw allow OpenSSH >/dev/null; sudo ufw allow 80/tcp >/dev/null; sudo ufw allow 443 >/dev/null
  sudo ufw --force enable >/dev/null
fi

# 3. The code: clone or update. While the repository is private, pass a token in the URL
#    (VISCERA_REPO=https://<token>@github.com/daniil-777/surgery-anatomical-variations.git) or clone it yourself over SSH first.
if [ ! -d "$DIR/.git" ]; then git clone --depth 1 "$REPO" "$DIR"; else git -C "$DIR" pull --ff-only; fi

# 4. Build and run (the first build takes 10–20 minutes: torch CPU wheels, the pinned Qwen base, the Vite build)
cd "$DIR/deploy/server"
CORES=$(nproc)
cat > .env <<ENV
SITE_HOST=$SITE_HOST
PAGES_ORIGIN=https://daniil-777.github.io
OMP_THREADS=$CORES
ENV
sudo docker compose build
sudo docker compose up -d
echo "== building and starting; follow with: sudo docker compose -f $DIR/deploy/server/docker-compose.yml logs -f app"
echo "== then: https://$SITE_HOST/   and   python scripts/probe_web_app.py https://$SITE_HOST"
