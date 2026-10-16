# Liver physics AI: next upgrade

Requested 2026-10-07 and activated by the subsequent request for deeper research and improved physics. The [v2 inverse estimator](PHYSICS_LEARNING_V2.md) is now implemented, trained and synthetically evaluated. It delivers varied small-strain loading, bounded physical refinement, separate uncertainty calibration and identifiability rejection. The [method selection review](research/LIVER_PHYSICS_METHOD_SELECTION_2026-10-07.md) and video audit separate numerical, visual and biological evidence.

This remains the broader roadmap. Conforming organ meshes, capsule/prestress, learned nonlinear multi-branch constitutive response and independent measured-liver validation are not completed by the v2 estimator. The neural proposal reduces fit iterations but does not outperform conventional fitting in final accuracy or median latency; that original aspirational gate below is therefore **not established**. See the frozen report for the actual predeclared iteration gates and all uncertainty tails.

## Starting point

The separate v1 inverse network estimates instantaneous Young modulus, one relaxation fraction and one relaxation time from a calibrated, small-strain uniaxial ramp/hold/release observation. Its training and held-out evaluation are synthetic. The interactive browser transfers those estimates into an approximate edge/volume constraint model; the recorded experiments use a separate finite-element material law. Neither has measured human-liver validation.

The present limitation is therefore broader than prediction error on the synthetic v1 test set. A stronger release must improve the material law, calibration data, numerical mechanics and independent validation together.

## Proposed implementation order

1. **Conforming mechanics and dependable contact.** Replace the convex enclosing volume with a quality-controlled tetrahedral parenchyma domain. Introduce a capsule and explicit boundary-condition presets for a free organ on a floor versus attached anatomy. Validate contact and volume preservation over multiple resolutions and time steps. Keep interactive approximation error visible against an offline reference solver.
2. **Richer learned constitutive response.** Add nonlinear strain stiffening and multiple relaxation times through a constrained energy/dissipation formulation. Enforce positive stiffness/dissipation, objectivity, a stress-free reference and consistent material history. Compare a fitted parametric hyper-viscoelastic baseline with a constrained neural constitutive model before choosing the serving model.
3. **Calibration that identifies those properties.** Support multiple deformation amplitudes, rates, relaxation holds, compression and shear. Retain calibrated dimensions, force units, sample timing, specimen identity, temperature and preparation. A single small-strain trace cannot identify capsule mechanics, large-strain stiffening, friction and fracture simultaneously.
4. **Robust inverse learning.** Train with multiple loading histories, measurement noise and realistic nuisance variables. Add forward-response losses and bounded inverse refinement. Quantify parameter identifiability and validate uncertainty coverage on held-out specimens. Separate inadequate excitation, out-of-distribution observations and model mismatch from numerical failure.
5. **Measured-data evaluation.** Keep human, cadaver and animal observations distinct. Fit training specimens only; select on validation specimens; freeze an independent final test set. Compare force histories, calibrated surface motion, relaxation/recovery and contact footprints under unseen loading paths. Explicitly report any real data that are unavailable.
6. **Regional anatomy and cutting.** Once the intact model passes, introduce regional tissue/capsule differences and calibrated irreversible fracture. Evaluate cutting forces and opening against independent incision experiments. Predefined seam release remains a separate prototype until those measurements support a fracture model.

## Release gates

- All interactive gravity, drop, grab, push, release and impulse regressions pass, including both current liver meshes and the previously failing 75 mm drop/reset sequence.
- No invented tissue measurements or clinical accuracy claims; each dataset has units, provenance, license and specimen split records.
- Held-out comparisons show an improvement over v1 and over an appropriate non-neural constitutive baseline, with reported latency and model complexity.
- Unseen loading rates and amplitudes are tested; a better same-family synthetic interpolation score alone is insufficient.
- Stable material history and passivity/objectivity checks pass. Mesh, time and contact sensitivity are reported separately from tissue agreement.
- The release records neural weights, training configuration, data hashes, solver revision, uncertainty limits and supported calibration protocols.

## Primary method references to evaluate

- [Kalina, Brummund and Kästner, finite-strain incompressible viscoelastic PANN framework (2026)](https://www.sciencedirect.com/science/article/pii/S0045782526001659): a candidate framework for constrained energy, dissipation and internal variables. Its reported applications do not constitute liver-specific validation.
- [Tac et al., benchmarking physics-informed frameworks for data-driven hyperelasticity](https://pmc.ncbi.nlm.nih.gov/articles/PMC11090478/): compares constrained constitutive network families and the physical conditions they enforce.
- [Bourdyot et al., experimental PANN code and data](https://cjailin.github.io/Experimental_PANN_learning/): a reference for learning from registered 3D displacement observations and mechanical equilibrium; inspect dataset material and licensing before reuse.
- [Macklin and Müller, constraint-based stable Neo-Hookean materials](https://matthias-research.github.io/pages/publications/neohookean.pdf): a reference for a closer constitutive link between interactive compliant constraints and continuum mechanics. The current playground uses an edge/volume approximation instead.

The existing [implementation evidence review](../research-report/Liver%20Physics%20Implementation%20Evidence%202026-10-07.md) remains the liver-specific literature and evidence inventory. No new human-liver measurements were acquired in the hands-on implementation.
