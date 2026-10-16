# Liver physics: next implementation review, 2026-10-07

**Recommendation:** after reducing probe overlap, correct load-dependent floor friction and expose separate force/work/dissipation measurements. Keep the current free-organ floor protocol explicit. Do not add hidden anchors or a guessed capsule to reduce sliding. A calibrated capsule is a later constitutive extension, with its own specimen, thickness, fibre and loading evidence.

This is an independent source/code audit by an AI agent. Expert review and measured human-liver validation remain **NOT_RUN**. The completed [v2 browser assessment](LIVER_PHYSICS_V2_BROWSER_REVIEW_2026-10-07.md) and its raw evidence are preserved; this report does not relabel those results as a new version.

## Baseline findings and scope

The final v2 floor experiment was numerically sound in its saved states, but floor/probe motion remains a combination of local deformation and large rigid translation. The probe allowed up to 1.8305 mm overlap in that browser suite. A floor-supported organ is free to slide and rotate; those motions are not by themselves defects. The relevant question is whether support reactions, friction and dissipation obey the chosen boundary model.

The v2 floor-friction code applied a tangential velocity multiplier proportional to `0.6 * (max(-old_vy, 0) + gravity * dt)`, for nodes within 0.2 mm of the floor. This is not the actual unilateral support reaction. It omits a downward tool load when gravity is off and old vertical velocity is zero. It can also apply friction to a separated node inside the 0.2 mm band. The coefficient 0.6 is a prescribed room assumption, not a learned liver-floor property.

Current central pair damping removes relative radial motion and conserves pair momentum; air drag and a speed clamp are separate numerical/room assumptions. Their losses must not be mistaken for material relaxation. Likewise, the current compliant grip is not a model of opposing jaw pressure and frictional slip. The visible shaft/jaws do not independently collide.

## What the primary evidence supports

