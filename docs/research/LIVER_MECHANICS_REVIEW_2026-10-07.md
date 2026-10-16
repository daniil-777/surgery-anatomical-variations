# Liver mechanics review and continuum solver decision

Date: 2026-10-07. Scope: primary mechanics literature, the implemented browser and recorded solvers, and a tested browser continuum candidate. This document distinguishes numerical verification, experimental evidence, and proposed acceptance thresholds. It does not certify surgical realism.

## Decision

Replace the browser's mesh-dependent edge calibration with the **same finite-strain material potential used by the recorded Python FEM**, subject to actual-cage stability and interaction gates. Keep the independent physics network as an inverse parameter estimator, and keep a named legacy option for reproducible comparisons. A more expressive neural estimator cannot fix a forward solver whose parameter meanings differ from its teacher.

The selected candidate uses vertex block descent (VBD) on an implicit-Euler incremental potential: local 3×3 Newton updates, a floor-admissible active set, exact affine-in-one-vertex determinant bounds, and energy backtracking. It preserves the existing force-equivalent spherical contact energy and compliant grasp attachment. It does not add an arbitrary hardening coefficient to make the organ look firmer. [VBD, SIGGRAPH 2024](https://graphics.cs.utah.edu/research/projects/vbd/vbd-siggraph2024.pdf) provides the relevant primal solver construction. Its published performance and unconditional-stability claims do not automatically apply to this TypeScript implementation, finite iteration count, or contact discretization.

A coupled equilibrium XPBD candidate and two rest-zero energy XPBD candidates were evaluated first. The coupled form passed homogeneous-tetrahedron tests but developed motion at rest on the real skinny cages. Rest-zero energies removed that initial drift, but floor-contact trajectories retained appreciable local velocity oscillations. These candidates were rejected for default use. The VBD candidate removed those observed oscillations without changing the learned Young modulus, Poisson ratio, or adding damping. Retain these development observations; they are more informative than presenting only the final successful run.

## What the current evidence does and does not show

The legacy free-organ room completes manipulation tests, but its edge energy is not a calibrated continuum law. Its spring coefficient is `6 μ Vshare / L²`; edge stretch also resists dilation and its effective material response depends on edge orientations and tetrahedralization. Volume compliance does not cancel that extra bulk response. It cannot claim the same Young modulus or Poisson response as the neural teacher or recorded FEM merely because the same parameter names are used.

The recorded model already has a defined strain-energy density, objective material memory, analytic Piola stress, SI force assembly, and measured stationarity checks. Its limitations include a convex cage, absent capsule/vessels, authored supports, and no measured liver-motion validation. Moving its law into the browser removes one model-transfer mismatch; it does not remove those domain and evidence limitations.

A roughly 50% change in world-axis bounding-box height is **not** proof of lost volume or excessive material strain. Falling rotation and lateral spreading contribute. The prior female baseline had approximately 2.2% total volume loss despite large height change. Evaluate rigid-invariant pair distances, aligned surface displacement, element Jacobians and total volume separately. Conversely, the manual `E=500 Pa, ν=0.2, g=0.75` corner actually lost approximately 45% volume and activated the old volume rescue more than a million times. It is a compressible numerical contrast case, not a plausible healthy-liver preset.

The gravity stress scale `ρ g L` is approximately 1 kPa for `ρ≈1060 kg/m³` and `L≈0.1 m`. It is not negligible compared with the demonstration's relaxed modulus. A free organ resting on a rigid floor lacks the capsule and surrounding anatomical support of a liver in surgery. Increasing stiffness until its silhouette looks pleasing would confound those missing mechanisms.

## Primary evidence map

The following sources were inspected through their primary publisher, author manuscript, or PubMed record. Study settings matter at least as much as a reported modulus. No single row supplies universal human-liver parameters.

| Primary study | Specimen and loading | Usable conclusion and transfer limit |
|---|---|---|
| [Nava et al., Medical Image Analysis 2008](https://pubmed.ncbi.nlm.nih.gov/18171633/) | Living human liver; 23 aspiration measurements on six healthy livers during open surgery | Direct human in-vivo evidence; inverse FE identification and repeated-cycle comparison. The paper reports disagreement with earlier inferred moduli, so aspiration geometry/contact and protocol must accompany any reused value. |
| [Mazza et al., Medical Image Analysis 2007](https://pubmed.ncbi.nlm.nih.gov/17719834/) | Ten human organs, aspiration in vivo and after resection, with histology | Pathology and connective tissue content matter; the reported stiffness index increased after resection. A pathology/color label is not an adequate mechanical measurement. |
| [Ozcan et al., Medical Image Analysis 2011](https://www.sciencedirect.com/science/article/abs/pii/S1361841510000824) | Fifteen harvested human livers with disease; impact-hammer frequency response | Dynamic storage moduli differed with fibrosis and frequency. Those frequency-dependent whole-organ measurements are not interchangeable with a quasi-static uniaxial Young modulus. |
| [Gao et al., Constitutive Modeling of Liver Tissue: Experiment and Theory](https://pmc.ncbi.nlm.nih.gov/articles/PMC2818268/) | Ex-vivo porcine parenchyma; capsule removed, frozen/thawed preparation; compression, tension and pure shear | Multimodal tests revealed that fitting one loading mode can fail another. Their macro-scale nearly incompressible/isotropic modeling choice is useful but preparation and gravity deformation limit direct human transfer. |
| [Chui et al., Medical & Biological Engineering & Computing 2007](https://pubmed.ncbi.nlm.nih.gov/17160416/) | In-vitro porcine liver; tension/compression by direction | Direction-dependent response was observed. Isotropy is a working simplification, not an established universal fact. Do not add an anisotropic field without orientation-resolved evidence. |
| [Lister, Gao and Desai, Annals of Biomedical Engineering 2011](https://pubmed.ncbi.nlm.nih.gov/21161684/) | In-vivo porcine probing with force, surface motion and geometry | Particularly relevant validation pattern: reproduce measured geometry and boundary conditions, account for gravity stress, compare force and displacement, then evaluate a capsule model. Ex-vivo parameter transfer was explicitly tested. |
| [Characterization of perfused and sectioned liver tissue, 2018](https://pubmed.ncbi.nlm.nih.gov/30500697/) | Ex-vivo perfused porcine liver, then sectioned; complete indentation cycles at 1–20 mm/s | Loading, unloading, rate and specimen state are all needed. A hold-only fit is insufficient to establish cyclic or surgical behavior. Reported curve fits are within-study fits, not human validation. |
| [Chatelin et al., Biorheology 2011](https://journals.sagepub.com/doi/10.3233/BIR-2011-0584) | Porcine liver, in vivo/in vitro; transient elastography and DMA | Testing time and boundary conditions changed the inferred response. Two relaxation modes were used over the reported frequency band; one branch is a deliberate reduced model. |
| [Marchesseau et al., Progress in Biophysics and Molecular Biology 2010](https://www-sop.inria.fr/asclepios/Publications/Stephanie.Marchesseau/PBMB-Marchesseau-2010.pdf) | DMA on 60 porcine samples; liver surgery simulation | Shows a practical hyperelastic/Prony/Darcy separation with efficient tetrahedral assembly. Perfusion and porosity are distinct mechanisms; adding a generic velocity damper does not reproduce them. |
| [Raghunathan et al., Annals of Biomedical Engineering 2010](https://pubmed.ncbi.nlm.nih.gov/20177783/) | Seventeen ex-vivo porcine samples, unconfined compression relaxation at several ramp rates | Poroviscoelasticity can represent fluid-pressure contributions. Useful when permeability, drainage length and fluid boundary conditions are identified; excessive complexity for an uncalibrated one-trace browser demo. |
| [Brunon et al., Journal of Biomechanics 2010](https://pubmed.ncbi.nlm.nih.gov/20394930/) | Human and porcine capsule/parenchyma tensile failure tests | Capsule failure must be distinguished from parenchymal behavior; species and tissue preservation affect transfer. Failure data do not directly supply a low-strain palpation stiffness. |
| [Experimental in-vitro characterization of Glisson's capsule and hepatic veins, Journal of Biomechanics 2011](https://www.sciencedirect.com/science/article/pii/S002192901100282X) | Fresh unfrozen porcine capsule and veins, separate quasi-static tensile tests | These structures are distinct mechanical constituents with nonlinear response. Their tensile moduli cannot be assigned throughout the bulk parenchyma. |
| [Glisson's capsule matrix structure and function, JHEP Reports 2023](https://www.sciencedirect.com/science/article/am/pii/S2589555923000915) | Human capsule tissue across liver disease states | Disease altered thickness, matrix and mechanics; the cirrhotic capsule was more extensible and less stiff in this study. A universal rule that every fibrotic structure must become stiffer is unsafe. |
| [Estimation of boundary conditions for patient-specific liver simulation, 2020](https://pubmed.ncbi.nlm.nih.gov/32451816/) | Synthetic and phantom observations, inferred effective ligament supports | Boundary estimation improved the model in that validation setting. Its effective springs were not claimed to identify true ligament properties; distinguish a practical support model from anatomical truth. |
| [Characterization and correction of intraoperative deformation in laparoscopic liver surgery](https://pmc.ncbi.nlm.nih.gov/articles/PMC5729961/) | Phantom and clinical surface observations | Multiple support regions and insufflation-related changes matter. A free-floor drop is a solver stress test, not a substitute for a supported surgical configuration. |

## Constitutive contract and units

For each tetrahedron, use its reference volume `V0 [m³]`, deformation gradient `F` and `J=det(F)`. Density sets lumped masses `ρV0/4 [kg]`. Inputs are `E0 [Pa]`, `ν0`, uniaxial relaxation fraction `gE`, and uniaxial time `τE [s]`.

```
μ0   = E0 / (2(1+ν0))
K    = E0 / (3(1−2ν0))
E∞   = E0 (1−gE)
μ∞   = 3 K E∞ / (9 K−E∞)
μb   = μ0−μ∞
τμ   = τE (3K+μ∞)/(3K+μ0)
Λ    = K+μ∞/3
γ    = 1+μ∞/Λ
W∞   = μ∞/2 (tr(FᵀF)−3) + Λ/2 [(J−γ)²−(1−γ)²]
```

`W∞` is an energy density in Pa (`J/m³`); total elastic energy is `ΣV0 W∞` in joules. The shift makes stress zero at the reference state. `Λ` is a reparameterized coefficient, not the ordinary first Lamé constant. [Smith, de Goes and Kim, TOG 2018](https://graphics.pixar.com/library/StableElasticity/paper.pdf) explains the relevant stable Neo-Hookean construction and linearization. This particular polynomial variant is the existing repository law; it is not claimed to be the empirically best liver law.

The relaxing state is the deviatoric Green strain `e=dev((FᵀF−I)/2)`. Store its five coefficients in an orthonormal symmetric trace-free basis. This represents all components exactly and avoids duplicated or missing shear factors. For a step `h`:

```
a = exp(−h/τμ)
b = (τμ/h)(1−a)
z = e_previous − (a/b) q_previous
Wbranch = μb b ||e−z||²
q_new   = a q_previous + b(e_new−e_previous)
P       = ∂(W∞+Wbranch)/∂F
```

This is an incremental solve potential, not accumulated dissipated heat. Fixed strain produces exponential memory relaxation. Material memory commits only after an accepted step; reset/drop clears it. The mapping reproduces the intended uniaxial SLS response in the small-strain limit with constant bulk modulus. At finite strain it is an objective Green-strain Maxwell engineering model. It has not been fitted against multimodal human tissue data.

A capsule extension should use a membrane energy on the actual outer surface, with measured thickness and a two-dimensional strain law. Its natural stiffness scale is `E_capsule × thickness [N/m]`; copying a bulk modulus in Pa into an edge spring is dimensionally wrong. Identify the thickness–modulus product when the experiment cannot separate them. Add anisotropy or multiple branches only when held-out loading modes justify the extra parameters. Capsule mechanics are recommended next; they are not included in this candidate.

## Solver choice and rejected alternatives

[XPBD, MIG 2016](https://doi.org/10.1145/2994258.2994272) relates compliant constraints to energy and accumulated multipliers. It does not make an arbitrary spring network a calibrated tissue model. [Macklin and Müller, MIG 2021](https://mmacklin.com/neohookean.pdf) derives stable Neo-Hookean constraint energies with reference-volume scaling; the nonzero rest gradients must cancel. Our block projection was an implementation experiment, not a paper replication. Its failure on skinny cages despite a passing single-tet test is retained in the development record.

[Small Steps, SCA 2019](https://mmacklin.com/smallsteps.pdf) motivates substepping rather than assuming that more iterations in a large step always help. We tested step and iteration refinement instead of selecting visually appealing settings. Corotational elasticity is a useful robust small-strain baseline but would not retain the recorded finite-strain law. A mixed pressure formulation or locking-aware elements remain preferable when nearly incompressible spatial refinement shows locking; changing solver names does not itself resolve element locking.

The selected primal objective is

`Φ(x)=Σ_i m_i ||x_i−x_pred_i||²/(2h²) + Σ_t V0,t W_t(F_t) + U_grasp + U_probe`,

subject to the authored floor and a reported positive-volume numerical bound. VBD updates one vertex at a time while holding its neighbors fixed. For the stable equilibrium law, the local vertex Hessian has the particularly useful form

`H_i = V0 [μ∞ ||∇N_i||² I + Λ (cof(F)∇N_i)(cof(F)∇N_i)ᵀ]`.

The determinant is affine in a single vertex, so its admissible step fraction can be bounded exactly before updating. The viscoelastic branch contributes its consistent local gradient and a stabilized positive local Hessian. Contact uses fixed reference-area quadrature, identical penalty energy and an exact nodal gradient; its Hessian is stabilized for the local solve. Energy backtracking checks the actual potential. These are numerical choices, not learned tissue parameters. No published global convergence theorem is asserted for the complete browser implementation.

## Measurable acceptance gates

These are engineering release criteria proposed for this repository, not medical standards.

1. **Constitutive verification:** rest stress zero; rigid-rotation objectivity with nonzero history; finite-difference Piola relative error below `1e−7`; small-strain Young and bulk modulus error below `1e−4`; mapped hold relaxation; Python–TypeScript energy/stress parity across nontrivial history paths. No parameter retuning between languages.
2. **Discrete mechanics:** actual male/female cages remain motionless without forces; freefall COM follows gravity before contact; no pinned nodes; uniform affine tests and mesh/time refinement. Preserve low-volume-cell tests rather than testing only well-shaped cubes.
3. **Tool/contact verification:** energy-gradient balance, contact continuity across triangle interiors and edges, finite-radius contact at 6–12 mm, release/reset state clearing, measured overlap, and full elapsed simulation time after repeated large grabs and impulses.
4. **Numerical integrity:** zero inversions and rejected whole steps in declared normal protocols; floor penetration below `0.01 mm`; every active volume safeguard, line-search backtrack and rejected vertex update counted. A stalled clock is failure even with finite coordinates.
5. **Convergence:** compare rigid-aligned surface displacement and pair-distance strain, volume, force/work trajectories and relaxation, not bounding-box height alone. Target less than 5% force-curve change and 1 mm corresponding-surface change under one refinement; more levels are required for a convergence claim. Freefall landing COM/yaw is contact-path sensitive and should not be silently aligned away when testing the trajectory itself.
6. **Runtime:** record both simulation and wall time, dropped time and p95 solver cost with exact hardware/source hashes. Render FPS alone is not evidence of real-time mechanics. Select 120 Hz/4 VBD sweeps only if actual tools pass; retain legacy when a candidate fails.
7. **Experimental validation:** matched specimen geometry, support and prestress; multi-rate loading–hold–unloading, tension/compression/shear or multiple contact geometries; specimen-level train/test splits; compare force and registered surface motion together. Video without calibrated force cannot identify absolute modulus. Occluded points are missing data, not zero displacement.

The continuum candidate's analytic law parity is a stronger claim than the legacy spring transfer. Human-liver validity remains unestablished until gate 7 has suitable independent measurements. The AI v2 estimator should report the excitation/model domain and reject poor forward fits; its network accuracy must not be used to certify this unmeasured domain transfer.


## Promotion evidence and unresolved gates

The continuum implementation was promoted to the browser default after the analytic material tests and actual-cage interaction tests passed. The legacy option remains available for explicit comparisons. The default is a 1/120 s step with four VBD sweeps; legacy uses 1/240 s with ten XPBD iterations. Source hashes, exact parameters, per-stage positions and diagnostics are preserved in [the comparison record](../../benchmarks/results/liver-continuum-2026-10-07/comparison.json) and [its readable assessment](../../benchmarks/results/liver-continuum-2026-10-07/README.md).

Eight male/female/default/soft/stiff protocols completed 13 simulated seconds each after reset, including a 75 mm drop, 60 mm diagonal grasp, 6 mm-radius probe, release, and three 1.5 m/s impulses. There were no inverted cells, rejected whole timesteps or floor penetration. This is a numerical integrity result. It does not mean every local nonlinear update converged: backtracks, rejected vertex updates and volume limits are counted, and the fixed four-sweep solve has no equilibrium-residual acceptance threshold. `final_sweep_max_displacement_mm` is a progress diagnostic only. The default male manipulation activated the J=0.1 bound; that part of the trajectory is numerically constrained.

Default continuum final total-volume changes were −1.16% (male) and −1.24% (female), versus −1.89% and −2.16% for legacy. Rigid-invariant pair-distance recovery residuals were 0.035 and 0.020 mm, versus 0.189 and 0.049 mm for legacy. The material-law transfer, volume response and recovery residual improved in these declared protocols; this does not establish human validity. Default 6 mm-probe overlap reached 1.35 and 0.72 mm. The numerical penalty remains appreciably compliant.

The manually selected E=500 Pa, ν=0.2, g=0.75 corner lost 64–73% of volume, activated the positive-volume bound heavily, and produced up to 5.51 mm probe overlap. This is a strongly compressible material under substantial gravitational loading, unsuitable as a healthy nearly incompressible liver reference. Finite coordinates and advancing time do not make this response anatomically acceptable. The contrasting stiff corner stayed finite with final volume changes around −0.13%.

Twenty-two targeted Vitest checks passed: eight material tests and fourteen solver cases, including 48 Python history-state comparisons, actual skinny cages, modulus response, recovery, and fault-injected rollback. Rejected whole steps now preserve particles, velocities, committed material history, mechanical tool positions and the accepted contact diagnostic; requested targets remain user input. `rejected_time_s` accounts for attempted time that did not advance. Independent review also verified the area-weighted sphere energy gradient to relative error below 9e−10.

The complete spatial/contact/force-work convergence gate remains **incomplete**, and matched human experimental validation remains **NOT_RUN**. Temporal and iteration sensitivity are recorded separately in [refinement.json](../../benchmarks/results/liver-continuum-2026-10-07/refinement.json); a single mild volume difference does not prove force or contact convergence. Node runtime measurements were collected under concurrent QA load and are descriptive. Per-edge room damping remains mesh-dependent and separate from the verified tensor material relaxation. The cage still encloses a convex proxy, has no calibrated capsule, and lacks anatomical attachment and perfusion conditions. Those limits remain part of the promoted model description.


A final review caught a concrete floor optimization defect: clipping only dy after a full coupled Newton solve can leave non-descent x/z motion. The corrected solver fixes the active y step and solves the reduced 2×2 XZ system, retaining determinant safeguards and energy backtracking. An analytic regression reproduces the clipping failure and checks free-axis stationarity and the floor multiplier sign. Independent random-SPD review covered 10,000 blocks. The corrected full interaction suite has zero rejected vertex updates in all six continuum cases (default and both parameter corners across both cages); default male/female each used only one backtrack. Earlier evidence is retained as development material. A cyclic material test additionally checks positive dissipated work after subtracting final Maxwell stored energy, convergence under 128→256 steps, and zero net work for the elastic control. It does not assert energy conservation for the gravity/tool/room system.


The common-checkpoint probe refinement uses identical settled positions, velocities and Maxwell history, so differing landing orientations cannot masquerade as integration error. Halving the step from 1/120 to 1/240 s changed the entire reaction-vector curve by 3.29% in relative L2 norm, its endpoint by 0.85%, and corresponding cage nodes by 0.223 mm RMS. Doubling VBD sweeps from four to eight changed the force curve by 2.29%, its endpoint by 4.52%, and corresponding nodes by 0.541 mm RMS. Both meet the proposed 5% force-curve / 1 mm node criterion for this single female-cage probe test. Independently repeating the preceding drop produced different landing trajectories and substantially different contact forces; those trajectories must not be treated as converged. Spatial refinement, other loading modes, complete force/work convergence and human measurements remain outstanding.
