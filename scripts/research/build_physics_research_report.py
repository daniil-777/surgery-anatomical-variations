"""Build the dated physics research review from audited local evidence.

Run from the VISCERA root. ReportLab, Pillow and matplotlib are needed.
The report distinguishes research proposals, source observations and a synthetic
numerical diagnostic; it does not produce or validate tissue parameters.
"""

from __future__ import annotations

import html
import json
import re
import shutil
from pathlib import Path

import matplotlib
import numpy as np
from PIL import Image as PILImage
from PIL import ImageDraw, ImageFont
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    Image,
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "research-report"
ASSETS = OUT / "physics-parameter-assets"
OUT.mkdir(exist_ok=True)
ASSETS.mkdir(exist_ok=True)
TITLE = "VISCERA Physics Parameter Learning Research 2026-10-07"
MATRIX = json.loads((ROOT / "references/physics/paper_matrix.json").read_text())
PAPERS = {item["id"]: item for item in MATRIX["papers"]}
SOURCES = json.loads((ROOT / "references/physics/source_catalog.json").read_text())["sources"]
PILOT = ROOT / "physics-releases/source-pilot/M1_L_V1_1"
OBS = json.loads((ROOT / "artifacts/physics/research/observability.json").read_text())

# Matplotlib ships Unicode fonts on every supported host, including Colab.
FONT_DIR = Path(matplotlib.get_data_path()) / "fonts/ttf"
for name, file in [("Review", "DejaVuSans.ttf"), ("ReviewBold", "DejaVuSans-Bold.ttf")]:
    pdfmetrics.registerFont(TTFont(name, str(FONT_DIR / file)))
pdfmetrics.registerFontFamily("Review", normal="Review", bold="ReviewBold", italic="Review", boldItalic="ReviewBold")
NAVY = colors.HexColor("#102B3D")
TEAL = colors.HexColor("#087F8C")
MUTED = colors.HexColor("#526775")
LIGHT = colors.HexColor("#EEF5F6")
GOLD = colors.HexColor("#AA6317")
PAGE_W, PAGE_H = A4
WIDTH = PAGE_W - 88
styles = {
    "body": ParagraphStyle("body", fontName="Review", fontSize=9.2, leading=13.4, textColor=NAVY, spaceAfter=9),
    "small": ParagraphStyle("small", fontName="Review", fontSize=8.1, leading=11.4, textColor=MUTED, spaceAfter=7),
    "h1": ParagraphStyle("h1", fontName="ReviewBold", fontSize=23, leading=28, textColor=NAVY, spaceAfter=17),
    "h2": ParagraphStyle("h2", fontName="ReviewBold", fontSize=14.3, leading=18, textColor=NAVY, spaceAfter=10),
    "kicker": ParagraphStyle("kicker", fontName="ReviewBold", fontSize=8.5, leading=12, textColor=TEAL, spaceAfter=8),
    "cell": ParagraphStyle("cell", fontName="Review", fontSize=8.2, leading=11.4, textColor=NAVY, spaceAfter=0),
    "label": ParagraphStyle("label", fontName="ReviewBold", fontSize=8.2, leading=11.4, textColor=MUTED, spaceAfter=0),
}
story = []
markdown = []
page_titles = []


def markup(text):
    escaped = html.escape(str(text))
    escaped = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<link href="\2" color="#087F8C">\1</link>', escaped)
    return re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", escaped).replace("\n", "<br/>")


def p(text, style="body"):
    story.append(Paragraph(markup(text), styles[style]))
    markdown.append(text + "\n")


def page(title, kicker):
    if page_titles:
        story.append(PageBreak())
    page_titles.append(title)
    story.extend([Paragraph(markup(kicker.upper()), styles["kicker"]), Paragraph(markup(title), styles["h1"])])
    markdown.append("\n## " + title + "\n\n" + kicker + "\n")


def h(text):
    story.append(Paragraph(markup(text), styles["h2"]))
    markdown.append("\n### " + text + "\n")


