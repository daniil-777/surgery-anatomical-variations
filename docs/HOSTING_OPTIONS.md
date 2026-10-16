# Where to run the VISCERA API so that it is fast (research, 2026-10-16)

The question was "Oracle Cloud? and which Linux", with a budget if it buys speed. The answer depends on what the app
spends its time on, so that came first.

## What the app's time is

Every slow route is single-threaded Python/NumPy; none of them uses more than one core, and only one uses torch.

| route | on the Mac | where the time goes | more cores | GPU |
| --- | --- | --- | --- | --- |
| physics experiment | 4 s (indent/cut 7–9 s) | 48 L-BFGS-B steps over a 311-tet cage: NumPy dispatch and Python overhead, tiny arrays | no | no |
| textured GLB / Unity export | 6 s cold, ~2–3 s warm | xatlas unwrap (C++, cached), then a Python loop over 30k–118k faces and a single-thread NumPy noise sampler | no | no |
| text command through the adapter | ~5 s | Qwen2.5-0.5B in float32 decoding token by token: memory-bandwidth bound | barely | yes, < 1 s |
| generate, joint flow, disease, material | 0.2 s | NumPy | no | no |

So the host is chosen by **single-core speed**, measured as Geekbench 6 single-core (the Mac that produced the numbers
sits at roughly 2,300–3,700 depending on the M generation). A GPU moves one route and nothing else.

## Ranking for this workload (two independent judges agreed on the top three)

| # | option | per-core speed vs the Mac | monthly | what the 4 s / 6 s / 5 s routes become | notes |
| --- | --- | --- | --- | --- | --- |
| 1 | **Hetzner AX42** dedicated (Ryzen 7 PRO 8700GE, 8c/16t Zen 4, 64 GB ECC, 2×512 GB NVMe, FSN1) | 0.9–1.1× (GB6 2,676–2,868 measured) | €97.30 ex-VAT ≈ $105 + €49 setup | 3.7–5.3 s / 5.5–8 s cold, 2–3 s warm / 5–7 s | the only option in the Mac's class; bare metal: you install Ubuntu, back it up yourself; monthly cancellable |
| 2 | **Oracle VM.Standard.E6.Flex** 2 OCPU (4 vCPU) / 16 GB, pay-as-you-go, eu-frankfurt-1 | 0.7–0.9× (EPYC 9J45 Turin, GB6 ~2,044–2,700) | $67.16 (price-list SKUs B111129/B111130, 2026-10-08) + ~$2 boot volume | 4.5–6 s / 7–9 s cold, ~3 s warm / 5.5–7.5 s | the right Oracle answer: x86, hourly, the Docker image runs unchanged; needs the tenancy upgraded to pay-as-you-go |
| 3 | **Netcup RS 2000 G12.5** (8 dedicated EPYC 9645 Turin cores, 16 GB, Nuremberg/Vienna) | 0.55–0.7× (GB6 1,540–2,110) | €39.33 net ≈ $42 (1-month term) | 6–7.5 s / 9–11 s cold, 3–4 s warm / 7–9 s | best dedicated-core value; contract with 31-day notice; RS 1000 (4 cores, 8 GB) at ≈ $23 is the same speed with tight RAM |
| 4 | Hetzner Cloud CPX42 / CPX32 (shared EPYC Genoa) | 0.6–0.75× quiet, worse under neighbours (GB6 1,927) | €69.49 ≈ $75 (CPX42) | 5.5–7 s / 8–10 s / 6.5–8.5 s, +30–50 % under load | easiest operations (API, snapshots); shared cores show as latency variance |
| 5 | Scaleway STANDARD3-X4C-16G (dedicated EPYC 9555P Turin) | probably 0.8–0.95×, **unverified** | ≈ $127 + storage/IP | like #2 if the clock holds | no public benchmark; Paris/Amsterdam only |
| 6 | Hetzner GEX45 (i5-13500 + RTX PRO 4000 24 GB, Helsinki) | CPU ~0.8–0.95×; GPU makes text < 1 s | €214 ≈ $231 + €209 setup | 4.2–5 s / 6.5–7.5 s / **0.3–0.8 s** | the one box fast on both axes; 2.2× an AX42 for one route; needs a CUDA torch build |

