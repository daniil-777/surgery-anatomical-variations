# Coupling review and integration gates

This review covers the six-compartment driver and the cardiovascular integration
in `VesselFlowExperiment`. Listed gates are review requirements, not an assertion
that every integration test has passed. CPU and browser evidence must be checked
separately before reporting completion.

## Initialization and model interpretation

- Initialize the circuit with `combinedInitialBloodVolume − localInitialVolume`.
  The local vessel already contains blood; treating both as independent full
  inventories creates blood at initialization.
- Prefer the initial no-hole local resistor balance
  `(Ps/Rin + Pd/Rout)/(1/Rin + 1/Rout)`. The local compliance then refers to
  that initial pressure/volume pair. External cardiovascular ports are signed;
  the balance therefore also represents reversed pressure gradients.
- The driver performs its own explicitly configured warmup. This does not
  equilibrate the attached branch. An early local transient is an initialization
  effect unless the full coupled system is equilibrated over whole cycles.
- The local segment is an extra parallel branch. It changes effective vascular
  resistance slightly; the model does not identify a particular patient's
  vascular network or subtract that branch from an existing anatomical tree.
- External cardiovascular ports now use signed, reversible inventory transfers.
  Both external donor inventories must be bounded. A local return to the source,
  a forward distal return and puncture outflow share the local minimum-volume
  budget. The independent finite bench reservoir retains its one-way contract.
- Both displayed segments must connect SA to SV. The venous case includes a
  large upstream microvascular resistance and a smaller downstream resistance.
  A direct SV-to-RV local branch would bypass the tricuspid valve and permit
  spurious RV-driven reflux when its ports are signed. It is not the chosen
  reference topology.
- The six-compartment source omits autonomic compensation. A fall in pressure
  after volume loss is an uncompensated model response, not calibrated shock.

## Transaction and convergence constraints

The current coordinator checkpoints the vessel and flight solver, prepares the
film, checks clocks and inventories, then commits the film last. Preserve that
ordering: commit the restorable cardiovascular state before the final film
commit, and restore all three checkpoints on any failure.

Pressure iteration must converge terminal source and distal pressures using
the two transferred volumes from the same pair of previews. The current
coordinator checks the terminal pressure residual at `1e-6 Pa` and feeds the
exact accepted local volume increments into the accepted circuit preview;
mass consistency is checked independently. Commit those exact previews.
Re-running one solver using a newly recomputed pressure after declaring
convergence changes the state that was checked. A failed iteration must leave
all physical clocks, inventories, emissions, landing events and telemetry intact.

Gauge pressures may be negative in intrathoracic compartments; they must not
be silently clipped to zero. The cardiovascular positive-transmural-pressure
domain and available stressed-source volume are separate constraints.

## Required coordinator tests

1. **Combined mass identity:** with and without holes, verify
   `circuit + local + inFlight + film − initialFilm + escaped =
   initialCircuit + initialLocal`. Returned distal flow must not appear as a
   second stored volume. Include all impacts outside the displayed tray.
2. **No duplicated source:** external-perfusion mode has no independent finite
   bench reservoir; circuit withdrawal equals the accepted local supplied-volume
   increment exactly within binary64 tolerance.
3. **Pressure fixed point:** inspect accepted source/distal pressures against the
   committed circuit at every step through valve switching and pulse extrema.
   Record iteration counts/residuals; do not accept a merely exhausted loop.
4. **Failure rollback:** force collector rejection, breakup capacity failure,
   source depletion and coupling nonconvergence. Deep-compare snapshots and
   diagnostic telemetry, then retry the same step after removing the cause.
5. **Clock/cadence independence:** identical fixed-step sequences grouped by
   different render cadences yield the same state and event identities.
6. **Timestep study:** compare coupled pressure, emitted volume and circuit
   volume change at 2, 1 and 0.5 ms over equal physical times. A closed-loop
   standalone convergence test does not cover a partitioned local coupling.
7. **Branch mapping:** both segments exchange SA/SV, with their distinct series
   resistances. Test signed gauge external pressure and reverse port transfers
   without a fabricated pressure clamp or a new bypass around a cardiac valve.
8. **Initialization and intact evolution:** nonzero circuit-driven flow exists
   before puncture; initial local storage is counted once; no prewet inventory
   is reported as patient blood loss. Record the finite startup transient.

The underlying requirement for closed-loop mass conservation and consistent
pressure/volume coupling is described in
[Kerckhoffs et al.](https://pmc.ncbi.nlm.nih.gov/articles/PMC2872168/).
The reference six-compartment topology is documented by
[CVSim's authors](https://physionet.org/content/cvsim/1.0.0/).
The tests above are specific engineering deductions for this implementation.

## CPU evidence collected 2026-10-20

- The standalone driver passed all 54 combinations of displayed heart-rate
  boundaries (45/140 bpm), resistance/contractility (0.75/1/1.25), and total
  inventory (4.5/5/5.5 L, less 1.733 mL initialized local storage). Each ran its
  warmup and one subsequent cycle. Minimum systemic arterial/venous gauges
  were 3291.97/378.35 Pa. RV gauge reached −416.05 Pa; this is not clipped.
- The final `createCardiovascularVesselPreset` helper and coordinator passed
  108 initialized artery/vein cases and two intact accepted steps each.
  Maximum combined volume error was `3.034e-15 m³`; maximum terminal coupling
  residual was `6.344e-8 Pa`. These short cases cover initialization, not
  long-term stability of the entire envelope.
- An actual open arterial puncture ran for one common second at 2/1/0.5/0.25 ms,
  with source/distal/local pressure and expelled-volume samples every 0.2 s.
  Against the 0.25 ms reference, pressure RMS errors were
  5.782/2.475/0.824 Pa; expelled-volume RMS errors were
  `1.951e-10 / 8.326e-11 / 2.763e-11 m³`. All transactions were accepted;
  physical deposits and capillary pinch events occurred. The collector grid
  was fixed at 16×16 in this temporal coupling study. This is not a spatial
  refinement study or a claim that discrete drop identities match across dt.

These checks reside in `cardiovascular.test.ts` and
`cardiovascularEnvelope.test.ts`. Actual UI/recording and clinical validation
are outside these CPU gates.