def table(headers, rows, widths=None):
    widths = widths or [WIDTH / len(headers)] * len(headers)
    cells = [[Paragraph(markup(x), styles["label"] if i == 0 else styles["cell"]) for x in row] for i, row in enumerate([headers] + rows)]
    t = Table(cells, colWidths=widths, repeatRows=1, hAlign="LEFT")
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), LIGHT),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("LINEBELOW", (0, 0), (-1, 0), .8, TEAL),
        ("LINEBELOW", (0, 1), (-1, -1), .3, colors.HexColor("#D9E3E6")),
    ]))
    story.extend([t, Spacer(1, 12)])
    markdown.extend(["| " + " | ".join(headers) + " |", "| " + " | ".join(["---"] * len(headers)) + " |"])
    for row in rows:
        markdown.append("| " + " | ".join(str(x).replace("\n", " ").replace("|", "/") for x in row) + " |")
    markdown.append("")


def figure(path, caption, max_height=320):
    target = ASSETS / path.name
    if path.resolve() != target.resolve():
        shutil.copy2(path, target)
    with PILImage.open(target) as im:
        w, ht = im.size
    factor = min(WIDTH / w, max_height / ht)
    story.append(Image(str(target), w * factor, ht * factor, hAlign="LEFT"))
    story.append(Spacer(1, 7))
    p(caption, "small")
    markdown.append(f"![{caption}]({ASSETS.name}/{target.name})\n")


def paper_card(paper_id, use):
    item = PAPERS[paper_id]
    start = len(story)
    h(item["title"])
    p(f'{item["venue"]} · {item["peer_review_status"]}', "small")
    url = item["primary_urls"][0]
    rows = [
        ["Target / inputs", "; ".join(item["parameters"]) + ". " + "; ".join(item["observations"])],
        ["Calibration", "; ".join(item["required_calibration"])],
        ["Evidence / limit", item["validation"] + " " + item["limitations"]],
        ["VISCERA decision", use],
    ]
    table(["Question", "Assessment"], rows, [93, WIDTH - 93])
    links = f'[Primary paper]({url})'
    if item.get("code_url"):
        links += f' · [Author code]({item["code_url"]})'
    p(links + f' · Review depth: {item["review_depth"]}.', "small")
    story[start:] = [KeepTogether(story[start:])]


page("Learning organ physics\nfrom interaction evidence", "VISCERA / Research review / 07 October 2026")
p("**Recommended direction: calibrated inverse mechanics first; learned constitutive models second.** Build a mechanical model that predicts measured forces and unseen deformations, then bind it to the detailed organ renderer.")
table(["Reviewed", "Acquired", "Computed locally"], [["12 core papers\n5 supporting works\n16 data-source families", "1 real stereo/force/pose recording\nEx-vivo chicken skin\nCC BY 4.0", "Synthetic FEM observability diagnostic\nReal-data integrity and timing checks\nNo fitted human-organ parameters"]])
h("What this review resolves")
p("Which papers offer reusable methods; which data can actually constrain mechanics; what can be learned from video alone; and how to connect a defensible fitting pipeline to VISCERA without confusing appearance, animation and material validation.")
h("Main finding")
p("A close video match is insufficient evidence of correct stiffness. Unknown force, support, contact, mass or camera scale can compensate for an incorrect material model. Some recent surgical-video systems explicitly output normalized response parameters. The report distinguishes those systems from calibrated constitutive identification. [DiffPD](https://arxiv.org/abs/2101.05917) · [2026 laparoscopic model](https://doi.org/10.3390/bioengineering13080863)")
h("How to read")
p("Pages 2–8: decisions and paper comparison. Pages 9–10: video and measurement sources. Pages 11–13: acquired evidence and numerical diagnostic. Pages 14–17: architecture, validation, costs and deliverables.")
p("Method: targeted primary-source review as of 7 October 2026. Full text, official repositories and data records were inspected where accessible. This is not an exhaustive systematic review or a local benchmark of the cited implementations. Publication status, access limitations and licenses are recorded explicitly.", "small")
p("Evidence labels used throughout: **published result**, **local observation**, **synthetic diagnostic**, and **proposed implementation**. No clinical readiness claim is made.", "small")