| Primary source | Relevant evidence | Implementation decision |
|---|---|---|
| [Giles, Diaz & Yuksel, AVBD, SIGGRAPH 2025](https://graphics.cs.utah.edu/research/projects/avbd/) | Augmented Lagrangian updates address hard constraints and large stiffness contrasts in VBD. The authors demonstrate contact and friction. | A local augmented contact candidate fits the existing solver structure. Do not obtain accuracy merely by multiplying penalty stiffness; measure constraint residual and iteration dependence. The current browser is not a complete AVBD reproduction. |
| [Li et al., IPC, SIGGRAPH 2020](https://web.uvic.ca/~teseo/profile/publications/ipc/2020-IPC.pdf) | Barrier contact, contact-aware line search/CCD and a lagged dissipative friction potential are jointly required for its geometric guarantees. | Treat IPC as a reference design for geometric feasibility and friction, not a label for our finite quadrature penalty/augmented implementation. No intersection-free claim without the corresponding geometric checks. |
| [IPC technical supplement, section 9](https://ipc-sim.github.io/file/IPC-supplement-A-technical.pdf) | Friction depends on the normal load and a lagged tangent basis; the potential is differentiated consistently. | Base the friction cone on an actual contact reaction. A split velocity projection is a practical intermediate implementation, not an implicit static-stick solve. |
| [Convergent IPC, 2023](https://arxiv.org/abs/2307.15908) | Contact discretization and refinement require attention beyond nonlinear convergence at one mesh resolution. | Separately vary surface sampling, tetrahedral resolution, timestep and solver iterations. A zero sample overlap alone is not proof of full surface separation. |
| [Friction behavior at the grasper/liver interface, 2015](https://doi.org/10.1016/j.triboint.2014.08.013) | Ex vivo porcine clamping/dragging experiments found dependence on clamping load and dragging speed. | Do not transfer a single grasper friction coefficient to an arbitrary floor. A future jaw model needs pressure, slip and injury protocols; those data are not supplied by the visual geometry. |
| [Brunon et al., capsule tension to failure, 2010](https://pubmed.ncbi.nlm.nih.gov/20394930/) | Human/porcine quasi-static tests used local image-correlation strain. Failure strain and load per width were variable; freezing affected porcine failure properties. | Keep species, preservation and local/global strain definitions in the calibration schema. Failure values are not a small-strain bulk modulus or an automatic cutting threshold. |
| [Llewellyn et al., human capsule in cirrhosis, 2023](https://pmc.ncbi.nlm.nih.gov/articles/PMC10393548/) | Peeled, frozen/thawed human capsule was tested in PBS at 0.03 mm/s. Controls came from uninvolved metastatic-resection tissue. Response was biphasic; cirrhotic capsules were less stiff despite increased thickness. Reported control slopes were about 34 MPa at low strain and 124 MPa at higher strain. | Model a capsule as a separate thin membrane with measured thickness and strain-dependent response. These ex vivo slopes are not the parenchyma modulus. Disease effects cannot be reduced to globally increasing Young's modulus. |

The capsule full text was inspected through the primary article XML at [Europe PMC](https://www.ebi.ac.uk/europepmc/webservices/rest/PMC10393548/fullTextXML) when the PMC web page returned a browser challenge. The reported preservation, rate and control-tissue limitations matter. No capsule number from this review has been applied to the runtime.

## Implemented independent friction helper

The new [liverFloorFriction.ts](../../apps/studio/src/liverFloorFriction.ts) is a pure SI-unit helper; the mechanics owner integrates it into the solver. For the actual final constraint `y >= floor`, let `Phi` be the complete implicit incremental potential in joules. At a converged active constraint,

`normal reaction N = max(0, dPhi/dy)`.

`Phi` must include the inertial term `m |x - xhat|² / (2 dt²)`, current material terms and all current grip/probe potentials. The gradient is a force in N. It must be evaluated after the entire last sweep, because subsequent neighbouring-vertex updates make earlier gradients stale. A separated node has zero reaction. The helper uses a numerical active-gap tolerance of 1e-9 m and rejects a position that penetrates farther than that tolerance.

For tangent speed `v`, mass `m`, coefficient `mu` and timestep `dt`, the stationary-floor impulse is opposite slip with magnitude

`j = min(m |v|, mu N dt)`.

This cannot reverse the tangent velocity. Removed kinetic energy is

`D_friction = j |v| - j² / (2m) >= 0`, in joules.

The helper returns updated x/z velocities, x/z impulse (N s), normal impulse, cone limit and removed kinetic energy. It applies neither adhesion nor an attachment. Eight focused tests passed: gravity-free imposed compression, separated/tensile/no-load controls, slip cone saturation, stopping without reversal, tangent rotation invariance, passive energy loss over 81 mass/time/load/velocity combinations, constant-load timestep refinement and invalid-input handling.

**The reaction remains an approximation at a finite iteration budget.** A passive friction projection does not establish that its normal load is physically accurate. It also cannot remove the position drift already incurred during the preceding implicit solve; it is not an exact static-stick solver. The integration must expose reaction and residual diagnostics, and compare against extra iterations before promotion. If that comparison fails, retain it as a candidate rather than silently treating the estimate as ground truth.

## Measurable gates for the next candidate

These are proposed engineering acceptance thresholds, not clinical limits. Set them before comparing candidate runs; keep failures and do not change thresholds to turn a failing result into a pass.

| Test | Measurement and proposed gate |
|---|---|
| Gravity-free loaded floor | Downward probe preload on a body already resting on the floor. Nonzero compressive floor reaction; tangent friction impulse bounded by `mu N dt`, and zero in an otherwise identical `mu=0` control. Match total reaction to applied load within 5% after settling, with a small absolute force tolerance stated for near-zero loads. |
| No-load and separation | Exactly zero friction impulse for zero normal reaction; no floor force for a positive gap exceeding the numerical tolerance. Include the old problematic 0.1 mm separated case. |
| Passive split update | Removed kinetic energy is nonnegative within floating-point tolerance, tangent speed never increases or changes sign through zero, and impulse stays inside the cone for every tested update. |
| Floor reaction convergence | Compare the same checkpoint and tool history at 4/8 sweeps and dt/dt÷2. Report force-curve relative L2 error with an explicit denominator, final node RMS and reaction balance. Initial target: less than 5% force discrepancy in the nonzero-load part. Failure means a refinement warning/candidate status. |
| Probe contact continuity | Normal approach, surface-parallel sweep across face/edge boundaries, initial overlap and release. Force is compressive, zero after separation, no missing-contact holes, force derivative agrees with energy finite differences away from active-set kinks. |
| Probe geometric error | Measure actual sphere-to-triangle closest distance in addition to quadrature-sample penetration. Initial target for the ordinary 6 mm probe: maximum overlap below 0.5 mm on both actual cages. Report worst-case, not only a terminal average. |
| Contact work and reciprocity | Sum tissue force and tool reaction to zero within numerical tolerance. Moving tool work uses the actual advanced tool position, not the requested target. Paused/reset jumps are separate events. |
| Robustness and interaction | Positive tet Jacobians, finite state, no ordinary-case rejected physical time, floor penetration below the numerical bound, explicit limiter counts and achieved simulation/wall ratio. Retain strong-case camera coverage limits. |
| Replay and sensitivity | Export geometry/source hash, material provenance, coefficient assumptions, actual tool states, dt/sweeps and contact diagnostics. Repeat from the same saved checkpoint. A different settling history is not an isolated material/contact comparison. |

For a force curve `F(t)`, use `||F_candidate - F_ref||_2 / max(||F_ref||_2, F_floor)` on aligned common times, declaring the absolute normalization floor and excluding no time through warping. Report absolute N error as well. A gate comparing a solver to a refined solver is numerical consistency, not measured biological validation.

## Keep dissipation terms separate

A useful ledger reports tool work, kinetic-energy change, gravitational-energy change, material stored-energy change, material loss, floor friction loss, pair-damping loss, air-drag loss and numerical remainder separately. Do not report all decay as the learned relaxation fraction.

In particular, `continuumResponse.energyDensity` includes an **incremental Maxwell solve potential**. It is not simply the stored physical free energy. In the current convention, the committed branch stored energy density is `muBranch * sum(memory²)`; the incremental branch potential has a different time-step factor. Reusing the optimization objective as total mechanical energy would misstate passivity. Until a complete ledger is checked, label the helper's value precisely as *removed tangent kinetic energy from the floor-friction update*, not total dissipation.

## Capsule and supports: later controlled extensions

A capsule sensitivity experiment can use a surface membrane bonded to the volume, with surface stiffness expressed through modulus times thickness and a documented fibre/strain law. Required controls are zero membrane stiffness reproducing the baseline, membrane patch/rigid-rotation tests, mesh refinement, rate/cycle tests if a viscoelastic branch is added, and held-out force plus surface-deformation measurements. Published mean slopes alone do not identify thickness, prestress, anisotropy, and underlying parenchyma simultaneously. A high capsule/bulk stiffness contrast also increases solver demands, strengthening the case for addressing constraint convergence first.

An attached-organ experiment should expose measured/declared attachment sites, stiffness, bed contact and prestress as a separate protocol. It should not secretly replace the free-floor experiment. Neither rendered video motion nor a better contact solver identifies those biological boundary conditions by itself.

## Frozen implementation and assessment outcome

The frozen browser now uses augmented triangle contact and reaction-based floor friction. The [mechanics report](../../benchmarks/results/liver-contact-upgrade-2026-10-07/MECHANICS.md) and [final browser verification](../../benchmarks/results/liver-contact-upgrade-2026-10-07/browser/verification.json) preserve separate evidence classes. Eight helper tests and six independent capture-audit tests passed; all nine actual browser/API cases passed with no skipped or retried cases. This is a working experimental default, **not a force-converged or anatomically validated model**.

The predeclared force-refinement gate remains **NEEDS_REFINEMENT**. In the gravity-free female preload, final reaction-balance errors were 1.181% (four sweeps), 0.673% (eight), and 0.212% (half timestep), but the four/eight-sweep floor force changed 5.81%, exceeding the 5% target. The male case unloaded by four seconds, so its terminal near-zero load cannot validate loaded balance. The passive friction helper does not resolve these finite-sweep force errors.

A material geometry defect was independently exposed by the exported capture. The female cage has eight boundary edges incident to four triangles and one incident to six: **manifold status FAIL**. The 182 unique oriented surface faces exactly match the retained 324-tet exterior, and edge orientations balance; that permits diagnostic winding calculations, not certification of manifold anatomy. The mechanics investigation traced this to removal of 72 nearly coplanar Delaunay cells. Their volume is negligible, but 32 artificial internal faces add about 31.98% surface area. The male cage similarly has four nonmanifold edges and about 30.20% excess boundary area. See [cage boundary audit](../../benchmarks/results/liver-contact-upgrade-2026-10-07/cage-boundary-audit.json). A later repaired tetrahedralization must pass manifold, exterior-surface and contact-refinement gates. No silent geometry repair or runtime change was made after this run. Self-intersection assessment is **NOT_RUN**.

The first strict capture auditor stopped on this topology; its [original failure](../../benchmarks/results/liver-contact-upgrade-2026-10-07/development-capture-auditor-manifold-failure.json) is preserved. The final auditor reports numerical state checks separately from manifold failure, and computes distances only against the explicitly exported contact surface. Its result is not an anatomical-exterior contact claim.

## Actual browser and recording evidence

[Browser results](../../benchmarks/results/liver-contact-upgrade-2026-10-07/browser/results.json): **9/9 passed**, 153.65 seconds, covering mouse/touch grasp and release, probe alignment, pause/switch, punch and Orbit keyboard grip, gravity/floor, strong interaction, explicit material application, three accepted calibration histories, rejected unidentifiable calibration, and explicit camera-only Fit plus motion export. Existing deformation and timing gates were retained. The dedicated floor interval advanced 4.9667 simulated seconds in 5.0258 wall seconds (0.988×, approximately real time with 5 Hz diagnostic endpoint uncertainty). Floor-state mean step time was 2.66 ms; not every interaction ran at that cost, and up to 0.783 s accumulated dropped wall time was visible during the full instrument recording.

Eighty unique diagnostic snapshots had zero rejected steps/time, zero rejected vertex updates, zero floor penetration and at most six line-search backtracks. Their minimum Jacobian was 0.6756. The denser exported trajectories comprised **713 accepted samples**, including **225 active-probe samples**; these revealed a lower minimum Jacobian of **0.11446** during an interaction. Positive volume is a numerical integrity finding, not evidence of physiological strain. Independent frame camera validation passed on all exported samples. The grasper changed pair-distance RMS by 1.431 mm; the supported small probe changed it by 0.825 mm. Three independently paused punch observations changed pair-distance RMS by 0.0559, 0.1136 and 0.1133 mm (pause delays 71.5, 41.2 and 41.2 ms). These distances exclude rigid rotation and translation; height change does not.

The [instrument capture audit](../../benchmarks/results/liver-contact-upgrade-2026-10-07/browser/atlas-laparoscopic-tools-v-a512d-ase-on-pause-or-tool-switch/tool-motion-capture-audit.json) recomputes tetrahedron determinants and exact sphere–triangle distance from accepted centers. Maximum overlap was 0.008295 mm over the exported triangle set; runtime disagreement was only 0.00000201 mm. **This surface includes artificial internal faces, so external anatomical contact validity remains NOT_ESTABLISHED.** It is also a sampled trajectory maximum, not a guarantee between samples or full continuous collision detection.

The work audit excludes resets, activation/removal counter changes, missing contact and radius changes. Over 224 eligible adjacent pairs, at-most-30 Hz force/path trapezoids gave **0.023195 J**, versus **0.055696 J** accumulated by the 120 Hz solver on the same endpoints: a **58.4% underestimate**. Therefore sampled work agreement is **NOT_ESTABLISHED**. The export retains cumulative solver work, but force/path samples cannot faithfully reconstruct its substeps. Neither value is a complete energy balance or measured biological work. Floor-friction loss is specifically the passive tangent-velocity projection loss.

### Agent visual review

All nine unique raw clips (152.48 seconds total) were sampled at 12 uniformly distributed times, and the main instrument clip additionally at 16 frames in each of 2.5–6.0 s, 10–14 s and 25–28.5 s: **156 AI-agent-inspected frames**, not continuous review of every frame. Raw videos, optical-flow/image diagnostics and exact timestamps are retained in the [review ledger](../../benchmarks/results/liver-contact-upgrade-2026-10-07/browser/agent-visual-review.json). Pixel flow is confounded by tool motion, page scrolling, camera Fit/Orbit, reset, loading screens, resize and mobile recorder padding. It is not calibrated tissue strain, stiffness or force.

![Grasp and lift, with later explicit reset and panel scroll in the sequence](../../benchmarks/results/liver-contact-upgrade-2026-10-07/browser/video-review/dense-grasp/contact-sheet.jpg)

![Floor-supported probe interval](../../benchmarks/results/liver-contact-upgrade-2026-10-07/browser/video-review/dense-probe/contact-sheet.jpg)

![Probe release and tool switches](../../benchmarks/results/liver-contact-upgrade-2026-10-07/browser/video-review/dense-release/contact-sheet.jpg)

The tools remain visible at contact, with closed/open grasper states and a probe head aligned to actual accepted contact. Local deformation is subtle beside rigid motion. Large free-body movements still leave the fixed camera view; explicit Fit recovers framing without changing the physical state or releasing a held tool. The mobile view shows the shaft and jaws, while the remote handle can lie outside its narrow frame. Probe removal near 27.5 s is a lifecycle event; frame appearance alone does not establish relaxation rate or force accuracy.

[Playable instrument demonstration](../../benchmarks/results/liver-contact-upgrade-2026-10-07/browser/liver-contact-upgrade.mp4) is a transcode of the retained raw clip, not another independent experiment. The earlier v2 evidence remains unchanged. **Measured human-liver, expert human and clinical validation remain NOT_RUN.**