**Oracle Always Free is not it.** Its Ampere Altra core scores GB6 ~1,100 (two OCI runs in 2026), 2–3× slower than
the Mac per core: physics 9–13 s, textured export 13–20 s, text 11–17 s. Oracle also halved the free allowance to
2 OCPU / 12 GB in mid-2026, capacity errors are common, and over-allowance instances get reclaimed. It would make the
demo slower than the browser-only copy feels today.

**GPU verdict.** Worth it only for the text command, and even there the first lever is free: the adapter is loaded in
float32 "regardless of device"; loading it in bfloat16 on a CPU with AVX-512 BF16 (Turin, Genoa, Zen 4) halves the
bytes the decode reads. Measure that on the chosen box before paying for a GPU. If sub-second text is required anyway,
the cheapest sane shapes are a serverless GPU that wakes only for text (Modal L4 ≈ $15–30/month at a few hundred
requests a day, RunPod serverless ≈ $35) in front of a CPU host, not an always-on GPU box.

**Which Linux.** Ubuntu 24.04 LTS, x86_64, HWE kernel (or Debian 13; interchangeable here). Distro speed is noise
below 2 %: the app runs inside the python:3.11 image with its own userland, and the kernel only touches the TLS hop.
What matters is Docker from Docker's own repository, a recent kernel, and that every provider above offers the image.

## Recommendation

- Want the fastest app for the money: **Hetzner AX42** (`deploy/server/`, Hetzner notes). Expect the Mac's numbers.
- Want to stay on Oracle: **E6.Flex 2 OCPU / 16 GB pay-as-you-go**, not the free A1 (`deploy/server/`, Oracle notes).
- Want cheapest acceptable: **Netcup RS 2000 G12.5**; everything takes about 1.6× longer than on the Mac.

Then point the public copy at it (`anatomy/api.json`, docs/HOSTING.md) so the link everyone opens gets every service.

## Sources (220 collected; the ones the numbers rest on)

- Oracle price-list API `apexapps.oracle.com/pls/apex/cetools/api/v1/products/` (SKUs B111129/B111130 E6, B93297/B93298 A1; lastUpdated 2026-10-08); Oracle docs "Always Free Resources" (1,500 OCPU-h / 9,000 GB-h = 2 OCPU / 12 GB, read 2026-10-16); compute shapes doc (A1 Altra Q80-30 3.0 GHz; E6 EPYC 9J45).
- vpsbenchmarks YABS: OCI A1.Flex eu-frankfurt-1 GB6 single 1,106 (2026-06-12); A1 Chicago 1,102 (2026-07-24); OCI E6 plan page $67.16/mo (trial 2026-03-22); CPU table by Geekbench 6 (Neoverse-N1 1,050–1,100; Turin 2,200–2,700; Genoa 1,900–3,100).
- Geekbench Browser AX42 runs (2,676–2,868); Hetzner CPX42 run 1,927 (2026-01-17, NBG1); Netcup RS 2000 G12 Pro 1,708 (2026-09-30).
- Hetzner price adjustment page (15 Jun 2026) and dedicated matrix; agentdeals.dev hetzner-pricing-2026 (AX42 €97.30 + €49, checked 2026-10-07); Hetzner GEX45 press (2026-09-01, €214 + €209).
- netcup.com root-server page (RS 2000 G12.5 €40.70 incl. VAT on 2026-10-16) and netcupvoucher.com pricing table (2026-09-23).
- Phoronix "Oracle E6 AMD EPYC cloud" (2025-10-22); Hugging Face pricing and Spaces GPU docs (2026-10-16); docs.fly.io/about/pricing (2026-10-16); modal.com/pricing and runpod.io/pricing (updated 2026-10-08).
- PyPI: xatlas 0.0.11 has no Linux aarch64 wheel; torch 2.14.1 has manylinux_2_28_aarch64 wheels.