page("What can the observations identify?", "Decision / observability")
table(["Available evidence", "Useful target", "Missing information matters"], [
    ["RGB video, uncertain camera and loading", "Visible tracks, silhouette, motion timing; response proxies under explicit assumptions", "Absolute modulus, viscosity and hidden strain are not established."],
    ["Calibrated stereo + tool pose", "Metric surface motion and better contact geometry", "Force, support, reference state and tool-to-tissue contact remain confounders."],
    ["Measured load + displacement + geometry/support", "Restricted constitutive parameters; force–displacement prediction", "Check uncertainty, contact and parameter sensitivity; more parameters may still be unidentifiable."],
    ["Multiple rates, holds, release and tangential excitation", "Relaxation and rate dependence; friction if slip/contact evidence supports it", "Separate plasticity, slip, apparatus compliance and numerical damping."],
    ["Multiple loading directions + full-field observations", "Regional heterogeneity; anisotropy if sufficiently excited", "Resolution of a learned field cannot exceed the information in the observations."],
], [129, 181, WIDTH - 310])
p("These are engineering selection rules, not universal impossibility statements. Known mass/inertia, gravity, a calibrated reference patch or another mechanical scale can make some video-based inverse problems identifiable. [ElastNet](https://doi.org/10.1073/pnas.2102721118) · [Calibrated patch](https://doi.org/10.1115/1.4067735)")
h("Use the right quantity")
p("Contact stiffness k [N/m] is geometry-, support- and discretization-dependent. Young’s modulus E [Pa] is a constitutive coefficient. A dashpot [N·s/m], material viscosity [Pa·s] and numerical damping are different quantities. Preserve these distinctions in datasets, model outputs and editor labels.")
h("Best starting point for this project")
p("A small force-calibrated inverse-FEM experiment, one well-supported elastic parameter, explicit boundaries, and withheld loading conditions. Compare it to a simple effective contact-response baseline. Add a single relaxation branch only after multi-rate measurements support it. Rich neural material laws come later.")

pairs = [
    ("Inverse mechanics and differentiable solvers", [("fenics_inverse", "First transparent inverse-FEM baseline. Reproduce its sensitivity and discretization checks on known geometry before attempting an organ."), ("diffpd", "Evaluate as an efficient solver and as a parameter-ambiguity benchmark. Faster derivatives do not resolve missing information.")]),
    ("Contact calibration and material-law discovery", [("difftactile", "Adopt its measured-force plus observed-motion protocol and independent interaction tests; do not treat its tactile sensor as organ evidence."), ("neural_dfem", "Future constitutive architecture: physically constrained energy with FE equilibrium. First acquire calibrated displacement/reaction measurements.")]),
    ("Spatial stiffness and rate dependence", [("elastnet", "Use its scale-anchor requirement and equilibrium structure. Full-field strain assumptions are much stronger than ordinary laparoscopic observations."), ("viscoelastic_identifiability", "Use for experiment design and uncertainty analysis. Distinguish loading frequency, boundary error and constitutive damping.")]),
    ("Visual twins and generative motion", [("phystwin", "Useful practical interaction-conditioned twin. Keep spring coefficients model-dependent and audit the renderer’s separate license."), ("physdreamer", "Optional visual motion prior for exploratory animation. Generated motion must never become measured tissue-property ground truth.")]),
    ("Most direct surgical-video approaches", [("endogsim", "Promising surgical comparison, but reproduce its calibration and inspect released data/code before adoption. Keep preprint evidence distinct."), ("laparoscopic_generative", "A lightweight relative-response prototype. Its normalized mechanics and unresolved identifiability prevent absolute tissue-parameter claims.")]),
    ("Cutting and alternative calibration", [("disect", "Defer cutting until non-destructive contact is validated. Cutting introduces fracture, topology change and a restrictive code license."), ("force_patch", "Useful reminder that force-sensor-free does not mean calibration-free. It requires known reference mechanics and ultrasound.")]),
]
for name, cards in pairs:
    page(name, "Primary literature / task-specific selection")
    for key, use in cards:
        paper_card(key, use)

