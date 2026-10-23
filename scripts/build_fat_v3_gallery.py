#!/usr/bin/env python3
"""Build the self-contained V3 evidence gallery from recorded local artifacts.

Run from any directory: python3 scripts/build_fat_v3_gallery.py --strict
Without --strict, final-view pairs may remain explicitly pending while capture runs.
Validation is CPU-only: local resources, HTML IDs/labels and Node JavaScript syntax.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
from html.parser import HTMLParser

WORKSPACE = Path(__file__).resolve().parents[1]
ROOT = WORKSPACE / "artifacts/fat-quality-v3-2026-10-19"
PREVIOUS = WORKSPACE / "artifacts/fat-quality-2026-10-19/iteration4"
FINAL = ROOT / "final-views"
CAPTURE = ROOT / "candidate-03"


def read_json(path: Path) -> dict:
    return json.loads(path.read_text())


def relative(path: Path) -> str:
    return Path(os.path.relpath(path, ROOT)).as_posix()


def make_data(strict: bool) -> tuple[dict, set[str]]:
    capture = read_json(CAPTURE / "all-observations.json")
    files: set[str] = set()

    def asset(path: Path, required: bool = True) -> str | None:
        if not path.is_file():
            if required:
                raise FileNotFoundError(path)
            return None
        value = relative(path)
        files.add(value)
        return value

    depots = {"omental": "Omental apron", "visceral": "Visceral pad", "subcutaneous": "Subcutaneous tissue"}
    pairs = []
    for depot, label in depots.items():
        for seed in [0, 42, 4294967295]:
            for view in ["front", "reverse"]:
                name = f"{depot}-{seed}-{view}.png"
                pairs.append({"depot": depot, "label": label, "seed": seed, "view": view,
                              "previous": asset(PREVIOUS / name), "final": asset(FINAL / name, strict)})
    families = [
        {"id": "independent-texture-seed", "label": "Texture seeds", "description": "Three texture seeds across three depots, with shape seed fixed at 42."},
        {"id": "thickness-drape", "label": "Thickness × fold depth", "description": "Nine combinations separate local sheet thickness from broad fold depth."},
        {"id": "scattering-ablation", "label": "Light & scattering", "description": "Backlight and darkness at three scattering strengths. The optical response is an authored approximation."},
        {"id": "surface-parameter", "label": "Surface controls", "description": "Vary lobule scale, connective septa and vessel visibility one control at a time."},
    ]
    studies = []
    for case in capture["cases"]:
        family = case.get("family")
        if family == "video-frame":
            continue
        if family == "independent-texture-seed":
            label = f"{depots[case['depot']]} · texture seed {case['textureSeed']}"
        elif family == "thickness-drape":
            label = f"{case['thicknessMm']:g} mm thickness · {case['drapeMm']:g} mm folds"
        elif family == "scattering-ablation":
            label = f"{case['lighting'].capitalize()} · scattering {case['scattering']:g}"
        else:
            label = f"{case['control']} · {case['value']:g}"
        snap = case["snapshot"]
        studies.append({"id": case["name"], "family": family, "label": label, "file": asset(CAPTURE / case["file"]),
                        "sha256": case["sha256"], "width": snap["canvas"]["width"], "height": snap["canvas"]["height"],
                        "textureResolution": snap["viewport"]["textureResolution"], "controls": snap["controls"], "geometry": snap["viewport"]["stats"]})
    titles = {"omental-orbit": "Omental orbit · actual 4K", "creep": "Creep & recovery", "stress-cyclic": "Repeated stress cycles", "zoom-mips": "Zoom & texture filtering", "moving-light": "Moving light · fixed camera"}
    descriptions = {
        "omental-orbit": "A folded sheet under studio light, ending in backlight. 4096² texture maps; a genuinely 3840 × 2160 encoded canvas.",
        "creep": "A 1 s loading ramp, 4 s hold and release, followed by recovery. A homogeneous coupon drives uniform preview deformation; local contact is not solved.",
        "stress-cyclic": "A nonnegative, repeated nominal-stress load produces a history-dependent strain response. The loading protocol is sampled every 0.02 s.",
        "zoom-mips": "Discrete wheel input tests the transition between texture scales. The sparse update cadence is not a smooth-animation or maximum-throughput benchmark.",
        "moving-light": "The camera stays still while the studio light moves. Highlights change with illumination; no camera orbit is substituted for light motion.",
    }
    videos = []
    playback_audit = read_json(ROOT / "review-playback/manifest.json")
    playback_by_id = {video["experiment"]: video for video in playback_audit["videos"]}
    for video in capture["videos"]:
        kind, cadence = video["experiment"], video["cadence"]
        playback = playback_by_id[kind]
        review_path = ROOT / f"reviewer-video-candidate03/{kind}-overview-contact.png"
        videos.append({"id": kind, "label": titles[kind], "description": descriptions[kind], "file": asset(CAPTURE / video["file"]),
                       "playbackFile": asset(ROOT / playback["playbackFile"]), "playbackSha256": playback["playbackSha256"], "playbackBytes": playback["playbackBytes"],
                       "metadata": asset(CAPTURE / f"{kind}-metadata.json"), "review": asset(review_path, False),
                       "width": video["initial"]["canvas"]["width"], "height": video["initial"]["canvas"]["height"],
                       "fps": cadence["measuredAverageFps"], "frames": cadence["decodedFrames"],
                       "durationSec": video["recordingTiming"]["durationMs"] / 1000,
                       "maxIntervalMs": cadence["maximumFrameIntervalSec"] * 1000, "bytes": video["bytes"], "sha256": video["sha256"]})
    unit = read_json(ROOT / "final-unit-tests.json")
    geometry = read_json(ROOT / "geometry-audit.json")
    mechanics = read_json(ROOT / "mechanics-experiments.json")
    report_specs = [
        ("Critical review", "What improved, what failed, and what still looks artificial.", WORKSPACE / "docs/fat-quality-v3-review-2026-10-19.md"),
        ("Final verification", "Build, browser tests, material tests, atlas clearance and the remaining limits in one report.", ROOT / "verification.md"),
        ("Unit-test results", f"{unit['numPassedTests']} passed · {unit['numFailedTests']} failed · {unit['numPendingTests']} skipped. Counts reflect this recorded run.", ROOT / "final-unit-tests.json"),
        ("Full repository regression", "650 passed, 3 expected skips and 0 failures across 47 files; the concurrent tissue follow-up is recorded in final verification.", ROOT / "shared-regression-tests.json"),
        ("Geometry audit", f"{geometry['totalMeshes']:,} meshes; {geometry['totalIntersectionCases']:,} nonadjacent intersection checks. Read the exclusions and representation limits.", ROOT / "geometry-notes.md"),
        ("Geometry measurements", "Parameters, source hashes, mesh counts and measured construction timings.", ROOT / "geometry-audit.json"),
        ("Mechanics experiments", "Analytical creep/recovery, timestep convergence, force units and parameter sweeps.", ROOT / "mechanics-experiments.md"),
        ("Mechanics test results", "The focused material suite, including 117 creep parameter combinations.", ROOT / "mechanics-unit-tests.json"),
        ("Organ placement audit", "Final V3: 12 cases, 36 layers and 1,507,200 probes; minimum sampled clearance 0.7001356 mm, with none below 0.6 mm. No local contact solve.", ROOT / "scene-layer-audit.json"),
        ("Browser-test results", "13 passing browser tests, including the static 4K lab and organ-scene flows.", ROOT / "browser-tests.json"),
        ("Organs · final close-up", "Actual final browser capture of the adipose apron around the atlas organs.", ROOT / "final-browser/11-fat-abdomen-closeup.png"),
        ("GPU resource cycling", "Repeated material/control changes checked for retained GPU-resource growth.", ROOT / "final-browser/resource-cycles.json"),
        ("GPU opposed-light evidence", "Actual renderer measurements for the corrected opposed-light interface response.", ROOT / "final-browser/gpu-opposite-light.json"),
        ("Independent video audit", "Decoded timestamps and dense consecutive-frame windows, distinct from the capture owner's checks.", ROOT / "reviewer-video-candidate03/receipt.json"),
        ("Seekable video-copy audit", "Container remux only: identical packet payload hashes, frame counts and timestamps. Original recordings remain unchanged.", ROOT / "review-playback/manifest.json"),
        ("Capture manifest", "Exact controls, source hashes, image/video hashes, frame times and capture errors.", CAPTURE / "all-observations.json"),
        ("Reference images & models", "Surgical photographs and 3D references, with source distinctions and attribution.", WORKSPACE.parent / "reports/fat-reference-review-2026-10-18.html"),
        ("Lab implementation guide", "Using the model, interpreting the controls and reproducing the experiments.", WORKSPACE / "docs/fat-lab-v3.md"),
        ("Final-view manifest", "The final paired-view capture, including the later UI guards.", FINAL / "observations.json"),
    ]
    reports = [{"label": title, "description": description, "file": asset(path, title != "Final-view manifest")} for title, description, path in report_specs]
    return {"pairs": pairs, "families": families, "studies": studies, "videos": videos, "reports": reports,
            "passedTests": unit["numPassedTests"], "pendingTests": unit["numPendingTests"],
            "geometryMeshes": geometry["totalMeshes"], "mechanics": mechanics["defaultDiagnostics"],
            "candidateManifest": relative(CAPTURE / "all-observations.json"),
            "candidateStable": not capture["sourcesChangedDuringCapture"], "candidateErrors": len(capture["errors"]),
            "pairReady": sum(pair["final"] is not None for pair in pairs)}, files


HTML = r'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="description" content="Recorded VISCERA adipose studies: paired revisions, controlled images, actual 4K videos, and numerical evidence. An unvalidated procedural research model.">
<title>VISCERA · Adipose evidence / V3</title>
<style>
:root{--bg:#0f171b;--panel:#172227;--canvas:#182127;--line:#34434a;--text:#edf0e9;--muted:#adbdbe;--gold:#e6c38a;--teal:#a9d0bf;--soft:#25332e;color-scheme:dark;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:90px}body{margin:0;background:var(--bg);color:var(--text)}a{color:var(--gold);text-underline-offset:4px}a:hover{color:#fff1d5}button,select{font:inherit}button,a,select{-webkit-tap-highlight-color:transparent}:focus-visible{outline:3px solid var(--gold);outline-offset:5px}button{cursor:pointer}button:disabled{cursor:default;opacity:.5}.skip{position:fixed;top:-80px;left:20px;z-index:10;background:var(--gold);color:#111;padding:12px}.skip:focus{top:12px}.top{position:sticky;top:0;z-index:5;background:#0f171bf5;backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}.top-inner{max-width:1440px;margin:auto;padding:18px 32px;display:flex;align-items:center;gap:28px}.brand{color:var(--text);text-decoration:none;letter-spacing:.18em;font-weight:650;font-size:14px}.brand span{color:var(--gold);font-weight:400;letter-spacing:.1em;margin-left:12px;font-size:11px}.top nav{display:flex;gap:24px;margin-left:auto;font-size:13px}.top nav a{text-decoration:none;color:var(--muted)}.top nav a:hover{color:var(--text)}main{max-width:1440px;margin:auto;padding:0 32px 80px}.hero{padding:70px 0 45px;display:grid;grid-template-columns:1.6fr 1fr;gap:56px;align-items:end}.eyebrow{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--gold);margin:0 0 18px}.hero h1{font-size:clamp(38px,5.2vw,72px);line-height:1.05;letter-spacing:-.055em;font-weight:480;margin:0 0 24px;max-width:700px}.lead{font-size:17px;color:var(--muted);max-width:650px;margin:0}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:28px}.button{border:1px solid var(--line);border-radius:7px;padding:11px 16px;background:var(--panel);color:var(--text);font-size:13px;text-decoration:none;min-height:44px;display:inline-flex;align-items:center;justify-content:center;gap:8px}.button:hover{background:#29383c;color:white}.button.primary{background:var(--gold);color:#1c2426;border-color:var(--gold);font-weight:600}.scope{border-left:2px solid var(--gold);padding:4px 0 4px 23px;color:var(--muted);font-size:13px}.scope strong{display:block;color:var(--text);font-size:14px;font-weight:550;margin-bottom:9px}.scope p{margin:0 0 10px}.scope p:last-child{margin:0}.numbers{display:grid;grid-template-columns:repeat(4,1fr);border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:21px 0;margin-bottom:52px}.numbers div{padding:0 24px;border-right:1px solid var(--line)}.numbers div:first-child{padding-left:0}.numbers div:last-child{border:0}.numbers b{display:block;font-size:29px;line-height:1.3;font-weight:450;color:var(--text);font-variant-numeric:tabular-nums}.numbers span{font-size:12px;color:var(--muted)}section{margin:0 0 64px}.section-top{display:flex;justify-content:space-between;align-items:end;gap:28px;margin-bottom:22px}.section-top h2{font-size:28px;font-weight:450;letter-spacing:-.035em;margin:0}.section-top p{font-size:13px;color:var(--muted);margin:5px 0 0;max-width:780px}.section-number{color:var(--teal);font-size:12px;letter-spacing:.12em;margin-right:12px}.controls{display:flex;gap:14px;align-items:end;flex-wrap:wrap;background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:17px 20px;margin-bottom:18px}label{display:grid;gap:7px;font-size:11px;color:var(--muted);letter-spacing:.02em}select{background:#111c21;color:var(--text);border:1px solid #4a5b62;border-radius:5px;min-height:43px;padding:8px 38px 8px 12px;font-size:13px;max-width:100%}.controls label{min-width:150px}.controls .wide{flex:1;min-width:min(300px,100%)}.controls .navigation{display:flex;gap:8px;margin-left:auto}.navigation .button{min-width:44px;padding:8px 13px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:18px}figure{margin:0;min-width:0;border:1px solid var(--line);border-radius:9px;overflow:hidden;background:var(--panel)}.image-wrap{background:var(--canvas);aspect-ratio:1.44;position:relative;display:grid;place-items:center}.image-wrap img{width:100%;height:100%;object-fit:contain;position:absolute;inset:0}.image-wrap .placeholder{padding:28px;max-width:400px;text-align:center;color:var(--muted);font-size:13px}.image-wrap img[hidden]{display:none}figcaption{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:15px 18px;font-size:12px;color:var(--muted)}figcaption strong{display:block;color:var(--text);font-size:13px;font-weight:550}figcaption a{font-size:12px;white-space:nowrap}.tag{display:inline-block;padding:3px 7px;margin-right:9px;border:1px solid #536359;border-radius:3px;color:var(--teal);font-size:10px;letter-spacing:.08em}.tag.old{border-color:#536066;color:var(--muted)}.status{font-size:12px;color:var(--muted);margin:12px 0 0;min-height:1.7em}.study-layout{display:grid;grid-template-columns:minmax(0,2.2fr) minmax(240px,.9fr);gap:20px}.study-layout .image-wrap{aspect-ratio:1070/896}.study-info{border:1px solid var(--line);border-radius:9px;padding:23px;background:var(--panel);align-self:start}.study-info h3{font-size:20px;line-height:1.35;font-weight:450;margin:0 0 16px}.facts{margin:0}.facts div{display:flex;justify-content:space-between;gap:20px;padding:11px 0;border-bottom:1px solid var(--line);font-size:12px}.facts dt{color:var(--muted)}.facts dd{margin:0;text-align:right;color:var(--text);font-variant-numeric:tabular-nums}.facts div:last-child{border:0}details{margin-top:18px;font-size:12px;color:var(--muted)}summary{cursor:pointer;color:var(--teal);padding:6px 0}pre{font:11px/1.6 ui-monospace,SFMono-Regular,monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-height:340px;overflow:auto;background:#111a1f;padding:12px;border:1px solid var(--line);border-radius:5px}.motion{display:grid;grid-template-columns:minmax(0,2.2fr) minmax(240px,.9fr);gap:20px;align-items:start}.player{border:1px solid var(--line);border-radius:9px;overflow:hidden;background:#111a1f;min-width:0}.video-cover{min-height:420px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:40px;background:radial-gradient(ellipse at center,#28392f 0,#182127 58%,#111a1f 100%)}.play-icon{width:66px;height:66px;border:1px solid #637568;border-radius:50%;display:grid;place-items:center;color:var(--gold);font-size:24px;margin-bottom:18px}.video-cover p{color:var(--muted);font-size:12px;max-width:410px}.video-cover h3{font-size:24px;line-height:1.3;font-weight:450;margin:0 0 10px}.video-cover .eyebrow{margin:0 0 14px}.video-cover[hidden]{display:none}video{width:100%;max-height:72vh;display:block;background:#182127}video[hidden]{display:none}.motion-description{color:var(--muted);font-size:13px;line-height:1.7;margin-top:18px}.measure{display:flex;gap:12px;flex-wrap:wrap;font-size:11px;border-top:1px solid var(--line);padding:14px 18px;color:var(--muted)}.measure b{color:var(--text);font-weight:500}.video-note{color:var(--gold);font-size:12px;line-height:1.6;margin:16px 0 0}.report-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.report{border:1px solid var(--line);border-radius:8px;padding:20px;text-decoration:none;color:var(--text);background:var(--panel);display:block;min-height:128px}.report:hover{border-color:#8b9576;background:#1c2b2c;color:var(--text)}.report b{display:flex;justify-content:space-between;gap:15px;font-size:14px;font-weight:550;margin-bottom:9px}.report p{font-size:12px;line-height:1.65;margin:0;color:var(--muted)}.report.pending{opacity:.65}.limits{display:grid;grid-template-columns:repeat(3,1fr);gap:25px;padding:26px 0;margin-top:24px;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.limits h3{font-size:13px;font-weight:550;margin:0 0 8px;color:var(--teal)}.limits p{font-size:12px;color:var(--muted);margin:0}.provenance{font-size:12px;line-height:1.8;color:var(--muted);margin-top:20px;max-width:1050px}.provenance strong{color:var(--text);font-weight:550}.footer{font-size:11px;color:var(--muted);display:flex;justify-content:space-between;gap:25px;border-top:1px solid var(--line);padding-top:22px}.footer a{color:var(--muted)}.sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}noscript{display:block;border:1px solid var(--gold);padding:20px;margin-bottom:30px;color:var(--gold)}
@media(max-width:1000px){.hero{gap:30px;grid-template-columns:1.3fr 1fr}.top-inner{padding:16px 22px}.top nav{gap:15px}.study-layout,.motion{grid-template-columns:minmax(0,1.6fr) minmax(230px,1fr)}.report-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.controls label{min-width:130px}.video-cover{min-height:340px;padding:25px}.numbers div{padding:0 16px}}@media(max-width:720px){main{padding:0 18px 45px}.top-inner{padding:14px 18px;flex-wrap:wrap;gap:12px}.top nav{margin:0;width:100%;justify-content:space-between;font-size:12px}.brand span{margin-left:8px}.hero{display:block;padding:40px 0 30px}.scope{margin-top:30px;padding-left:18px}.hero h1{font-size:45px}.numbers{grid-template-columns:repeat(2,1fr);gap:20px;margin-bottom:38px}.numbers div{padding:0!important;border:0}.numbers b{font-size:25px}.pair,.study-layout,.motion{grid-template-columns:1fr}.section-top{display:block}.section-top h2{font-size:25px}.controls{gap:12px;padding:15px}.controls label{flex:1;min-width:125px}.controls .navigation{margin-left:0;width:100%;justify-content:space-between}.controls .wide{min-width:100%}.report-grid{grid-template-columns:1fr}.limits{grid-template-columns:1fr;gap:22px}.footer{flex-direction:column;gap:8px}.video-cover{min-height:300px}.image-wrap{aspect-ratio:1.44}.study-layout .image-wrap{aspect-ratio:1070/896}section{margin-bottom:45px}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
</style></head><body>
<a class="skip" href="#content">Skip to evidence</a>
<header class="top"><div class="top-inner"><a class="brand" href="#content">VISCERA <span>ADIPOSE / V3</span></a><nav aria-label="Evidence sections"><a href="#compare">Compare</a><a href="#studies">Studies</a><a href="#motion">Motion</a><a href="#evidence">Evidence</a></nav></div></header>
<main id="content">
<div class="hero"><div><p class="eyebrow">Recorded research studies · 19 October 2026</p><h1>Adipose,<br>under inspection.</h1><p class="lead">Seeded shapes, controlled surfaces, and material experiments. Explore the actual lab captures and the evidence behind this revision.</p><div class="actions"><a class="button primary" href="http://127.0.0.1:8817/anatomy/fat.html">Open the fat lab ↗</a><a class="button" href="http://127.0.0.1:8817/anatomy/?mode=scene&amp;fat=1">Fat around organs ↗</a></div></div><aside class="scope"><strong>Experimental, unvalidated procedural model</strong><p>The geometry and material are authored approximations. Numerical checks do not establish patient anatomy, tissue optics or clinical accuracy.</p><p>The 4K orbit is encoded at 3840 × 2160 and measures <b id="hero-fps">26.12</b> fps. It did not sustain the requested 30 fps.</p></aside></div>
<div class="numbers" aria-label="Evidence overview"><div><b id="pair-count">18</b><span>paired revision views</span></div><div><b id="study-count">33</b><span>controlled still studies</span></div><div><b id="video-count">5</b><span>actual canvas recordings</span></div><div><b id="test-count">—</b><span>recorded unit tests passed</span></div></div>
<noscript>This gallery needs JavaScript for its selectors. The original <a href="candidate-03/README.md">capture report</a>, <a href="candidate-03/all-observations.json">manifest</a> and <a href="../../docs/fat-quality-v3-review-2026-10-19.md">critical review</a> remain available directly.</noscript>
<section id="compare" aria-labelledby="compare-title"><div class="section-top"><div><h2 id="compare-title"><span class="section-number">01</span>Compare revisions</h2><p>Same seed and named view: the preserved V2 iteration 4 alongside the final V3 capture. These are visual comparisons, not registered images or measured anatomy.</p></div></div>
<div class="controls"><label for="depot">Depot<select id="depot"><option value="omental">Omental apron</option><option value="visceral">Visceral pad</option><option value="subcutaneous">Subcutaneous tissue</option></select></label><label for="seed">Shape seed<select id="seed"><option value="0">0</option><option value="42" selected>42</option><option value="4294967295">4294967295</option></select></label><label for="view">View<select id="view"><option value="front">Front</option><option value="reverse">Reverse</option></select></label><div class="navigation"><button class="button" id="pair-prev" aria-label="Previous comparison">← Previous</button><button class="button" id="pair-next" aria-label="Next comparison">Next →</button></div></div>
<div class="pair"><figure><div class="image-wrap"><img id="previous-image" alt="" decoding="async" hidden><div class="placeholder" id="previous-placeholder">Select a comparison.</div></div><figcaption><div><strong><span class="tag old">V2</span>Preserved iteration 4</strong><span id="previous-caption"></span></div><a id="previous-original" href="#compare">Open original ↗</a></figcaption></figure><figure><div class="image-wrap"><img id="final-image" alt="" decoding="async" hidden><div class="placeholder" id="final-placeholder">Final view capture pending.</div></div><figcaption><div><strong><span class="tag">V3</span>Final views</strong><span id="final-caption"></span></div><a id="final-original" href="#compare">Open original ↗</a></figcaption></figure></div><p class="status" id="pair-status" role="status" aria-live="polite"></p></section>
<section id="studies" aria-labelledby="studies-title"><div class="section-top"><div><h2 id="studies-title"><span class="section-number">02</span>Change one variable</h2><p>Candidate 03: raw WebGL images with exact controls preserved. Only the selected study image loads.</p></div></div><div class="controls"><label for="family">Experiment family<select id="family"></select></label><label for="study" class="wide">Study<select id="study"></select></label><div class="navigation"><button class="button" id="study-prev" aria-label="Previous study">←</button><button class="button" id="study-next" aria-label="Next study">→</button></div></div><div class="study-layout"><figure><div class="image-wrap"><img id="study-image" alt="" decoding="async" hidden><div class="placeholder" id="study-placeholder">Select a study.</div></div><figcaption><span id="study-position"></span><a id="study-original" href="#studies">Open original PNG ↗</a></figcaption></figure><aside class="study-info"><p class="eyebrow" id="study-family"></p><h3 id="study-title"></h3><p class="motion-description" id="study-description"></p><dl class="facts" id="study-facts"></dl><details><summary>Exact controls & provenance</summary><pre id="study-details"></pre></details></aside></div><p class="status" id="study-status" role="status" aria-live="polite"></p></section>
<section id="motion" aria-labelledby="motion-title"><div class="section-top"><div><h2 id="motion-title"><span class="section-number">03</span>Inspect the motion</h2><p>Actual VP9 canvas recordings. The player uses seekable container-remux copies, with no re-encoding; the originals remain available. Cadence is measured from the raw captures. One selected recording loads fully for reliable seeking; switching clips releases it. Nothing autoplays.</p></div></div><div class="controls"><label for="video-choice" class="wide">Recording<select id="video-choice"></select></label><a class="button" id="video-file" href="#motion">Open original video ↗</a></div><div class="motion"><div class="player"><div class="video-cover" id="video-cover"><div class="play-icon" aria-hidden="true">▷</div><p class="eyebrow">Actual canvas capture · VP9</p><h3 id="video-cover-title"></h3><button class="button primary" id="video-load">Load recording</button><p id="video-size"></p></div><video id="video-player" controls playsinline preload="none" aria-label="Selected fat lab experiment recording" hidden></video><div class="measure"><span>Canvas <b id="video-dimensions"></b></span><span>Measured <b id="video-fps"></b></span><span>Duration <b id="video-duration"></b></span></div></div><aside class="study-info"><h3 id="video-title"></h3><p class="motion-description" id="video-description"></p><dl class="facts" id="video-facts"></dl><p class="video-note" id="video-note"></p><div class="actions"><a id="video-metadata" href="#motion">Frame metadata ↗</a><a id="video-review" href="#motion">Decoded overview ↗</a></div><details><summary>Capture integrity</summary><pre id="video-details"></pre></details></aside></div><p class="status" id="video-status" role="status" aria-live="polite"></p></section>
<section id="evidence" aria-labelledby="evidence-title"><div class="section-top"><div><h2 id="evidence-title"><span class="section-number">04</span>Read the evidence</h2><p>Recorded tests, independent review and source material. Each report states what its checks can establish.</p></div></div><div class="report-grid" id="report-grid"></div><div class="limits"><div><h3>Shape & placement</h3><p>Closed meshes and sampled clearance are engineering properties. Omental sheets cannot represent overhanging self-contacting folds; surrounding-organ contact is not solved.</p></div><div><h3>Appearance</h3><p>The direct-light diffusion response uses a thickness proxy. It is not measured volumetric transport. Wet highlights and smooth, wax-like regions remain visual limitations.</p></div><div><h3>Material response</h3><p>Creep, recovery and relaxation use a homogeneous neo-Hookean/Prony coupon. Parameters are literature-inspired and uncalibrated; no local FEM, fluid flow or patient-specific fit is claimed.</p></div></div><p class="provenance"><strong>Capture chronology.</strong> The 33 studies and five videos are the preserved candidate-03 renderer capture. Its tracked source hashes stayed unchanged during recording. Two later UI guards stop moving-light mode when lighting changes and align the vessel slider step with its 0.55 default; the final paired views and final test report include those guards. Candidate-03 control snapshots may display 0.6 for that slider even though the rendered default was 0.55. Keep the capture manifest as the source record.</p><p class="provenance"><strong>Reproduce this gallery.</strong> Run <code>python3 scripts/build_fat_v3_gallery.py --strict</code> from the workspace. The gallery embeds only its small index; original PNG, WebM and report files remain separate, with no external libraries or fonts.</p></section>
<footer class="footer"><span>VISCERA / ADIPOSE EVIDENCE · V3 · EXPERIMENTAL</span><a href="../fat-quality-2026-10-19/index.html">Previous V2 evidence gallery ↗</a></footer>
</main><script id="gallery-data" type="application/json">__DATA__</script><script>
"use strict";
const data=JSON.parse(document.getElementById("gallery-data").textContent),$=id=>document.getElementById(id),params=new URLSearchParams(location.search);
const fmt=(number,digits=2)=>Number(number).toLocaleString("en",{maximumFractionDigits:digits});
const option=(value,label)=>new Option(label,value);
function setText(id,text){$(id).textContent=text;}
function updateQuery(key,value){params.set(key,value);try{history.replaceState(null,"",`${location.pathname}?${params}${location.hash}`);}catch{}}
function restore(id,key){if(params.has(key)&&[...$(id).options].some(item=>item.value===params.get(key)))$(id).value=params.get(key);}
function image(id,path,alt){const element=$(id),placeholder=$(id.replace("image","placeholder"));element.hidden=true;element.alt=alt;placeholder.hidden=false;placeholder.textContent=path?"Loading actual capture…":"This final view has not been captured in this gallery build yet.";if(!path){element.removeAttribute("src");return;}element.onload=()=>{element.hidden=false;placeholder.hidden=true;};element.onerror=()=>{placeholder.textContent="Capture unavailable. Open the manifest or rebuild the gallery after capture completes.";};element.src=path;}
function link(id,path){const element=$(id);element.hidden=!path;if(path)element.href=path;else element.removeAttribute("href");}
function facts(id,rows){$(id).replaceChildren(...rows.map(([label,value])=>{const row=document.createElement("div"),dt=document.createElement("dt"),dd=document.createElement("dd");dt.textContent=label;dd.textContent=value;row.append(dt,dd);return row;}));}
setText("pair-count",data.pairReady===18?"18":`${data.pairReady}/18`);setText("study-count",data.studies.length);setText("video-count",data.videos.length);setText("test-count",data.passedTests);setText("hero-fps",fmt(data.videos[0].fps));
for(const id of ["depot","seed","view"])restore(id,id);
function pair(){const selected=data.pairs.find(item=>item.depot===$("depot").value&&item.seed===Number($("seed").value)&&item.view===$("view").value);const label=`${selected.label} · seed ${selected.seed} · ${selected.view}`;image("previous-image",selected.previous,`V2 iteration 4: ${label}`);image("final-image",selected.final,`Final V3: ${label}`);link("previous-original",selected.previous);link("final-original",selected.final);setText("previous-caption",label);setText("final-caption",label);setText("pair-status",`${data.pairs.indexOf(selected)+1} of 18 comparisons. ${selected.final?"Both recorded captures available.":"Final capture pending; the previous view remains available."}`);for(const id of ["depot","seed","view"])updateQuery(id,$(id).value);}
function stepPair(direction){const index=data.pairs.findIndex(item=>item.depot===$("depot").value&&item.seed===Number($("seed").value)&&item.view===$("view").value);const next=data.pairs[(index+direction+data.pairs.length)%data.pairs.length];$("depot").value=next.depot;$("seed").value=String(next.seed);$("view").value=next.view;pair();}
for(const id of ["depot","seed","view"])$(id).addEventListener("change",pair);$("pair-prev").addEventListener("click",()=>stepPair(-1));$("pair-next").addEventListener("click",()=>stepPair(1));pair();
for(const family of data.families)$("family").add(option(family.id,family.label));restore("family","family");
function study(){const selected=data.studies.find(item=>item.id===$("study").value),family=data.families.find(item=>item.id===selected.family),siblings=data.studies.filter(item=>item.family===selected.family);image("study-image",selected.file,`${selected.label}; actual generated adipose specimen under controlled settings`);link("study-original",selected.file);setText("study-family",family.label);setText("study-title",selected.label);setText("study-description",family.description);setText("study-position",`${siblings.indexOf(selected)+1} / ${siblings.length} in this family`);facts("study-facts",[["Captured canvas",`${selected.width} × ${selected.height}`],["Texture maps",`${selected.textureResolution} × ${selected.textureResolution}`],["Geometry",selected.geometry.closed?"Closed mesh":"Open mesh"],["Triangles",fmt(selected.geometry.triangleCount,0)]]);setText("study-details",JSON.stringify({sha256:selected.sha256,controls:selected.controls,geometry:selected.geometry},null,2));setText("study-status",`${selected.label}. ${siblings.indexOf(selected)+1} of ${siblings.length} studies in ${family.label.toLowerCase()}.`);updateQuery("family",family.id);updateQuery("study",selected.id);}
function family(){const previous=params.get("study");$("study").replaceChildren(...data.studies.filter(item=>item.family===$("family").value).map(item=>option(item.id,item.label)));if([...$("study").options].some(item=>item.value===previous))$("study").value=previous;study();}
function stepStudy(direction){const select=$("study");select.selectedIndex=(select.selectedIndex+direction+select.options.length)%select.options.length;study();}
$("family").addEventListener("change",family);$("study").addEventListener("change",study);$("study-prev").addEventListener("click",()=>stepStudy(-1));$("study-next").addEventListener("click",()=>stepStudy(1));family();
for(const video of data.videos)$("video-choice").add(option(video.id,video.label));restore("video-choice","video");
let videoLoadController=null,videoObjectUrl=null,videoGeneration=0;
function releaseVideo(){videoGeneration++;if(videoLoadController){videoLoadController.abort();videoLoadController=null;}const player=$("video-player");player.pause();player.removeAttribute("src");player.load();player.hidden=true;if(videoObjectUrl){URL.revokeObjectURL(videoObjectUrl);videoObjectUrl=null;}$("video-cover").hidden=false;$("video-load").disabled=false;setText("video-load","Load recording");}
function chooseVideo(){const selected=data.videos.find(item=>item.id===$("video-choice").value);releaseVideo();setText("video-cover-title",selected.label);setText("video-title",selected.label);setText("video-description",selected.description);setText("video-size",`${fmt((selected.playbackBytes??selected.bytes)/1e6,1)} MB · no audio · ${fmt(selected.durationSec)} seconds`);setText("video-dimensions",`${selected.width} × ${selected.height}`);setText("video-fps",`${fmt(selected.fps)} fps`);setText("video-duration",`${fmt(selected.durationSec)} s`);facts("video-facts",[["Codec","VP9 / WebM"],["Decoded frames",fmt(selected.frames,0)],["Mean cadence",`${fmt(selected.fps)} fps`],["Longest interval",`${fmt(selected.maxIntervalMs,0)} ms`]]);setText("video-note",selected.id==="omental-orbit"?"Actual 4K encoding; measured 26.12 fps, below the requested 30 fps.":selected.id==="zoom-mips"?"Sparse wheel-driven updates: do not read this as a smooth-motion benchmark.":selected.id==="creep"?"Material samples advance every 0.05 s; recorded playback is about 20 fps.":"Cadence is measured from decoded timestamps, not the recorder's requested frame rate.");link("video-file",selected.file);link("video-metadata",selected.metadata);link("video-review",selected.review);setText("video-details",JSON.stringify({originalSha256:selected.sha256,playbackSha256:selected.playbackSha256,playbackFile:selected.playbackFile,playbackOperation:"stream-copy remux; no re-encoding",recordedStage:"candidate-03",requestedFps:30,measuredFps:selected.fps,sourceHashesStable:data.candidateStable,captureErrors:data.candidateErrors},null,2));setText("video-status",`${selected.label} selected. Press Load recording to fetch and play the video.`);updateQuery("video",selected.id);}
$("video-choice").addEventListener("change",chooseVideo);
$("video-load").addEventListener("click",async()=>{
  const selected=data.videos.find(item=>item.id===$("video-choice").value),player=$("video-player");
  releaseVideo();const generation=videoGeneration,controller=new AbortController();videoLoadController=controller;
  $("video-load").disabled=true;setText("video-load","Loading recording…");setText("video-status",`Loading the complete ${selected.label.toLowerCase()} recording for reliable seeking…`);
  try{
    const response=await fetch(selected.playbackFile??selected.file,{signal:controller.signal});
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    const blob=await response.blob();
    if(generation!==videoGeneration||controller.signal.aborted)return;
    videoLoadController=null;videoObjectUrl=URL.createObjectURL(blob);player.src=videoObjectUrl;player.hidden=false;$("video-cover").hidden=true;
    $("video-load").disabled=false;setText("video-load","Load recording");
    player.setAttribute("aria-label",`${selected.label}, actual recorded canvas, no audio`);player.focus();
    setText("video-status",`${selected.label} loaded in full. Use the native controls to play or seek.`);
    try{await player.play();}catch{if(generation===videoGeneration)setText("video-status","Video loaded. Use the native controls to start playback.");}
  }catch(error){
    if(generation!==videoGeneration||controller.signal.aborted)return;
    releaseVideo();setText("video-load","Retry recording");setText("video-status",`The recording could not be loaded (${error instanceof Error?error.message:String(error)}). Retry or open the original video. Serve this gallery over HTTP.`);
  }
});
$("video-player").addEventListener("error",()=>{if(!$("video-player").hidden)setText("video-status","This browser could not play the VP9 recording. Open the original video or decoded overview.");});
window.addEventListener("pagehide",releaseVideo);chooseVideo();
for(const report of data.reports){const card=document.createElement(report.file?"a":"div");card.className=`report${report.file?"":" pending"}`;if(report.file)card.href=report.file;const title=document.createElement("b"),arrow=document.createElement("span"),description=document.createElement("p");title.textContent=report.label;arrow.textContent=report.file?"↗":"Pending";arrow.setAttribute("aria-hidden","true");title.append(arrow);description.textContent=report.description+(report.file?"":" Rebuild after capture completes.");card.append(title,description);$("report-grid").append(card);}
</script></body></html>'''


class HtmlAudit(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.ids: set[str] = set()
        self.labels: list[str] = []
        self.resources: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if "id" in values:
            if values["id"] in self.ids:
                raise ValueError(f"Duplicate HTML id: {values['id']}")
            self.ids.add(values["id"])
        if tag == "label" and values.get("for"):
            self.labels.append(values["for"])
        if tag == "img" and "alt" not in values:
            raise ValueError("Image is missing an alt attribute")
        for name in ("src", "href"):
            value = values.get(name)
            if value and not value.startswith(("#", "http:", "https:", "data:")):
                self.resources.append(value)


def validate(document: str, resources: set[str], strict: bool, data: dict) -> None:
    audit = HtmlAudit()
    audit.feed(document)
    if missing := set(audit.labels) - audit.ids:
        raise ValueError(f"Labels refer to absent controls: {missing}")
    for resource in resources | set(audit.resources):
        if not (ROOT / resource).is_file():
            raise FileNotFoundError(ROOT / resource)
    if len(data["pairs"]) != 18 or len(data["studies"]) != 33 or len(data["videos"]) != 5:
        raise ValueError("Unexpected evidence matrix dimensions")
    if strict and data["pairReady"] != 18:
        raise ValueError("Final capture must provide all 18 paired views")
    javascript = document.rsplit("<script>", 1)[1].split("</script>", 1)[0]
    with tempfile.TemporaryDirectory(prefix="fat-gallery-check-") as directory:
        script = Path(directory) / "gallery.js"
        script.write_text(javascript)
        subprocess.run(["node", "--check", str(script)], check=True, capture_output=True, text=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--strict", action="store_true", help="Require all final paired captures before publishing the gallery.")
    args = parser.parse_args()
    data, resources = make_data(args.strict)
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")
    document = HTML.replace("__DATA__", payload)
    validate(document, resources, args.strict, data)
    destination = ROOT / "index.html"
    destination.write_text(document)
    print(json.dumps({"file": str(destination), "pairedViewsReady": data["pairReady"], "pairs": len(data["pairs"]),
                      "studies": len(data["studies"]), "videos": len(data["videos"]), "checkedLocalResources": len(resources),
                      "htmlBytes": len(document.encode()), "javascriptSyntax": "passed", "htmlLabels": "passed", "strict": args.strict}))


if __name__ == "__main__":
    main()
