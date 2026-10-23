/**
 * Catalogue of the Blood lab's simulation models.
 *
 * Every workspace is a different reduced model with its own scope. The selector
 * shows these side by side so a user picks the model that answers their question
 * rather than the one that looks most realistic. Claims here must stay in step with
 * each workspace's own notes; nothing in this table is a clinical validation.
 */
export type BloodWorkspace = "surface" | "pool" | "artery" | "film" | "liver" | "experiments";

export interface BloodModelEntry {
  id: BloodWorkspace;
  /** Exact accessible name of the selector button. Harness scripts click these. */
  label: string;
  method: string;
  dimension: string;
  engine: string;
  bestFor: string;
  interaction: string;
  verification: string;
  limits: string;
}

export const BLOOD_MODELS: readonly BloodModelEntry[] = Object.freeze([
  {
    id: "liver", label: "Liver bleeding",
    method: "Vessel-network bleeding + surface runoff film",
    dimension: "3D organ, 2D film on surface", engine: "WebGL · CPU solver",
    bestFor: "Cutting a liver and watching where blood emerges and runs",
    interaction: "Cut, orbit, vessel targeting, recording",
    verification: "Unit tests for anatomy, wounds, runoff, film conservation",
    limits: "Procedural vessels; no tissue mechanics, clotting or splash",
  },
  {
    id: "pool", label: "Blood pool",
    method: "Linear shallow-water heightfield (after webgpu-water)",
    dimension: "2.5D surface", engine: "WebGPU compute",
    bestFor: "Collected blood in a tray: drips, ripples, instrument wakes, optics",
    interaction: "Drip, probe, orbit, dilution presets, recording",
    verification: "Volume-exact deposits, dispersion/damping tests, GPU–CPU parity",
    limits: "No splash, capillary waves, meniscus or nonlinear steepening",
  },
  {
    id: "surface", label: "Free-surface fluid",
    method: "DFSPH particles with reconstructed surface",
    dimension: "3D", engine: "WebGPU compute",
    bestFor: "Bulk liquid motion in an open tray; solver verification fixtures",
    interaction: "Fixtures, resolution, particle/surface views",
    verification: "Density/divergence residual gate, analytic fixtures",
    limits: "Low resolution; no surface tension, wetting or bleeding",
  },
  {
    id: "artery", label: "Artery flow playground",
    method: "Axial velocity profile in a rigid tube",
    dimension: "1D radial profile, 3D view", engine: "CPU · WebGL",
    bestFor: "Pulsatile flow, shear and Carreau–Yasuda viscosity in a vessel",
    interaction: "Waveform, diameter, rheology",
    verification: "Womersley and Carreau steady reference solutions",
    limits: "Straight rigid wall; no branching, compliance or leak",
  },
  {
    id: "film", label: "Thin-film wetting",
    method: "Lubrication thin-film equation",
    dimension: "1D periodic", engine: "CPU",
    bestFor: "Capillary levelling and small-angle wetting of a blood film",
    interaction: "Film parameters, perturbations",
    verification: "Capillary levelling rate, Young–Laplace and wetting-ridge tests",
    limits: "Flat substrate, small slopes, one dimension",
  },
  {
    id: "experiments", label: "Blood experiments",
    method: "Tank waves & impact; arterial/venous puncture jets",
    dimension: "Mixed reduced models", engine: "CPU · WebGL",
    bestFor: "Measuring single effects: jets, breakup, collection, appearance",
    interaction: "Per-experiment controls, traces and exports",
    verification: "Per-experiment solver and envelope tests",
    limits: "Each isolates one effect; not a combined surgical scene",
  },
]);

export function parseBloodWorkspace(value: string | null): BloodWorkspace {
  return BLOOD_MODELS.some(model => model.id === value) ? value as BloodWorkspace : "surface";
}