short_sources = [
    (0, "Stereo, force/torque, tool pose; ex-vivo chicken skin", "Acquired one bag. Frames/loads useful; missing registration, geometry and contact prevent constitutive promotion."),
    (3, "Human cadaver limb: tool load/pose and selected DIC strain", "Best next inverse-mechanics lead. Preserve apparatus, boundaries and timing uncertainty; not abdominal organs."),
    (5, "Porcine liver/bowel/abdominal wall; stereo and reference geometry", "Best next anatomical-deformation lead. Metadata inspected; full video not acquired. No measured force advertised."),
    (2, "Silicone bowel retraction: video and measured pulling load", "Open force-learning candidate. Not biological bowel; geometry and load direction still needed."),
    (6, "Porcine/ex-vivo stereo with independent IR tissue correspondences", "Tracking validation; preserve release/version splits. No force or material labels."),
    (4, "Silicone attachment configurations, meshes and point clouds", "Boundary-condition inference. A field named stiffness is attachment membership, not modulus."),
    (12, "Porcine stereo with camera kinematics", "Camera-motion separation. Camera motion is not tool motion; no measured tool load."),
    (1, "Silicone/sponge phantom: stereo, force and pose", "Promising measured setup, but data reuse rights were not verified."),
    (7, "157 stereo videos / 20 cases, calibration and tracked tissue boxes", "Clinical tracking robustness. Boxes do not validate dense strain; overlaps other sources."),
    (8, "Porcine cadaver stereo and structured-light depth", "Depth/camera validation. Primarily geometry evidence; access/terms need verification."),
    (9, "Stereo, robot encoders, masks and calibration", "Tool/tissue reconstruction. No force advertised; exact specimen and reuse rights need verification."),
    (10, "RGB, masks and predicted depth", "Temporal reconstruction. Predicted depth is not mechanics ground truth; no force labels."),
    (11, "Mixed endoscopic video/calibration subsets", "Qualitative motion reference. Specify the exact subset; original host/access/rights unresolved."),
    (13, "80 human cholecystectomy videos", "Clinical appearance/action context. No force, depth or constitutive labels."),
    (14, "50 procedures with instrument/verb/target labels", "Action selection. 1 fps samples miss rapid response; overlaps Cholec80."),
    (15, "Benchtop surgical gestures, stereo and tool kinematics", "Tool-trajectory priors. Not living abdominal tissue; no measured force."),
]
for group in range(2):
    page("Data that supports the right claim" if group == 0 else "Tracking and clinical-context sources", "Source survey / reuse checked separately from code")
    rows = []
    for idx, observation, value in short_sources[group * 8:(group + 1) * 8]:
        s = SOURCES[idx]
        license_name = s["data_license"]["spdx"] or "Data rights unverified"
        if idx == 6:
            license_name = "CC BY 4.0: challenge packages only; original release unverified"
        rows.append([f'[{s["title"]}]({s["primary_urls"][0]})\n{license_name}', observation, value])
    table(["Source / data terms", "Observations", "Use and boundary"], rows, [146, 157, WIDTH - 303])
    p("Only the chicken-skin bag was acquired for the motion pilot. Other entries are researched candidates. Full metadata, access state, source overlap and evidence hashes are in references/physics/source_catalog.json. A public download link is not itself a data license.", "small")

# Compose a compact contact sheet from original frames without modifying content.
with np.load(PILOT / "synchronized.npz") as arr:
    times = arr["t_s"].copy()
