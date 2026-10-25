# Anatomical contact revision — 2026-10-25

## Defects found

The previous displacement field applied a compact Euclidean contact kernel to every displayed soft mesh. Thus two unjoined organs at the same coordinate received the same indentation, even when neither had an anatomical attachment or an active collision constraint. Its three-nearest-centre spring graph also treated spatial proximity as permanent adhesion. Tool load transfer to global modes was an arbitrary 10% of the selected organ's reaction.

The cavity wall was marked as skeleton in the viewport and never bound to the soft-tissue solver. Its material table already contained an authored supported-wall material, but a higher modulus is not a mechanical boundary condition.

## Implemented model

The VirtaMed viewport supplies the registered material-interface graph plus one separately authored cystic/hepatic duct joint as the mechanical attachment graph. The duct centrelines meet at `[-2, -24, -16]` mm in the scene construction; their overlapping surfaces are not a welded lumen. No artery tether or wall adhesion is inferred from proximity. Each connected component has its own continuous trilinear coarse field and local contact kernels. Independent components retain independent fields; permanent joints share the same field, so their duplicate attachment coordinates remain coincident. An explicit empty graph means no permanent joins. Generic atlas callers that omit the graph retain their existing spatial approximation.

`bind(rest, organId)` and `samplePoint(rest, organId)` select the correct anatomical field. Unowned sampling retains the legacy shared spatial field and must not be used to infer motion on overlapping independently labelled organs.

Coarse reaction transfer is now the transpose of the actual displayed-anchor interpolation basis, `JᵀF`, for the registered scene. A barycentric attachment uses the weighted basis of all three displayed triangle vertices. This is consistent with virtual work for the reduced interpolation; it does not turn the interpolation into a volumetric FEM model. Existing damping, implicit 120 Hz SLS integration, strain stiffening, unilateral push and bounded grasp remain in place. Projection bounds are evaluated separately per component, so recovering tissue in one component cannot constrain an unrelated component through a shared scale.

The wall has an explicit fixed coarse mode, with a supported, local, recoverable contact field. Breathing does not translate or inflate the whole shell. The support condition is authored and is not inferred from video.

Diagnostics expose registered components, basis load weights and reduced modal stored energy. The energy includes coarse/local elastic energy, Maxwell branch energy, kinetic energy and attachment spring energy. It excludes virtual tool and projection work and is not a measured tissue strain-energy integral.

## Evidence and interpretation

The contact-specific suite passes 33 tests: 26 solver tests and 7 response tests. The accompanying VirtaMed scene tests include a real triangle press and recovery on all 12 structures, including the cavity wall. Existing fixed-step replay and material-dependent compliance checks remain passing.

New regression checks verify:

- Coincident but unjoined bowel and wall remain exactly still during a liver load with breathing off.
- Connected host/sheet vertices stay identical, including chained attachments and barycentric anchors.
- Every supported tissue receives a compressive-only push, and unknown ownership or broken attachment graphs are rejected.
- Release changes neither the displayed position nor stored energy instantaneously. Over 600 substeps for each of push and grasp, reduced modal energy is nonincreasing, recovery is smooth, and the spatial derivative bound remains at most 0.45.
- Alternating 1-, 2-, 9- and 12-substep render frames replay the same physical states exactly.
- The wall remains globally stationary through breathing while allowing local indentation and subsequent recovery.

A reaction near 0.07 N is not itself evidence of a solver bug: the virtual tool spring is 180 N/m, so a 0.39 mm residual produces approximately 0.07 N. Force magnitudes were not increased to make the preview look more forceful. Their accuracy still depends on unvalidated material, dimensional and boundary assumptions.

## Primary mechanics references

[In Situ Measurement and Modeling of Biomechanical Response of Human Cadaveric Soft Tissues for Physics-Based Surgical Simulation](https://pmc.ncbi.nlm.nih.gov/articles/PMC2693244/) reports nonlinear indentation, relaxation and hysteresis in cadaveric liver and stomach. It motivates retaining strain- and history-dependent response; it does not validate the parameters of this scene.

[Baraff and Witkin, Large Steps in Cloth Simulation (SIGGRAPH 1998)](https://publications.ri.cmu.edu/large-steps-in-cloth-simulation) motivates implicit treatment of stiff deformation and constraint systems. The present solver is a bounded reduced-order approximation, not that paper's full cloth formulation.

## Actual-mesh extreme-contact stress review

The added `virtaMedContactStress.test.ts` runs 24 cases: all twelve structures receive a 20 mm requested push and an oblique 11.66 mm requested grasp. It checks all twelve component-owned meshes at 16 temporal samples per case, including the first physical step, hold, immediate release and four seconds of recovery. In total, 384 scene states cover 104,613 vertices and 206,373 nondegenerate triangles per state, plus all 188 registered interface roots.

This test initially exposed a genuine source defect: one liver attachment triangle had double area 0.0000021166 mm² and a 1.2323 mm edge, giving an altitude below one Float32 coordinate step. That nearly collinear face could reverse its numerical normal under otherwise bounded deformation. The source registration routine was corrected to classify near-edge/vertex insertions using physical Float32 precision and to split both incident faces. The strict orientation assertion was retained; force limits were not reduced to conceal the defect.

After the source correction, all 24 cases pass. Across all 384 states:

- Minimum triangle area ratio to rest: **0.774990**; maximum: **1.270703**.
- Minimum rest/deformed normal cosine: **0.947067**, with no tested orientation reversal.
- Maximum registered-root gap: **0 mm**, including duplicate vertices.
- Maximum reaction: **3 N**; maximum component derivative bound: **0.45**.
- Release causes **zero instantaneous vertex displacement**. Sampled recovery energy is nonincreasing, with at most **0.6868%** of held energy remaining after four seconds.

The source also contains 648 preexisting collapsed or near-zero loft-pole triangles, with double area at most 0.000001 mm²; these are counted explicitly and excluded from unstable normal/area ratios. Every vertex, including their vertices, is still checked for finiteness. The review checks these particular load histories on baseline authored meshes, not arbitrary loads, disease variants, collision avoidance or physiological validity. Full receipts and original failing diagnostics are retained in the release's local review artifacts.

## Biliary continuity regression

A 10 mm gallbladder-neck grasp held for 1.2 seconds moved the actual matched cystic/hepatic surface witnesses from a rest gap of 0.003635 mm to 0.003909 mm with the explicit joint. The same load with that joint omitted produced a 0.852876 mm separation. The regression checks both conditions, so it detects a missing mechanical edge rather than only inspecting the declared component graph. This establishes consistency of the authored overlapping geometry, not a validated biliary lumen or physiological junction stiffness.

## Remaining limits

There is no resolved organ-organ nonpenetration or friction solve. Tissue that is close but not registered as attached does not automatically transmit load. A robust extension requires oriented surface contact witnesses, relative motion and an implicit contact solve; bounding boxes or spheres would generate false contacts for hollow shells and interleaving anatomy.

The connected-component kernel is still Euclidean within one anatomical component, not intrinsic through the mesh volume. Membranes, hollow viscera, pressure, near-incompressibility, thickness-dependent buckling and tissue failure are not independently resolved. Sliding pressure footprints can change the displayed field independently of the modal velocity diagnostic; that limitation is explicitly reported by `speed_scope`. Parameters remain synthetic/authored and have no patient or clinical calibration.
