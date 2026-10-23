#!/usr/bin/env python3
"""Build a portable, read-only review of an actual Fat Lab qualification run.

Usage: python3 scripts/build_fat_realism_gallery.py [artifact-directory]
Only index.html and gallery-manifest.json are written. Captures, videos and the
original test report are linked by relative paths and never transformed.
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import math
from fractions import Fraction
from pathlib import Path
from urllib.parse import quote


def digest(path: Path) -> str:
    checksum = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1 << 20), b""):
            checksum.update(block)
    return checksum.hexdigest()


def local_asset(directory: Path, value: object) -> Path:
    if not isinstance(value, str) or not value or any(character in value for character in "\\/?#:%\0") or value in (".", ".."):
        raise ValueError(f"Invalid evidence path: {value!r}")
    path = directory / value
    if path.is_symlink() or not path.is_file() or path.resolve().parent != directory.resolve():
        raise ValueError(f"Evidence must be a regular file in {directory}: {value!r}")
    return path


def finite(value: object) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def rate(value: object) -> float | None:
    try:
        number = float(Fraction(str(value)))
    except (ValueError, ZeroDivisionError):
        return None
    return number if math.isfinite(number) and number > 0 else None


def render(directory: Path, specimen_directory: Path | None = None) -> dict:
    source = local_asset(directory, "report.json")
    report = json.loads(source.read_text())
    visual_review = json.loads((directory / "independent-visual-review.json").read_text()) if (directory / "independent-visual-review.json").is_file() else {}
    captures = []
    for entry in report.get("captures", []):
        path = local_asset(directory, entry["file"])
        actual = digest(path)
        if entry.get("sha256") and actual != entry["sha256"]:
            raise ValueError(f"Capture hash no longer matches the report: {path.name}")
        state = entry.get("snapshot", {})
        captures.append({
            "name": entry["name"], "file": path.name, "sha256": actual,
            "stateFile": f"{entry['name']}-state.json" if (directory / f"{entry['name']}-state.json").is_file() else None,
            "camera": state.get("camera"), "cameraMethod": entry.get("cameraMethod"),
            "fat": state.get("fat", {}).get("options"),
            "diagnostics": state.get("fat", {}).get("diagnostics"),
            "specimen": state.get("stats"), "study": state.get("study"),
            "lighting": state.get("lighting"), "textureResolution": state.get("textureResolution"),
        })
    videos = []
    for entry in report.get("videos", []):
        path = local_asset(directory, entry["file"])
        decoded = entry.get("decoded", {})
        stream = next(iter(decoded.get("streams", [])), {})
        receipt = entry.get("receipt", {})
        duration = finite(stream.get("duration")) or finite(decoded.get("format", {}).get("duration"))
        stem = path.stem
        videos.append({
            "file": path.name, "sha256": digest(path), "bytes": path.stat().st_size,
            "width": stream.get("width", receipt.get("width")),
            "height": stream.get("height", receipt.get("height")),
            "codec": stream.get("codec_name", "Unknown"),
            "frames": stream.get("nb_read_frames"), "durationSeconds": duration,
            "measuredFps": rate(stream.get("avg_frame_rate")),
            "requestedFps": receipt.get("requestedFps", receipt.get("fps")),
            "upscaled": receipt.get("upscaled"),
            "recordingFile": f"{stem}-recording.json" if (directory / f"{stem}-recording.json").is_file() else None,
            "probeFile": f"{stem}-ffprobe.json" if (directory / f"{stem}-ffprobe.json").is_file() else None,
        })
    supplement = None
    if specimen_directory is not None:
        specimen_directory = specimen_directory.resolve()
        if specimen_directory == directory or specimen_directory.parent != directory.parent or specimen_directory.is_symlink():
            raise ValueError("Supplemental specimen evidence must be a different sibling run")
        specimen_report = local_asset(specimen_directory, "report.json")
        previous = json.loads(specimen_report.read_text())
        prefix = f"../{quote(specimen_directory.name)}/"
        before = {entry["path"]: entry["sha256"] for entry in previous.get("sourceAfter", [])}
        after = {entry["path"]: entry["sha256"] for entry in report.get("sourceBefore", [])}
        changed_sources = sorted(path for path in before.keys() | after.keys() if before.get(path) != after.get(path))
        added_captures = 0
        for entry in previous.get("captures", []):
            if not entry["name"].startswith("specimen-"):
                continue
            path = local_asset(specimen_directory, entry["file"])
            actual = digest(path)
            if entry.get("sha256") and actual != entry["sha256"]:
                raise ValueError(f"Supplemental capture hash no longer matches: {path.name}")
            state = entry.get("snapshot", {})
            state_file = f"{entry['name']}-state.json"
            captures.append({"name": entry["name"], "file": prefix + path.name, "sha256": actual,
                             "stateFile": prefix + state_file if (specimen_directory / state_file).is_file() else None,
                             "sourceRun": specimen_directory.name, "sourceReport": prefix + "report.json",
                             "camera": state.get("camera"), "cameraMethod": entry.get("cameraMethod"),
                             "specimen": state.get("stats"), "study": state.get("study"),
                             "lighting": state.get("lighting"), "textureResolution": state.get("textureResolution")})
            added_captures += 1
        added_videos = 0
        for entry in previous.get("videos", []):
            if not entry["file"].startswith("specimen-"):
                continue
            path = local_asset(specimen_directory, entry["file"])
            decoded, receipt = entry.get("decoded", {}), entry.get("receipt", {})
            stream = next(iter(decoded.get("streams", [])), {})
            stem = path.stem
            videos.append({"file": prefix + path.name, "sha256": digest(path), "bytes": path.stat().st_size,
                           "width": stream.get("width", receipt.get("width")), "height": stream.get("height", receipt.get("height")),
                           "codec": stream.get("codec_name", "Unknown"), "frames": stream.get("nb_read_frames"),
                           "durationSeconds": finite(stream.get("duration")) or finite(decoded.get("format", {}).get("duration")),
                           "measuredFps": rate(stream.get("avg_frame_rate")), "requestedFps": receipt.get("requestedFps", receipt.get("fps")),
                           "upscaled": receipt.get("upscaled"), "sourceRun": specimen_directory.name,
                           "sourceReport": prefix + "report.json", "sourceReportSha256": digest(specimen_report),
                           "recordingFile": prefix + f"{stem}-recording.json" if (specimen_directory / f"{stem}-recording.json").is_file() else None,
                           "probeFile": prefix + f"{stem}-ffprobe.json" if (specimen_directory / f"{stem}-ffprobe.json").is_file() else None})
            added_videos += 1
        if not added_videos:
            raise ValueError("Supplemental run has no standalone specimen video")
        supplement = {"run": specimen_directory.name, "report": prefix + "report.json", "reportSha256": digest(specimen_report),
                      "captures": added_captures, "videos": added_videos, "changedSources": changed_sources,
                      "note": "Standalone specimen evidence comes from this earlier run, not the current scene build. The earlier organ video is excluded because independent review found incorrect framing."}
    iterations = []
    for path in sorted(directory.parent.iterdir()):
        if not path.is_dir() or path == directory or path.is_symlink():
            continue
        receipt = path / "report.json"
        if not receipt.is_file() or not (path.name in ("baseline", "final", "qualified", "motion-diagnostic") or path.name.startswith("candidate-") or path.name.endswith("-qualified")):
            continue
        earlier = json.loads(receipt.read_text())
        review_path = path / "independent-visual-review.json"
        review = json.loads(review_path.read_text()) if review_path.is_file() else {}
        iterations.append({"name": path.name, "status": earlier.get("status", "Unknown"),
                           "checks": len(earlier.get("checks", [])), "images": len(earlier.get("captures", [])),
                           "file": f"../{quote(path.name)}/report.json",
                           "failure": str(earlier.get("failure", "")).split("\n", 1)[0], "visualStatus": review.get("visualStatus"),
                           "review": f"../{quote(path.name)}/independent-visual-review.json" if (path / "independent-visual-review.json").is_file() else None})
    data = {"status": report.get("status", "Unknown"), "phase": report.get("phase", "all"),
            "checks": report.get("checks", []), "captures": captures, "videos": videos,
            "iterations": iterations, "graphics": report.get("graphics"), "build": report.get("build"),
            "sourceUnchanged": report.get("sourceUnchanged"), "deployedSourceMismatches": report.get("deployedSourceMismatches"),
            "errors": report.get("errors", []), "failedRequests": report.get("failedRequests", []),
            "startedAt": report.get("startedAt"), "finishedAt": report.get("finishedAt"),
            "reportSha256": digest(source), "harnessSha256": report.get("harnessSha256"), "specimenSupplement": supplement,
            "primaryCaptures": len(report.get("captures", [])), "primaryVideos": len(report.get("videos", [])),
            "reviewFile": "independent-visual-review.json" if (directory / "independent-visual-review.json").is_file() else None,
            "scope": report.get("scope"), "visualStatus": visual_review.get("visualStatus"), "clinicalRealismCertified": False}
    payload = json.dumps(data, ensure_ascii=False).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    title = html.escape(f"Fat Lab · {directory.name} evidence")
    page = TEMPLATE.replace("__TITLE__", title).replace("__PAYLOAD__", payload)
    (directory / "index.html").write_text(page)
    manifest = {"schema": "viscera.fat-realism-gallery/v1", "reportSha256": data["reportSha256"],
                "gallerySha256": digest(directory / "index.html"), "captures": len(captures), "videos": videos,
                "specimenSupplement": supplement, "sourceEvidenceUnmodified": True, "scope": "Presentation of recorded engineering and visual evidence; not clinical validation."}
    (directory / "gallery-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


TEMPLATE = r'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><title>__TITLE__</title>
<style>
:root{font:16px/1.6 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e5eee9;background:#101a20;--muted:#a6bbb8;--border:#35484c;--gold:#e7c18a;--mint:#b9d8c9}
*{box-sizing:border-box}body{margin:0}a{color:var(--mint)}a:hover{color:white}button,select{font:inherit;color:inherit;background:#17282e;border:1px solid #57716d;border-radius:6px;padding:.55rem .75rem;min-height:44px}button{cursor:pointer}button:hover{background:#2b4446}button[aria-pressed=true]{background:#bdd7c8;color:#142b25;border-color:#bdd7c8}select{max-width:100%;width:100%}label{display:block;color:var(--muted);font-size:.9rem}label>select{display:block;margin-top:.35rem}a:focus-visible,button:focus-visible,select:focus-visible{outline:3px solid #f7d895;outline-offset:4px}
.skip{position:absolute;left:12px;top:-100px;padding:10px;background:#17282e;z-index:10}.skip:focus{top:12px}main{max-width:1320px;margin:auto;padding:36px 24px 70px}header{padding:12px 0 28px;border-bottom:1px solid var(--border)}.eyebrow{letter-spacing:.16em;font-size:.76rem;color:var(--gold);font-weight:650}h1{font-size:clamp(2rem,5vw,3.4rem);line-height:1.13;letter-spacing:-.04em;margin:.65rem 0}h2{font-size:1.5rem;line-height:1.25;letter-spacing:-.02em}h3{font-size:1.1rem}.lead{max-width:870px;color:#bdcfcc;font-size:1.05rem}.facts{display:flex;gap:8px;flex-wrap:wrap;margin-top:20px}.facts span,.pill{border:1px solid var(--border);border-radius:30px;padding:5px 12px;color:#c8dad4;font-size:.84rem}.notice{border-left:3px solid var(--gold);padding:13px 18px;background:#292a24;margin-top:24px;color:#e0d7be}.notice p{margin:0}section{margin-top:38px}section>p{color:var(--muted);max-width:950px}.toolbar{display:grid;grid-template-columns:minmax(160px,1fr) minmax(160px,2fr);gap:18px;align-items:end;margin-bottom:16px}.views{display:flex;gap:6px;flex-wrap:wrap}.views button{padding:.45rem .8rem}.viewer{margin:0;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:#0c151a}.viewer img{display:block;width:100%;height: min(75vh,820px);object-fit:contain}.viewer figcaption{display:flex;flex-wrap:wrap;justify-content:space-between;gap:10px;padding:13px 17px;font-size:.88rem;background:#17252b}.metadata{font-family:ui-monospace,monospace;font-size:.78rem;white-space:pre-wrap;overflow-wrap:anywhere;max-height:290px;overflow:auto;color:#b3c5c1}.link-row{display:flex;flex-wrap:wrap;gap:16px}details{border-bottom:1px solid var(--border);padding:12px 0}summary{cursor:pointer;color:#c0d3cc}summary:focus-visible{outline:3px solid var(--gold)}.video-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,440px),1fr));gap:22px}.video-card{border:1px solid var(--border);border-radius:10px;padding:18px;background:#142128}.video-card h3{margin:0 0 12px}video{display:block;width:100%;background:#070c10;aspect-ratio:16/9}.video-card p{color:var(--muted);font-size:.87rem}.measured{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin:16px 0}.measured div{background:#1d3034;padding:9px 12px;border-radius:5px}.measured dt{font-size:.73rem;color:var(--muted)}.measured dd{margin:1px 0;font-weight:600;overflow-wrap:anywhere}.checks{list-style:none;padding:0}.checks li{border-top:1px solid var(--border);padding:11px 0}.checks span{color:#99d4b7;margin-right:12px;font-size:.75rem;letter-spacing:.08em}.iterations{width:100%;border-collapse:collapse;font-size:.88rem}.iterations td,.iterations th{text-align:left;padding:11px 12px;border-bottom:1px solid var(--border);vertical-align:top}.iterations th{color:var(--muted);font-weight:500}.iterations .error{font-size:.78rem;color:#c5bca9}.muted{color:var(--muted)}.fine{font-size:.82rem;color:var(--muted);overflow-wrap:anywhere}.hidden,[hidden]{display:none!important}.error{color:#ffd5bd}footer{margin-top:40px;padding-top:20px;border-top:1px solid var(--border);font-size:.85rem;color:var(--muted)}
@media(max-width:600px){main{padding:24px 14px 48px}.toolbar{grid-template-columns:1fr}.viewer img{height:55vh}.iterations{display:block;overflow:auto}.views button{flex:1}.video-card{padding:12px}}
</style></head><body><a href="#review" class="skip">Skip to review</a><main id="review">
<header><div class="eyebrow">VISCERA / ADIPOSE REVIEW</div><h1>Fat around organs.<br>Inspect the evidence.</h1><p class="lead">Actual browser captures, reproducible states and native recordings from the tested build. Compare tissue planes from anatomical views, isolate surface appearance and inspect motion.</p><div class="facts" id="facts"></div><p class="fine" id="date"></p><div class="link-row" id="main-reports"><a href="report.json">Original qualification report</a><a href="gallery-manifest.json">Gallery manifest</a></div></header>
<aside class="notice"><p><strong>Procedural research model.</strong> These are authored surface depots with sampled clearance checks. Fat sliding, gravity, complete fascial volumes and patient-specific anatomy are not solved. Passing engineering checks does not certify photorealism, surgical accuracy or clinical suitability.</p></aside><aside class="notice" id="supplement-notice" hidden></aside>
<section id="organ-section"><h2>Inspect each depot</h2><p>Focus views retain anatomical orientation. The full assembly provides context; oblique and inferior views reveal edge thickness, clearance gaps and coverage that a frontal image can hide.</p><div class="toolbar"><label>Depot<select id="depot"></select></label><div class="views" id="views" role="group" aria-label="Anatomical camera view"></div></div><figure class="viewer"><img id="organ-image" alt="" decoding="async"><figcaption><span id="organ-caption"></span><span class="link-row"><a id="organ-native">Open native PNG</a><a id="organ-state">Capture state</a></span></figcaption></figure><details><summary>Camera, generation settings and image hash</summary><pre class="metadata" id="organ-meta"></pre></details></section>
<section id="material-section"><h2>Separate material and lighting</h2><p>Base colour, neutral geometry, neutral relief and relighting distinguish pigment, shape and shading. Wetness studies change the surface coat; these are controlled visual diagnostics, not measured tissue optics.</p><div class="toolbar"><label>Study<select id="material-choice"></select></label></div><figure class="viewer"><img id="material-image" alt="" decoding="async"><figcaption><span id="material-caption"></span><span class="link-row"><a id="material-native">Open native PNG</a><a id="material-state">Capture state</a></span></figcaption></figure><details><summary>Study settings and image hash</summary><pre class="metadata" id="material-meta"></pre></details></section>
<section id="specimen-section"><h2>Standalone specimens</h2><p>The independent lab exercises depot generation, shape and texture seeds, map exports and optics. Its free-orbit pose names describe inspection directions rather than calibrated anatomical axes.</p><label>Capture<select id="specimen-choice"></select></label><figure class="viewer" style="margin-top:16px"><img id="specimen-image" alt="" decoding="async"><figcaption><span id="specimen-caption"></span><span class="link-row"><a id="specimen-native">Open native PNG</a><a id="specimen-state">Capture state</a></span></figcaption></figure><details><summary>Specimen settings and image hash</summary><pre class="metadata" id="specimen-meta"></pre></details></section>
<section id="video-section"><h2>Inspect actual motion</h2><p>Recordings are captured by the application from its live scene canvas. Nothing autoplays. Displayed cadence comes from decoded video metadata; a requested frame rate is not a measured performance result.</p><div class="video-grid" id="videos"></div><p class="fine">Microphone audio was disabled for these qualification captures. Native dimensions do not establish a sustained real-time frame rate on other devices.</p></section>
<section><h2>Engineering qualification</h2><p id="qualification"></p><ul class="checks" id="checks"></ul><details><summary>Build, graphics and source evidence</summary><pre class="metadata" id="build-meta"></pre></details></section>
<section id="iterations-section"><h2>Preserved iterations</h2><p>Earlier runs remain unchanged, including failures. Their test receipts and independent visual reviews explain why a candidate needed revision. An earlier PASS covers its engineering checks only.</p><table class="iterations"><thead><tr><th>Run</th><th>Result</th><th>Evidence</th><th>Review / failure</th></tr></thead><tbody id="iterations"></tbody></table></section>
<footer><p>This gallery links original evidence using relative paths and can be opened locally or served beside its artifacts. No source screenshot, video or report is resized, recoloured or overwritten. For full diagnostics use the original report and per-capture state files.</p><p id="report-hash" class="fine"></p></footer>
</main><script type="application/json" id="evidence-data">__PAYLOAD__</script><script>
'use strict';
const data=JSON.parse(document.getElementById('evidence-data').textContent),byId=id=>document.getElementById(id),byName=new Map(data.captures.map(item=>[item.name,item]));
const text=(id,value)=>{byId(id).textContent=value},pretty=value=>JSON.stringify(value,null,2),human=name=>name.replace(/^organs-|^specimen-/,'').replaceAll('-',' ');
function option(value,label){const node=document.createElement('option');node.value=value;node.textContent=label;return node}
function link(label,file){const node=document.createElement('a');node.textContent=label;node.href=file;return node}
function show(prefix,item){if(!item)return;const image=byId(prefix+'-image');image.src=item.file;image.alt=human(item.name)+' — actual browser render';text(prefix+'-caption',human(item.name));byId(prefix+'-native').href=item.file;const state=byId(prefix+'-state');state.hidden=!item.stateFile;if(item.stateFile)state.href=item.stateFile;text(prefix+'-meta',pretty(item))}
for(const value of [`Engineering ${data.status}`,`${data.checks.length} check groups`,`${data.captures.length} original images`,`${data.videos.length} native recordings`,`Phase: ${data.phase}`]){const span=document.createElement('span');span.textContent=value;byId('facts').append(span)}
text('date',`Run finished ${data.finishedAt??'not recorded'}`);text('report-hash',`Original report SHA-256: ${data.reportSha256}`);
if(data.reviewFile)byId('main-reports').append(link('Independent visual review',data.reviewFile));
if(data.visualStatus){const p=document.createElement('p');p.className='notice';p.textContent='Independent visual review: '+data.visualStatus;byId('main-reports').parentNode.append(p)}
if(data.specimenSupplement){const s=data.specimenSupplement,n=byId('supplement-notice');n.hidden=false;const p=document.createElement('p');p.textContent=`Combined evidence: the primary ${data.phase} run contributes ${data.primaryCaptures} images and ${data.primaryVideos} recordings. ${s.captures} standalone images and ${s.videos} standalone recordings are linked from ${s.run}. ${s.note}`;n.append(p,link('Earlier specimen source report',s.report));const details=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');summary.textContent='Cross-run source changes and provenance';pre.className='metadata';pre.textContent=pretty(s);details.append(summary,pre);n.append(details)}
const depots=[['all','Whole assembly'],['omentum','Omental apron'],['left-perirenal','Left perirenal pad'],['right-perirenal','Right perirenal pad']],views=[['front','Front'],['back','Back'],['left','Left'],['right','Right'],['top','Top'],['bottom','Bottom'],['oblique','¾ view']];let selectedView='front';
for(const[id,label]of depots)if(views.some(([view])=>byName.has(`organs-${id}-${view}`)))byId('depot').append(option(id,label));
if(byId('depot').options.length){if([...byId('depot').options].some(o=>o.value==='omentum'))byId('depot').value='omentum';for(const[id,label]of views){const button=document.createElement('button');button.type='button';button.textContent=label;button.dataset.view=id;button.onclick=()=>{selectedView=id;showOrgan()};byId('views').append(button)}function showOrgan(){const depot=byId('depot').value;if(!byName.has(`organs-${depot}-${selectedView}`))selectedView=views.find(([view])=>byName.has(`organs-${depot}-${view}`))[0];for(const button of byId('views').children){button.disabled=!byName.has(`organs-${depot}-${button.dataset.view}`);button.setAttribute('aria-pressed',String(button.dataset.view===selectedView))}show('organ',byName.get(`organs-${depot}-${selectedView}`))}byId('depot').onchange=showOrgan;showOrgan()}else byId('organ-section').hidden=true;
for(const[prefix,filter]of [['material',item=>/^organs-(ablation|light|wetness)-/.test(item.name)],['specimen',item=>item.name.startsWith('specimen-')]]){const items=data.captures.filter(filter);if(!items.length){byId(prefix+'-section').hidden=true;continue}const choice=byId(prefix+'-choice');for(const item of items)choice.append(option(item.name,human(item.name)));choice.onchange=()=>show(prefix,byName.get(choice.value));choice.dispatchEvent(new Event('change'))}
const number=value=>value===null||value===undefined?'Not recorded':Number(value).toLocaleString('en',{maximumFractionDigits:2});
for(const item of data.videos){const card=document.createElement('article');card.className='video-card';const title=document.createElement('h3');title.textContent=item.file.startsWith('organ-')?'Fat around organs · live orbit':'Standalone specimen · live orbit';card.append(title);const video=document.createElement('video');video.controls=true;video.preload='none';video.playsInline=true;video.src=item.file;video.setAttribute('aria-label',title.textContent);const poster=byName.get(item.file.startsWith('organ-')?'organs-light-surgical':'specimen-native-4k-map');if(poster)video.poster=poster.file;card.append(video);const metrics=document.createElement('dl');metrics.className='measured';for(const[label,value]of [['Decoded pixels',`${item.width} × ${item.height}`],['Codec',item.codec],['Decoded frames',number(item.frames)],['Measured average FPS',number(item.measuredFps)],['Duration',`${number(item.durationSeconds)} s`],['Upscaled',item.upscaled===false?'No':item.upscaled===true?'Yes':'Not recorded']]){const row=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;row.append(dt,dd);metrics.append(row)}card.append(metrics);const links=document.createElement('div');links.className='link-row';links.append(link('Open original video',item.file));if(item.recordingFile)links.append(link('Capture receipt',item.recordingFile));if(item.probeFile)links.append(link('Decoder receipt',item.probeFile));if(item.sourceReport){links.append(link('Earlier source run: '+item.sourceRun,item.sourceReport))}card.append(links);const hash=document.createElement('p');hash.className='fine';hash.textContent=`SHA-256: ${item.sha256}`;card.append(hash);byId('videos').append(card)}if(!data.videos.length)byId('video-section').hidden=true;
text('qualification',`${data.errors.length} unexpected console/runtime errors; ${data.failedRequests.length} unexpected failed requests. Runtime sources unchanged during qualification: ${data.sourceUnchanged===true?'yes':data.sourceUnchanged===false?'no':'not recorded'}. Deployed-source mismatches: ${data.deployedSourceMismatches?.length??'not recorded'}.`);
for(const item of data.checks){const li=document.createElement('li'),status=document.createElement('span');status.textContent=item.status;li.append(status,document.createTextNode(item.name));byId('checks').append(li)}
text('build-meta',pretty({graphics:data.graphics,build:data.build,sourceUnchanged:data.sourceUnchanged,deployedSourceMismatches:data.deployedSourceMismatches,harnessSha256:data.harnessSha256,scope:data.scope}));
for(const item of data.iterations){const tr=document.createElement('tr');for(const value of [item.name,item.status,`${item.checks} groups · ${item.images} images`]){const td=document.createElement('td');td.textContent=value;tr.append(td)}const notes=document.createElement('td');notes.append(link('Original report',item.file));if(item.visualStatus){const p=document.createElement('p');p.className='error';p.textContent='Visual review: '+item.visualStatus;notes.append(p)}if(item.review){notes.append(document.createTextNode(' · '),link('Visual review',item.review))}if(item.failure){const p=document.createElement('p');p.className='error';p.textContent=item.failure;notes.append(p)}tr.append(notes);byId('iterations').append(tr)}if(!data.iterations.length)byId('iterations-section').hidden=true;
</script></body></html>'''


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", nargs="?", type=Path, default=Path("artifacts/fat-realism-2026-10-21/final"))
    parser.add_argument("--specimen-run", type=Path, help="Link standalone specimen evidence from an explicitly identified sibling run")
    arguments = parser.parse_args()
    result = render(arguments.directory.resolve(), arguments.specimen_run)
    print(json.dumps({"gallery": str(arguments.directory / "index.html"), "captures": result["captures"], "videos": len(result["videos"])}))