ids = [0, 349, 582, 814, 1280, 1746]
sheet = PILImage.new("RGB", (1440, 1320), "#102B3D")
draw = ImageDraw.Draw(sheet)
font = ImageFont.truetype(str(FONT_DIR / "DejaVuSans.ttf"), 24)
for k, idx in enumerate(ids):
    im = PILImage.open(PILOT / "left" / f"{idx:06d}.jpg").convert("RGB")
    im.thumbnail((720, 405))
    x, y = (k % 2) * 720, (k // 2) * 440
    sheet.paste(im, (x, y))
    draw.text((x + 14, y + 411), f"{times[idx]:.2f} s  /  original frame {idx}", font=font, fill="white")
sheet.save(ASSETS / "pilot-six-frames.jpg", quality=95)

page("What we actually acquired", "Local observation / real source media")
p("One approximately one-minute dVRK recording contains stereo images, measured wrench and Cartesian tool pose. The tissue is **ex-vivo chicken skin wrapped around chicken thigh**, not a human liver or a validated organ phantom.")
figure(ASSETS / "pilot-six-frames.jpg", "Original left-camera frames; resized into a contact sheet and labeled with bag-record times. Visual inspection shows repeated grasping/pulling and changing directions. These images do not measure strain, stiffness or contact force by themselves.", max_height=430)
p("Media attribution: Shuyuan Yang, My Le, Kyle Golobish, Juan Carlos Beaver and Zonghe Chua. [Original dataset](https://zenodo.org/records/21041361), CC BY 4.0. Changes: ROS extraction, resizing, temporal selection and labels; no generated tissue imagery. [License](https://creativecommons.org/licenses/by/4.0/) · [Associated paper](https://arxiv.org/abs/2403.18172)", "small")

page("Measurements with unresolved calibration", "Local observation / no material parameters fitted")
figure(PILOT / "signals_overview.png", "Measured sensor-force components, force magnitude and robot-position deltas. The viewer separately offers force-magnitude candidate windows; those are not verified contact or release labels.", max_height=260)
table(["Preserved", "Unresolved"], [
    ["1,747 left and 1,746 right original JPEGs; 55,893 pose and 59,706 wrench samples", "No camera calibration or force-to-PSM transform in the bag; wrench frame ID is empty."],
    ["Source units and record timestamps; original bag checksum; raw and paired arrays", "Camera/force header stamps are zero. Record-time alignment does not establish acquisition latency."],
    ["Preview contains all 1,747 left frames; PTS error ≤0.499 microseconds relative to mapped records", "Recorder batching produces near-simultaneous frame records; timing precision is not hardware accuracy."],
    ["Plastic deformation is reported by the source authors", "Contact, slip, support, rest geometry and thickness are not established. Reversible viscoelasticity is not an adequate assumption by default."],
], [WIDTH / 2, WIDTH / 2])
p("**Decision: observations only.** The machine-readable readiness record prohibits constitutive-parameter promotion and contains no fitted material values. Force and robot displacement must not be projected together until their coordinate frames are registered. One M1 recording supplies no independent-specimen test. [Source and paper](https://zenodo.org/records/21041361)")

page("Why the force measurement changes the problem", "Synthetic diagnostic / existing VISCERA FEM fixture")
figure(ROOT / "artifacts/physics/research/observability.png", "Synthetic 30 × 30 × 20 mm block; imposed patch displacement, fixed bottom, fixed Poisson ratio 0.35, no gravity or contact. These selected moduli are numerical fixture values, not an organ-property range.", max_height=230)
p("For this specific homogeneous model, W(E, x) = E · W(1, x). Multiplication by positive E leaves the displacement-constrained equilibrium minimizer unchanged, while reaction forces scale with E. The diagnostic uses the existing quadratic-J Neo-Hookean Eq. 13 fixture; it is not an organ-contact model.")
cal = OBS.get("same_model_reaction_calibration", OBS.get("known_load_calibration", {}))
table(["Check", "Result / interpretation"], [
    ["Three material scales", "2.5, 5 and 10 kPa at five prescribed depths; reaction/E curves collapse under this fixture’s assumptions."],
    ["Measured-reaction synthetic calibration", f'Truth 7,500 Pa; recovered {cal.get("estimate_pa", 7499.981387961427):.3f} Pa. Fit uses 0.5 and 1 mm; withheld depths are 1.5 and 2 mm.'],
    ["Withheld-depth force error", f'{cal.get("heldout_force_rmse_n", 1.8859262683495826e-6):.3g} N RMSE in this noiseless, same-model experiment.'],
    ["Scientific scope", "An observability witness and code diagnostic, not independent physical validation. Same-solver synthetic recovery is intentionally an idealized inverse problem."],
], [146, WIDTH - 146])
p("No result from this fixture is attached to the chicken recording. It does not validate near-incompressibility, friction, viscoelasticity, cutting, video reconstruction or human organ mechanics. The general lesson is to test parameter sensitivity and scale ambiguity before training a large network.")

page("Architecture to build from the evidence", "Proposed implementation / staged, measurable scope")
table(["Stage", "Build", "Advance only when"], [
    ["1 · Observation layer", "Immutable native timestamps, camera/force/tool transforms, track uncertainty, geometry, contacts and support metadata", "Rights, units, coordinate systems and temporal mapping are explicit; missing fields remain missing."],
    ["2 · Small inverse model", "Known-geometry force-calibrated FEM with one regional elastic scale; effective contact baseline for comparison", "Parameters are sensitive to the measurements and predict a withheld load/location."],
    ["3 · Rate/contact model", "One relaxation branch; friction from explicit tangential slip experiments; nuisance-boundary profiling", "Multi-rate data distinguish material response from slip, fixture compliance and numerical damping."],
    ["4 · Learned estimator", "Video/geometry encoder predicts a parameter distribution and uncertainty; inverse solver refines it", "Independent specimens and loading conditions demonstrate benefit over simpler baselines."],
    ["5 · Constitutive learning", "Neural-DFEM-style admissible strain-energy network coupled to equilibrium", "Richer measured loading identifies more than a small conventional constitutive family."],
    ["6 · Studio replay", "Coarse validated mechanics domain drives a bound detailed surface; frozen recipe and experiment identities", "Time, camera, rest coordinates, replay/reset and frame exports are deterministic."],
], [82, 217, WIDTH - 299])
h("Losses and outputs")
p("Use uncertainty-weighted surface displacement and measured force/torque losses; add silhouette or photometric terms as supporting observations. Penalize invalid elements/contacts and document boundary assumptions. Report confidence or feasible parameter ranges, not just a point estimate.")
p("Mechanical record: constitutive family, parameter names and units, specimen/tissue state, loading range/rate, geometry and source hashes, calibration IDs, solver/discretization version, training/held-out groups, residuals, sensitivity and uncertainty. Label it measured-calibrated, effective-motion-fit or engineering-preset.")
p("Solid-organ volumetric domains, hollow-organ shells/pressure and cutting/damage need different model contracts. Disease appearance and morphology do not create disease-specific mechanical labels. All-organ support can share the interface; each tissue/model still needs evidence.")

page("How to falsify a convincing simulation", "Acceptance / separate mechanics, tracking and appearance")
table(["Test", "Meaningful evidence"], [
    ["Numerical validity", "Finite-difference gradient checks; mesh/time-step convergence; volume change, element Jacobians, contact penetration and energy behavior. Derivative accuracy does not prove a tissue law."],
    ["Parameter identification", "Multiple starts, sensitivity/SVD or profile likelihood, nuisance-boundary sweeps and uncertainty. Flat likelihood means not identified even if images match."],
    ["Held-out mechanics", "Whole loading trajectories, new depths/rates/contact sites and independent specimens. Measure force curves, relaxation, hysteresis and displacement error."],
    ["Tracking quality", "Independent visible-point error, calibrated 3D error only where justified, occlusion coverage and camera-registration error. No pseudo-label self-validation."],
    ["Video comparison", "Same camera, time and tool action; exact frame schedule with per-frame metadata/hashes. Separate reference/fit and held-out prediction."],
    ["Perceptual realism", "Blinded surgeon review of motion, contact and appearance; report disagreement separately from mechanical scores."],
], [123, WIDTH - 123])
p("Useful independent evaluation references: [STIR](https://doi.org/10.1109/TMI.2024.3372828), [SurgT](https://doi.org/10.1016/j.media.2023.102985), [sparse liver registration challenge](https://doi.org/10.1117/1.JMI.11.1.015001), and [measured cadaver liver/stomach response](https://doi.org/10.1007/s00464-008-0154-z). Their tasks and tissue states are different; none is a universal all-organ test.", "small")
h("Current Studio audit")
p("Atlas renders static surfaces. The separate legacy XPBD preview is a heuristic positional model; its grab control does not provide calibrated contact force. The Python mechanics fixture is quasistatic and has no organ-contact runtime integration. Display meshes are not yet certified volumetric simulation domains.")
p("This research release adds an independent real-video review page and reproducible diagnostics. It does not silently substitute those components for a calibrated organ simulator. The integration plan specifies specimen binding, material-coordinate preservation, fixed-camera replay and evidence export.")

page("Compute, reuse and next experiment", "Practical adoption / checked claims")
rows = []
short_names = {"fenics_inverse": "Inverse FEM / FEniCS", "neural_dfem": "Neural-DFEM", "laparoscopic_generative": "Laparoscopic model (2026)"}
for key in ["fenics_inverse", "diffpd", "difftactile", "neural_dfem", "phystwin", "disect", "laparoscopic_generative"]:
    item = PAPERS[key]
    name = short_names.get(key, item["title"].split(":")[0])
    rows.append([f'[{name}]({item["primary_urls"][0]})', item["reported_compute"], item["code_license"]])
table(["Work", "Author-reported compute", "Code terms"], rows, [111, 217, WIDTH - 328])
p("Costs above are not local benchmarks or Colab guarantees. Neural-DFEM’s hours per fit and legacy environment favor a reduced-law CPU prototype first. The laparoscopic model’s fast parameter head is not its roughly 1 FPS end-to-end pipeline. Core code licenses do not automatically cover datasets, models or renderer dependencies.", "small")
h("Five supporting works")
p("[Multimodal bi-layer indentation (2024)](https://doi.org/10.1016/j.jmbbm.2024.106572): observation design and identifiability; partial-text review. [Indentify (2023)](https://doi.org/10.1016/j.jmbbm.2023.105708): synthetic indentation sensitivity; AGPL code and MATLAB/FEBio tooling.", "small")
p("[PhysGaussian (2024)](https://openaccess.thecvf.com/content/CVPR2024/html/Xie_PhysGaussian_Physics-Integrated_3D_Gaussians_for_Generative_Dynamics_CVPR_2024_paper.html): forward mechanics/rendering with supplied material parameters. [gradSim (2021)](https://openreview.net/forum?id=c_E8kFWfhp0): differentiable video-to-physics under controlled assumptions.", "small")
p("[Gravitational-loading virtual fields (2023)](https://pmc.ncbi.nlm.nih.gov/articles/PMC10565362/): alternative mechanical calibration lead; full text was inaccessible, so its protocol is not treated as a verified implementation specification.", "small")
page("Next experiment and reproducibility", "Delivery / what is ready and what remains")
h("Next experiment")
p("Acquire and register a small MULTIS trial with known tool geometry, loads and surface measurements; build a limited inverse problem around that actual setup. Separately use D4D abdominal geometry and STIR tracking evidence for shape/motion validation. These lanes meet only after their scale, anatomy and loading assumptions are compatible.")
h("Reproducible artifacts")
p("Companion files under viscera/: docs/PHYSICS_PARAMETER_PAPERS.md; docs/PHYSICS_VIDEO_SOURCES.md; docs/PHYSICS_STUDIO_INTEGRATION_PLAN.md; references/physics/paper_matrix.json and .csv; papers.bib; source_catalog.json; physics-releases/source-pilot/; physics-review/index.html; scripts/research/verify_stiffness_observability.py.", "small")
p("Run the source-pilot verifier before using derived observations. Run the synthetic diagnostic with PYTHONPATH=py. Primary-paper caches are local reading evidence, not licensed training assets. Original CC BY media attribution is preserved in the pilot and viewer.", "small")
h("Commands from the viscera directory")
p("python scripts/verify_physics_pilot.py physics-releases/source-pilot\nPYTHONPATH=py python scripts/research/verify_stiffness_observability.py\npython physics-review/serve.py --port 5191", "small")
table(["Delivered in this research increment", "Still requires data and implementation"], [
    ["Cited paper/data comparison with rights and limitations", "A clinically meaningful organ-specific measurement campaign"],
    ["Actual video/force/pose review with timestamp provenance", "Camera/force/tool registration, verified contacts and reference geometry"],
    ["Numerical ambiguity diagnostic and calibration-readiness audit", "Validated contact dynamics, identified material parameters and held-out organ replay"],
    ["Explicit Studio integration and validation design", "Simulation-versus-reference comparison video; no such result is claimed here"],
], [WIDTH / 2, WIDTH / 2])
p("Success for the next increment is a correctly bounded parameter estimate that predicts a new measured interaction, including an honest failure when the measurements cannot identify it. A photorealistic deformation alone does not meet that criterion.")


def decorate(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(TEAL)
    canvas.rect(0, PAGE_H - 7, PAGE_W, 7, fill=1, stroke=0)
    canvas.setFont("ReviewBold", 8)
    canvas.setFillColor(MUTED)
    canvas.drawString(44, PAGE_H - 29, "VISCERA  /  PHYSICS PARAMETER LEARNING")
    canvas.setStrokeColor(colors.HexColor("#D9E3E6"))
    canvas.line(44, 39, PAGE_W - 44, 39)
    canvas.setFont("Review", 7.3)
    canvas.drawString(44, 25, "Research evidence • 07 October 2026 • No calibrated human-organ model claimed")
    canvas.drawRightString(PAGE_W - 44, 25, f"{doc.page} / {len(page_titles)}")
    canvas.restoreState()


doc = SimpleDocTemplate(str(OUT / f"{TITLE}.pdf"), pagesize=A4, leftMargin=44, rightMargin=44, topMargin=55, bottomMargin=53, title=TITLE, author="VISCERA research review", pageCompression=1)
doc.build(story, onFirstPage=decorate, onLaterPages=decorate)
(OUT / f"{TITLE}.md").write_text("# " + TITLE + "\n" + "\n".join(markdown))
(OUT / "report-sections.json").write_text(json.dumps({"expected_pages": len(page_titles), "titles": page_titles}, indent=2) + "\n")
print(json.dumps({"pdf": str(OUT / f"{TITLE}.pdf"), "expected_pages": len(page_titles)}))
