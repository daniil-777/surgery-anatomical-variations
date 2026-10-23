# Closed-loop cardiovascular driver

This optional driver provides pressure and finite blood inventory to a local
bleeding experiment. Its arterial pressure emerges from ventricular pumping,
vascular compliance, resistance and venous return. It is an independently
implemented educational six-compartment model, not a patient-specific model or
a clinically validated prediction of hemorrhage.

## Equations and provenance

The model topology follows the six-compartment family documented by
[CVSim's authors](https://physionet.org/content/cvsim/1.0.0/): left and right
ventricles, systemic arteries/veins, and pulmonary arteries/veins, connected by
four ideal cardiac valves and two vascular resistances.

The pressure-volume and flow relations are standard lumped-element equations:

```
P_i = P_external,i + E_i(t) (V_i - V0_i)
Q_ij = (P_i - P_j) / R_ij                 vascular resistance
Q_ij = max(0, (P_i - P_j) / R_ij)         ideal cardiac valve
dV_i/dt = sum(inflows) - sum(outflows)
```

[Kerckhoffs et al.](https://pmc.ncbi.nlm.nih.gov/articles/PMC2872168/)
explain why closed circulation and flow continuity matter for ventricular
loading. We implement neither that paper's finite-element heart nor its
canine parameter set. [SimVascular's reduced-order documentation](https://simvascular.github.io/documentation/rom_simulation.html)
provides context for the distinction between zero-, one-, and three-dimensional
hemodynamic models.

Numerical baseline values come from the factual CVSim-6 reference tables in
[De Florio et al., Appendix A](https://arxiv.org/html/2408.07201v1#A1).
All are converted to SI at the module boundary. One barye is 0.1 Pa, so
mL/barye converts by `1e-5` to m³/Pa, and barye·s/mL by `1e5` to Pa·s/m³.
There is no copied third-party implementation, figure, trained model, or asset.

| Quantity | Baseline |
|---|---|
| Heart rate; thoracic gauge pressure; systolic fraction | 72 bpm; −4 mmHg; 0.33 |
| Diastolic compliance LV / RV | 7.5e−8 / 1.5e−7 m³/Pa |
| Systolic compliance LV / RV | 3e−9 / 9e−9 m³/Pa |
| Systemic arterial / venous compliance | 1.2e−8 / 7.5e−7 m³/Pa |
| Pulmonary arterial / venous compliance | 3.23e−8 / 6.3e−8 m³/Pa |
| Aortic / tricuspid / pulmonary / mitral resistance | 8e5 / 6.666e6 / 4e5 / 1.333e6 Pa·s/m³ |
| Systemic / pulmonary vascular resistance | 1.33322e8 / 1.0666e7 Pa·s/m³ |
| Unstressed volumes LV / SA / SV / RV / PA / PV | 15 / 715 / 2500 / 15 / 90 / 490 mL |

The module uses a smooth raised-cosine contraction and relaxation, with
relaxation lasting half the nominal systolic interval. This is an explicit
activation convention, not a measured ECG or a prescribed blood-pressure
waveform. Default circulating inventory is an illustrative 5 L. The initial
stressed volume is distributed positively, followed by 24 closed-loop
equilibration cycles before the public clock starts. Warmup is explicit in
configuration and can be disabled for numerical experiments.

## Conservative solve and coupling

Backward Euler advances compartment **volumes**, with elastances evaluated at
the end of each accepted step. Each resistance contributes equal and opposite
volume fluxes. A six-by-six pivoted solve is performed for an active valve set;
if necessary the remaining sets are checked against their pressure inequalities.
The method does not clip negative flow through ordinary vascular resistances or
correct total volume after solving. Ideal valves prohibit regurgitation.

`prepareStep(exchange)` is a side-effect-free preview. The caller supplies
accepted signed local inflow and return **volumes**; `commit()` accepts the preview
only if no intervening state change occurred. Opaque checkpoints support
coordinator rollback. A caller can iterate pressure boundaries and volume
transfers until the local-vessel and circulation previews agree, then commit
all participating models. The coupled coordinator must test convergence and
timestep sensitivity.

Both displayed local branches withdraw from systemic arterial inventory and
return distal flow to systemic veins. For the venous segment, a large upstream
resistance represents unresolved microvasculature; the smaller downstream
resistance places the displayed segment near venous pressure. This keeps the
four cardiac valves within the six-compartment circulation rather than creating
an artificial parallel path around the tricuspid valve.

The local series resistances are illustrative reference values: arterial
upstream/downstream `3e9 / 2e10` Pa·s/m³; venous `2e10 / 8e8` Pa·s/m³.
They are not fitted to a named vessel. The added branch is parallel to the
existing systemic resistance and therefore slightly increases its overall
conductance; an existing anatomical branch has not been removed from that
lumped resistance.

Positive `toLocalM3` withdraws from
the source; negative values refund it. Positive `fromLocalM3` returns to the
distal compartment; negative values withdraw from that compartment during
reverse outlet flow. Neither local arterial port is implicitly a cardiac
valve: a signed local loss model must preserve these directions. Returning
blood is **not** also counted as an external
collector inventory. Escaped blood, in-flight liquid, local storage and
collector deposits remain outside the six circulating compartments.

The circuit-only identity is:

```
circulatingVolume + cumulativeNetTransferToLocal = initialCircuitVolume
```

For a fixed whole-system initial inventory, deduct the initialized local vessel
volume from the circuit's initial volume. A collector's independently supplied
initial wetting film is not patient blood loss and must be subtracted from the
combined ledger. The coordinator owns these combined-system checks.

## Numerical domain and omissions

Each donor-volume limit is its remaining stressed inventory; available limits
are exposed for systemic arteries, systemic veins and the right ventricle.
The two signed port transfers are combined before checking inventory, including
the case where both ports reference the same compartment. Steps that would
leave a compartment below its unstressed volume are rejected without mutation;
this linear model does not simulate venous collapse. Supported parameter bounds
are numerical limits, not clinical normal ranges. The default timestep is 2 ms;
smaller steps are needed when a convergence study indicates unresolved valve
transients.

No atrial chambers, baroreflex, autonomic compensation, respiratory coupling,
vascular autoregulation, ventricular septal mechanics, flow inertance, clotting,
coagulation, tissue perfusion oxygen transport or 3D vessel-wall mechanics are
included. A blood-loss experiment therefore shows an **uncompensated reduced
model response**, not a prediction of shock in a real person.

Tests check compartment balances, nonnegative ideal-valve flow, total inventory,
transactional previews/rollback, malformed-input rejection, timestep convergence,
passive energy dissipation and pressure/output response to controlled blood
removal. These validate implementation properties and model behavior; they do
not establish clinical accuracy.
