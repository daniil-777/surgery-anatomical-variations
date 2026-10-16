# The whole studio on one Linux box (Hetzner, Oracle E6, any Ubuntu 24.04 x86 server)

`docs/HOSTING_OPTIONS.md` says which box and why. This folder runs the same Docker image as the Spaces/Fly package
behind Caddy, which obtains the HTTPS certificate itself. One command on a fresh Ubuntu 24.04 (x86_64) server:

```sh
git clone git@github.com:daniil-777/surgery-anatomical-variations.git ~/viscera   # SSH key or token: the repository is private
bash ~/viscera/deploy/server/setup.sh
```

It installs Docker, opens ports 80/443, builds the image (10–20 minutes the first time) and starts `app` + `caddy`.
(Once the repository is public, the one-liner `curl -fsSL https://raw.githubusercontent.com/daniil-777/surgery-anatomical-variations/main/deploy/server/setup.sh | bash` clones it too.) Without a domain it serves `https://<public-ip>.sslip.io`; pass your domain as the first
argument once its A record points at the server. Then:

```sh
python scripts/probe_web_app.py https://<host>          # every API feature, from anywhere
```

and point the public copy at it: set `{"api": "https://<host>"}` in the portfolio site's `anatomy/api.json`
(the container already allows `https://daniil-777.github.io`; change `PAGES_ORIGIN` in `.env` for another origin).

## Hetzner AX42 (bare metal, the fast choice)

1. Order AX42 at hetzner.com → Robot. In Robot, boot the Rescue System and run `installimage`: Ubuntu 24.04, software
   RAID 1 over the two NVMes, hostname of your choice. Reboot.
2. `ssh root@<ip>`, create a user with sudo (`adduser viscera && usermod -aG sudo viscera`), then clone and run the
   script as that user. Backups: `restic` to a Hetzner Storage Box, or snapshot `docker compose` volumes; bare metal has none.
3. Use all eight cores: `OMP_THREADS=8` is written by the script from `nproc`.

## Oracle Cloud VM.Standard.E6.Flex (the right Oracle shape)

1. Upgrade the tenancy to Pay-As-You-Go (billing → upgrade; a day or two, sometimes a ticket). Create an instance:
   shape **VM.Standard.E6.Flex**, 2 OCPU / 16 GB, image **Canonical Ubuntu 24.04**, boot volume 100 GB, a public IPv4.
   Do not pick the Always Free A1 shape for this app (ARM core 2–3× slower per request; see HOSTING_OPTIONS).
2. VCN → the subnet's security list → add ingress rules: TCP 80 and 443 from 0.0.0.0/0 (SSH 22 is there already).
3. `ssh ubuntu@<ip>`, clone and run the script. The script also opens the instance's own iptables (Oracle images reject
   everything but SSH by default) and persists the rules with `netfilter-persistent`.

## Operations

- Logs: `sudo docker compose logs -f app` in `deploy/server/`. Update: `git pull && sudo docker compose up -d --build`.
- The demo database inside the container is ephemeral by design (model administration is disabled on public servers).
- Memory: the image idles at ~2.5 GB and peaks near 4 GB; the compose limit is 12 GB.
- aarch64 boxes work too (the Dockerfile builds xatlas from source there), but they are slower per request; the
  recommendation is x86.
