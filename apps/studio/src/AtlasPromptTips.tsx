import { BookOpen, Check, ChevronDown, ChevronUp, Copy, Eye, Layers, Microscope, Play, RotateCcw, Ruler, Sparkles, Stethoscope, Wand2, X } from "lucide-react";
import { useMemo, useState } from "react";

export type PromptTipCategory =
  | "all"
  | "pathology"
  | "morphometry"
  | "optics"
  | "recovery"
  | "multi-organ";

export interface PromptTipItem {
  id: string;
  category: Exclude<PromptTipCategory, "all">;
  organId: string;
  organLabel: string;
  badge: string;
  title: string;
  clinicalSummary: string;
  metrics: string[];
  prompt: string;
  malePrompt?: string;
  featuredQuick?: boolean;
}

export const SURGICAL_PROMPT_TIPS: readonly PromptTipItem[] = [
  // 1. HEPATOBILIARY PATHOLOGY (LIVER)
  {
    id: "liver-cirrhosis-macronodular",
    category: "pathology",
    organId: "liver",
    organLabel: "Liver",
    badge: "Pathology · Cirrhosis",
    title: "Macronodular Cirrhosis & Fibrotic Parenchymal Atrophy",
    clinicalSummary:
      "Pronounced regeneratory surface nodularity across 6 zones with lateral parenchymal contraction, caudate-right lobar asymmetry, and dense fibrotic capsule relief.",
    metrics: ["Severity 0.84", "Irregularity 0.88", "6 Sites", "Width −6%", "Asymmetry +0.35", "Structure 0.68"],
    prompt:
      "Alcohol-associated cirrhosis, severity 0.84, irregularity 0.88, spread 0.78, contrast 0.82, count 6, reference shape, 6% narrower, asymmetry 0.35, rich surface, structure strength 0.68, wetness 0.42",
    featuredQuick: true,
  },
  {
    id: "liver-hcc-exophytic",
    category: "pathology",
    organId: "liver",
    organLabel: "Liver",
    badge: "Oncology · Focal Mass",
    title: "Exophytic Hepatocellular Carcinoma (HCC) Mass",
    clinicalSummary:
      "High-relief focal neoplastic mass deforming the hepatic dome with asymmetric right-lobe expansion, hypervascular pigment contrast, and glistening serosa.",
    metrics: ["HCC Profile", "Severity 0.86", "Size 0.74", "2 Sites", "Width +7%", "Depth +5%", "Wetness 0.82"],
    prompt:
      "Hepatocellular carcinoma, severity 0.86, size 0.74, irregularity 0.82, contrast 0.85, count 2, reference shape, 7% wider, 5% deeper, asymmetry 0.32, moist surface, wetness 0.82, fine detail 0.72",
    featuredQuick: true,
  },
  {
    id: "liver-metastases-bilobar",
    category: "pathology",
    organId: "liver",
    organLabel: "Liver",
    badge: "Oncology · Multifocal",
    title: "Bilobar Colorectal Hepatic Metastases (7 Deposits)",
    clinicalSummary:
      "Widespread multifocal subcapsular metastatic deposits with umbilical-like optical contrast, global parenchymal hepatomegaly, and sharp micro-relief.",
    metrics: ["Metastases", "7 Sites", "Spread 0.85", "Contrast 0.88", "Width +5%", "Depth +6%", "Fine Detail 0.74"],
    prompt:
      "Hepatic metastases, severity 0.82, size 0.58, spread 0.85, irregularity 0.76, contrast 0.88, count 7, reference shape, 5% wider, 6% deeper, rich surface, fine detail 0.74, structure strength 0.58",
    featuredQuick: true,
  },
  {
    id: "liver-steatosis-hepatomegaly",
    category: "pathology",
    organId: "liver",
    organLabel: "Liver",
    badge: "Metabolic · Fatty Graft",
    title: "Severe Macrovesicular Steatotic Hepatomegaly",
    clinicalSummary:
      "Diffusely enlarged, blunted-margin fatty donor liver (+8% width/depth, +7% height) with warm yellow-ochre lipid tint shift and softened lobular sheen.",
    metrics: ["Steatosis", "Severity 0.85", "Spread 0.90", "Width +8%", "Height +7%", "Depth +8%", "Warm Tint +0.28"],
    prompt:
      "Diffuse enlarged fatty-liver appearance, severity 0.85, spread 0.9, size 0.78, contrast 0.74, reference shape, 8% wider, 7% taller, 8% deeper, soft surface, tint 0.28, wetness 0.68",
    featuredQuick: true,
  },
  {
    id: "liver-capsular-cyst",
    category: "pathology",
    organId: "liver",
    organLabel: "Liver",
    badge: "Benign Lesion · Cystic",
    title: "Tension Subcapsular Hepatic Cystic Bulge",
    clinicalSummary:
      "Smooth, tense solitary subcapsular cyst projecting from the anterior surface with low boundary irregularity, anteroposterior expansion, and high specular wetness.",
    metrics: ["Subcapsular Cyst", "1 Site", "Size 0.76", "Irregularity 0.32", "Depth +5%", "Wetness 0.88"],
    prompt:
      "Subcapsular cystic bulge, severity 0.82, size 0.76, irregularity 0.32, contrast 0.78, count 1, reference shape, 5% deeper, bend 0.24, moist surface, wetness 0.88, fine detail 0.64",
  },
  {
    id: "liver-cirrhosis-micronodular",
    category: "pathology",
    organId: "liver",
    organLabel: "Liver",
    badge: "Pathology · Early Fibrosis",
    title: "Early Micronodular Portal Fibrosis",
    clinicalSummary:
      "Subtle early-stage cirrhotic remodeling with fine cobblestone texture across 5 zones, mild 3% lateral contraction, and balanced parenchymal pigmentation.",
    metrics: ["Cirrhosis", "Severity 0.44", "Irregularity 0.52", "5 Sites", "Width −3%", "Structure 0.52"],
    prompt:
      "Alcohol-associated cirrhosis, severity 0.44, irregularity 0.52, spread 0.62, contrast 0.48, count 5, reference shape, 3% narrower, balanced surface, structure strength 0.52, fine detail 0.62",
  },

  // 2. SURGICAL MORPHOMETRY & LOBAR GEOMETRY (LIVER)
  {
    id: "liver-mm-sizing",
    category: "morphometry",
    organId: "liver",
    organLabel: "Liver",
    badge: "TRF Millimeter Solver",
    title: "Pre-Operative CT Millimeter Sizing (Exact Bounding Box)",
    clinicalSummary:
      "Uses the Trust-Region Reflective (TRF) non-linear least-squares solver to hit exact physical millimeter dimensions on the deformed 3D mesh with <0.01% error.",
    metrics: ["Female: 256×175×162 mm", "Male: 200×180×208 mm", "Bend +0.18", "Twist −0.14", "Wetness 0.78"],
    prompt:
      "Clear disease, width 256 mm, height 175 mm, depth 162 mm, bend 0.18, twist -0.14, taper 0.12, asymmetry 0.18, wetness 0.78, fine detail 0.64",
    malePrompt:
      "Clear disease, width 200 mm, height 180 mm, depth 208 mm, bend 0.16, twist 0.14, taper 0.15, asymmetry 0.16, wetness 0.74, fine detail 0.66",
    featuredQuick: true,
  },
  {
    id: "liver-right-lobe-hypertrophy",
    category: "morphometry",
    organId: "liver",
    organLabel: "Liver",
    badge: "Lobar Remodeling",
    title: "Right-Lobe Hypertrophy & Caudate-Inferior Torsion",
    clinicalSummary:
      "Simulates compensatory right-lobar volumetric expansion (+8% width, +6% depth, +5% height) paired with strong lateral shear asymmetry (+0.38) and axial twist.",
    metrics: ["Width +8%", "Depth +6%", "Height +5%", "Asymmetry +0.38", "Bend +0.28", "Twist −0.22"],
    prompt:
      "Healthy, reference shape, 8% wider, 6% deeper, 5% taller, bend 0.28, twist -0.22, asymmetry 0.38, moist surface, wetness 0.76, fine detail 0.68",
  },
  {
    id: "liver-left-segment-taper",
    category: "morphometry",
    organId: "liver",
    organLabel: "Liver",
    badge: "Segmental Contour",
    title: "Elongated Left-Lateral Segment Taper & Flattened Dome",
    clinicalSummary:
      "Slender, anteroposteriorly flattened hepatic profile (−6% width, −5% depth) with pronounced vertical taper (−0.34) and negative lateral shear (−0.30).",
    metrics: ["Width −6%", "Depth −5%", "Taper −0.34", "Bend +0.34", "Twist +0.22", "Asymmetry −0.30"],
    prompt:
      "Healthy, reference shape, 6% narrower, 5% flatter, taper -0.34, bend 0.34, twist 0.22, asymmetry -0.3, balanced surface, structure strength 0.58, fine detail 0.66",
  },
  {
    id: "liver-diaphragmatic-flexure",
    category: "morphometry",
    organId: "liver",
    organLabel: "Liver",
    badge: "3D Diffeomorphism",
    title: "High Diaphragmatic Dome Curvature & Subcostal Twist",
    clinicalSummary:
      "Demonstrates large-angle Jacobian-certified diffeomorphic bending (+0.45), axial torsion (−0.35), and taper (+0.28) without triangle inversions or foldovers.",
    metrics: ["Bend +0.45", "Twist −0.35", "Taper +0.28", "Asymmetry +0.42", "Width +6%", "Depth +5%"],
    prompt:
      "Healthy, reference shape, bend 0.45, twist -0.35, taper 0.28, asymmetry 0.42, 6% wider, 5% deeper, moist surface, wetness 0.8, fine detail 0.74",
  },
  {
    id: "liver-direct-7dof-controls",
    category: "morphometry",
    organId: "liver",
    organLabel: "Liver",
    badge: "7-DOF Coordinate Control",
    title: "Explicit 7-Axis Parametric Deformation Vector",
    clinicalSummary:
      "Directly sets all 7 normalized shape coordinates (scale_x, scale_y, scale_z, bend, twist, taper, asymmetry) alongside capsule optical parameters in one instruction.",
    metrics: ["scale_x 0.48", "scale_y 0.32", "scale_z 0.42", "Bend 0.22", "Twist −0.18", "Asymmetry 0.28"],
    prompt:
      "Clear disease, scale_x 0.48, scale_y 0.32, scale_z 0.42, bend 0.22, twist -0.18, taper 0.16, asymmetry 0.28, wetness 0.78, fine detail 0.68, structure strength 0.46",
  },

  // 3. GLISSON CAPSULE & SEROSAL OPTICS (LIVER)
  {
    id: "liver-laparoscopic-wet-serosa",
    category: "optics",
    organId: "liver",
    organLabel: "Liver",
    badge: "Surgical Optics · Clearcoat",
    title: "Laparoscopic Irrigated Glistening Glisson Capsule",
    clinicalSummary:
      "Maximizes dual-lobe specular clearcoat wetness (0.92) and fine micro-normal relief (0.82) with tight 11 mm vascular mottling while locking 3D geometry unchanged.",
    metrics: ["Wetness 0.92", "Pigment 0.84", "Mottle 11 mm", "Fine Detail 0.82", "Structure 0.66", "Preserve Shape"],
    prompt:
      "Wetness 0.92, pigment contrast 0.84, mottle scale 11 mm, fine detail 0.82, structure strength 0.66, tint -0.18, preserve shape",
    featuredQuick: true,
  },
  {
    id: "liver-congested-venous-parenchyma",
    category: "optics",
    organId: "liver",
    organLabel: "Liver",
    badge: "Hemodynamic Tint · PBR",
    title: "Congested Venous Parenchyma & Deep Lobular Micro-Grain",
    clinicalSummary:
      "Simulates passive hepatic venous congestion with intense pigment contrast (0.88), tight 9 mm lobular mottling, deep parenchymal grain (0.74), and warm heme shift.",
    metrics: ["Pigment 0.88", "Mottle 9 mm", "Structure 0.74", "Fine Detail 0.86", "Warm Tint +0.26", "Preserve Shape"],
    prompt:
      "Wetness 0.78, pigment contrast 0.88, mottle scale 9 mm, fine detail 0.86, structure strength 0.74, tint 0.26, preserve shape",
  },
  {
    id: "liver-fibrotic-matte-capsule",
    category: "optics",
    organId: "liver",
    organLabel: "Liver",
    badge: "Capsule Fibrosis · Matte",
    title: "Desiccated Fibrotic Matte Capsule (Low Specular Sheen)",
    clinicalSummary:
      "Reduces serosal wetness to 0.26 with broad 22 mm mottle scale, cooler desaturated tint (−0.24), and prominent fibrous stromal grain (0.68) while preserving shape.",
    metrics: ["Wetness 0.26", "Pigment 0.42", "Mottle 22 mm", "Structure 0.68", "Cool Tint −0.24", "Preserve Shape"],
    prompt:
      "Wetness 0.26, pigment contrast 0.42, mottle scale 22 mm, fine detail 0.58, structure strength 0.68, tint -0.24, preserve shape",
  },
  {
    id: "liver-qualitative-optical-boost",
    category: "optics",
    organId: "liver",
    organLabel: "Liver",
    badge: "Semantic Relative Grammar",
    title: "Natural-Language Relative Serosal & Lobular Enhancement",
    clinicalSummary:
      "Uses comparative clinical adjectives (wetter, more mottled, warmer, more fine detail, more tissue grain) with an explicit geometry-preservation guard.",
    metrics: ["+0.15 Wetness", "+0.15 Mottling", "+0.20 Warmth", "+0.15 Fine Detail", "+0.15 Grain", "Preserve Shape"],
    prompt:
      "Make the liver wetter, more mottled, warmer, with more fine detail and more tissue grain, while preserving shape",
  },

  // 4. MULTI-STAGE REMODELING & BASELINE RECOVERY (LIVER)
  {
    id: "liver-post-therapy-regression",
    category: "recovery",
    organId: "liver",
    organLabel: "Liver",
    badge: "Longitudinal Remodeling",
    title: "Post-Antiviral Fibrosis Regression & Nodular Smoothing",
    clinicalSummary:
      "Transitions a severely cirrhotic liver to a regressing, smoother phenotype (severity 0.32, irregularity 0.35, 3 residual zones) with restored soft serosal sheen.",
    metrics: ["Severity 0.32", "Irregularity 0.35", "Contrast 0.34", "3 Sites", "Width +2%", "Wetness 0.62"],
    prompt:
      "Alcohol-associated cirrhosis, severity 0.32, irregularity 0.35, spread 0.4, contrast 0.34, count 3, reference shape, 2% wider, soft surface, wetness 0.62, fine detail 0.54",
  },
  {
    id: "liver-healthy-donor-reset",
    category: "recovery",
    organId: "liver",
    organLabel: "Liver",
    badge: "Baseline Reference",
    title: "Healthy Donor Graft Baseline Restoration",
    clinicalSummary:
      "Clears all pathology displacement fields, resets all 7 deformation controls to the undeformed anatomical reference mesh, and restores balanced Glisson capsule optics.",
    metrics: ["Clear Disease", "Reference Shape", "Balanced Surface", "Wetness 0.50", "Mottle 16 mm", "Fine Detail 0.50"],
    prompt:
      "Healthy, reference shape, balanced surface, wetness 0.5, mottle scale 16, fine detail 0.5, structure strength 0.3, tint 0",
    featuredQuick: true,
  },

  // 5. MULTI-ORGAN SURGICAL ATLAS (OTHER 11 ORGANS)
  {
    id: "organ-gallbladder-cholecystitis",
    category: "multi-organ",
    organId: "gallbladder",
    organLabel: "Gallbladder",
    badge: "Gallbladder · Biliary Surgery",
    title: "Chronic Calculous Cholecystitis & Serosal Edema",
    clinicalSummary:
      "Distended, hyperemic gallbladder envelope (+7% width, +6% depth) with inflammatory wall irregularity and wet edematous serosal sheen.",
    metrics: ["Cholecystitis", "Severity 0.82", "4 Sites", "Width +7%", "Depth +6%", "Wetness 0.76"],
    prompt:
      "Chronic calculous cholecystitis, severity 0.82, irregularity 0.74, spread 0.78, contrast 0.8, count 4, reference shape, 7% wider, 6% deeper, rich surface, wetness 0.76, fine detail 0.68",
  },
  {
    id: "organ-pancreas-adenocarcinoma",
    category: "multi-organ",
    organId: "pancreas",
    organLabel: "Pancreas",
    badge: "Pancreas · Whipple / HPB",
    title: "Pancreatic Ductal Adenocarcinoma (PDAC) Mass",
    clinicalSummary:
      "Focal desmoplastic pancreatic mass with high boundary irregularity (0.82), accentuated lobular parenchymal grain (0.64), and anteroposterior curvature.",
    metrics: ["PDAC Mass", "Severity 0.85", "Irregularity 0.82", "Width +6%", "Bend +0.22", "Structure 0.64"],
    prompt:
      "Pancreatic ductal adenocarcinoma, severity 0.85, size 0.7, irregularity 0.82, contrast 0.84, count 2, reference shape, 6% wider, bend 0.22, rich surface, structure strength 0.64, fine detail 0.72",
  },
  {
    id: "organ-spleen-splenomegaly",
    category: "multi-organ",
    organId: "spleen",
    organLabel: "Spleen",
    badge: "Spleen · Portal Hypertension",
    title: "Congestive Splenomegaly (Portal Hypertension Triad)",
    clinicalSummary:
      "Diffusely enlarged splenic envelope (+8% width, +7% height/depth) with tense, dark purple-red congested capsule and high specular wetness.",
    metrics: ["Splenomegaly", "Severity 0.84", "Spread 0.88", "Width +8%", "Height +7%", "Wetness 0.80"],
    prompt:
      "Diffuse splenic enlargement, severity 0.84, spread 0.88, size 0.76, contrast 0.78, reference shape, 8% wider, 7% taller, 7% deeper, moist surface, wetness 0.8, fine detail 0.68",
  },
  {
    id: "organ-stomach-adenocarcinoma",
    category: "multi-organ",
    organId: "stomach",
    organLabel: "Stomach",
    badge: "Stomach · Upper GI Oncology",
    title: "Gastric Adenocarcinoma & Serosal T4 Bulge",
    clinicalSummary:
      "Focal exophytic gastric wall distortion with high serosal contrast (0.84), greater-curvature expansion (+6% width), and glistening peritoneal finish.",
    metrics: ["Gastric Cancer", "Severity 0.84", "Size 0.72", "Width +6%", "Bend +0.24", "Wetness 0.82"],
    prompt:
      "Gastric adenocarcinoma, severity 0.84, size 0.72, irregularity 0.8, contrast 0.84, count 2, reference shape, 6% wider, bend 0.24, moist surface, wetness 0.82, fine detail 0.7",
  },
  {
    id: "organ-kidney-polycystic",
    category: "multi-organ",
    organId: "kidney",
    organLabel: "Kidney",
    badge: "Kidney · Renal Surgery",
    title: "Autosomal Dominant Polycystic Kidney Phenotype",
    clinicalSummary:
      "Multifocal cortical cystic bosses across 7 zones with global renal enlargement (+7% width, +6% depth) and translucent-like wet capsule highlights.",
    metrics: ["Polycystic", "7 Sites", "Severity 0.86", "Spread 0.88", "Width +7%", "Wetness 0.82"],
    prompt:
      "Polycystic kidney disease, severity 0.86, size 0.74, spread 0.88, irregularity 0.84, contrast 0.82, count 7, reference shape, 7% wider, 6% deeper, moist surface, wetness 0.82, fine detail 0.72",
  },
  {
    id: "organ-small-bowel-crohn",
    category: "multi-organ",
    organId: "small-intestine",
    organLabel: "Small Intestine",
    badge: "Small Bowel · IBD Surgery",
    title: "Crohn's Jejunal Serositis & Skip-Lesion Remodeling",
    clinicalSummary:
      "Multifocal transmural inflammatory serosal changes across 5 skip segments with mesenteric-border curvature and hyperemic wet serosa.",
    metrics: ["Crohn's Jejunum", "5 Sites", "Severity 0.82", "Spread 0.80", "Width +5%", "Wetness 0.82"],
    prompt:
      "Crohn's disease of jejunum, severity 0.82, spread 0.8, irregularity 0.78, contrast 0.8, count 5, reference shape, 5% wider, bend 0.24, moist surface, wetness 0.82, fine detail 0.7",
  },
  {
    id: "organ-colon-adenocarcinoma",
    category: "multi-organ",
    organId: "large-intestine",
    organLabel: "Large Intestine",
    badge: "Colon · Colorectal Oncology",
    title: "Sigmoid Colon Adenocarcinoma & Serosal Puckering",
    clinicalSummary:
      "Irregular colonic mass profile with high serosal contrast (0.84), axial torsion (+0.20), and detailed haustral micro-relief.",
    metrics: ["Sigmoid Cancer", "Severity 0.84", "Size 0.72", "Width +6%", "Twist +0.20", "Fine Detail 0.72"],
    prompt:
      "Sigmoid adenocarcinoma, severity 0.84, size 0.72, irregularity 0.8, contrast 0.84, count 2, reference shape, 6% wider, twist 0.2, moist surface, wetness 0.8, fine detail 0.72",
  },
  {
    id: "organ-heart-infarction",
    category: "multi-organ",
    organId: "heart",
    organLabel: "Heart",
    badge: "Heart · Cardiothoracic",
    title: "Healed Myocardial Infarction & Ventricular Remodeling",
    clinicalSummary:
      "Regional epicardial scar contrast (0.84) with asymmetric ventricular remodeling (+6% width, +0.28 asymmetry) and directional myocardial fiber grain.",
    metrics: ["MI Scar", "Severity 0.82", "Contrast 0.84", "Width +6%", "Asymmetry +0.28", "Wetness 0.78"],
    prompt:
      "Healed myocardial infarction, severity 0.82, size 0.7, spread 0.68, irregularity 0.76, contrast 0.84, count 2, reference shape, 6% wider, asymmetry 0.28, rich surface, wetness 0.78, fine detail 0.72",
  },
  {
    id: "organ-lung-emphysema",
    category: "multi-organ",
    organId: "lung",
    organLabel: "Lung",
    badge: "Lung · Thoracic Surgery",
    title: "Centrilobular Emphysema & Hyperinflated Pleural Envelope",
    clinicalSummary:
      "Hyperinflated pulmonary volume (+7% width, +6% height) with 6 bullous-like pleural remodeling zones and emphasized secondary lobular septa.",
    metrics: ["Emphysema", "6 Sites", "Spread 0.86", "Width +7%", "Height +6%", "Structure 0.62"],
    prompt:
      "Centrilobular emphysema, severity 0.84, size 0.74, spread 0.86, irregularity 0.8, contrast 0.82, count 6, reference shape, 7% wider, 6% taller, soft surface, fine detail 0.7, structure strength 0.62",
  },
  {
    id: "organ-brain-glioblastoma",
    category: "multi-organ",
    organId: "brain",
    organLabel: "Brain",
    badge: "Brain · Neurosurgery",
    title: "Cortical Glioblastoma Mass & Hemispheric Asymmetry",
    clinicalSummary:
      "High-grade cortical mass distortion with irregular pial surface contrast (0.86), subtle hemispheric expansion (+3% width), and glistening arachnoid sheen.",
    metrics: ["Glioblastoma", "Severity 0.84", "Contrast 0.86", "Width +3%", "Asymmetry +0.24", "Wetness 0.82"],
    prompt:
      "Glioblastoma, severity 0.84, size 0.72, irregularity 0.82, contrast 0.86, count 2, reference shape, 3% wider, asymmetry 0.24, moist surface, wetness 0.82, fine detail 0.74",
  },
  {
    id: "organ-bladder-carcinoma",
    category: "multi-organ",
    organId: "urinary-bladder",
    organLabel: "Urinary Bladder",
    badge: "Bladder · Urologic Oncology",
    title: "Transmural Bladder Carcinoma & Dome Expansion",
    clinicalSummary:
      "Focal vesical wall mass distortion across 2 zones with distended detrusor envelope (+7% width, +6% depth) and wet serosal finish.",
    metrics: ["Bladder Cancer", "Severity 0.82", "Size 0.68", "Width +7%", "Depth +6%", "Wetness 0.82"],
    prompt:
      "Bladder carcinoma, severity 0.82, size 0.68, irregularity 0.78, contrast 0.82, count 2, reference shape, 7% wider, 6% deeper, moist surface, wetness 0.82, fine detail 0.68",
  },
];

const CATEGORY_META: readonly { id: PromptTipCategory; label: string; shortLabel: string; count: number }[] = [
  { id: "all", label: "All Liver Showcase (17)", shortLabel: "All Liver (17)", count: 17 },
  { id: "pathology", label: "Hepatobiliary Pathology (6)", shortLabel: "Pathology (6)", count: 6 },
  { id: "morphometry", label: "Surgical Morphometry & Geometry (5)", shortLabel: "Morphometry (5)", count: 5 },
  { id: "optics", label: "Glisson Capsule & Serosal Optics (4)", shortLabel: "Capsule Optics (4)", count: 4 },
  { id: "recovery", label: "Remodeling & Baseline Reset (2)", shortLabel: "Recovery & Reset (2)", count: 2 },
  { id: "multi-organ", label: "Multi-Organ Surgical Atlas (11)", shortLabel: "Other Organs (11)", count: 11 },
];

export interface AtlasPromptTipsProps {
  selectedOrganId?: string;
  selectedOrganLabel?: string;
  selectedTemplateId?: string;
  currentPrompt: string;
  appliedPrompt?: string;
  disabled?: boolean;
  onSelectPrompt: (prompt: string, organId: string, applyImmediately: boolean) => void;
}

export function resolveTipPrompt(tip: PromptTipItem, selectedTemplateId?: string): string {
  if (tip.malePrompt && selectedTemplateId === "hra-liver-male") {
    return tip.malePrompt;
  }
  return tip.prompt;
}

export function AtlasPromptTips({
  selectedOrganId = "liver",
  selectedOrganLabel = "Liver",
  selectedTemplateId,
  currentPrompt,
  appliedPrompt,
  disabled = false,
  onSelectPrompt,
}: AtlasPromptTipsProps) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<PromptTipCategory>("all");
  const [keepOpenOnApply, setKeepOpenOnApply] = useState(false);

  const quickTips = useMemo(() => {
    const organMatch = SURGICAL_PROMPT_TIPS.find(
      (item) => item.category === "multi-organ" && item.organId === selectedOrganId,
    );
    const liverFeatured = SURGICAL_PROMPT_TIPS.filter((item) => item.featuredQuick);
    if (organMatch && selectedOrganId !== "liver") {
      return [organMatch, ...liverFeatured.slice(0, 5)];
    }
    return liverFeatured;
  }, [selectedOrganId]);

  const visibleTips = useMemo(() => {
    if (category === "all") {
      return SURGICAL_PROMPT_TIPS.filter((item) => item.organId === "liver");
    }
    return SURGICAL_PROMPT_TIPS.filter((item) => item.category === category);
  }, [category]);

  const handleApply = (tip: PromptTipItem, immediate: boolean) => {
    const resolved = resolveTipPrompt(tip, selectedTemplateId);
    onSelectPrompt(resolved, tip.organId, immediate);
    if (immediate && !keepOpenOnApply) {
      setOpen(false);
    }
  };

  return (
    <div className="atlas-prompt-tips-root" data-testid="atlas-prompt-tips-root">
      {/* Compact quick-try bar in the prompt dock */}
      <div className="atlas-prompt-quick-bar" data-testid="atlas-prompt-quick-chips" aria-label="Surgical text-to-shape examples">
        <button
          type="button"
          className={`atlas-prompt-showcase-trigger ${open ? "is-open" : ""}`}
          data-testid="atlas-prompt-tips-trigger"
          aria-expanded={open}
          aria-controls="atlas-prompt-tips-panel"
          onClick={() => setOpen((prev) => !prev)}
        >
          <Stethoscope size={13} />
          <span>Surgical Prompt Examples</span>
          <span className="atlas-prompt-showcase-count">{SURGICAL_PROMPT_TIPS.length}</span>
          {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>

        <div className="atlas-prompt-quick-chips-scroll">
          {quickTips.map((tip) => {
            const resolved = resolveTipPrompt(tip, selectedTemplateId);
            const isActive = currentPrompt.trim() === resolved.trim();
            return (
              <button
                key={tip.id}
                type="button"
                className={`atlas-prompt-quick-chip ${isActive ? "is-active" : ""}`}
                data-testid={`atlas-quick-tip-${tip.id}`}
                disabled={disabled}
                title={`${tip.title} — Click to synthesize 3D shape, pathology & surface`}
                onClick={() => handleApply(tip, true)}
              >
                <Wand2 size={11} />
                <span>{tip.organId !== "liver" ? `${tip.organLabel}: ` : ""}{tip.title.replace(/ \(.*\)$/, "")}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Expandable / Presentable Surgical Showcase Panel */}
      {open && (
        <section
          id="atlas-prompt-tips-panel"
          className="atlas-prompt-tips-panel"
          data-testid="atlas-prompt-tips-panel"
          aria-label="Hepatobiliary and surgical text-to-3D prompt showcase"
        >
          <header className="atlas-prompt-tips-header">
            <div className="atlas-prompt-tips-title-block">
              <div className="atlas-prompt-tips-eyebrow">
                <Sparkles size={12} />
                <span>CLINICAL TEXT-TO-3D COMPILER · DETERMINISTIC JACOBIAN, TRF MILLIMETER &amp; PBR SOLVER</span>
              </div>
              <h2>Hepatobiliary &amp; Surgical Text-to-Shape Showcase</h2>
              <p>
                Select any clinical scenario below to synthesize <strong>3D organ morphometry</strong>,{" "}
                <strong>multi-site pathology relief</strong>, and <strong>Glisson capsule optical properties</strong> in real time.
                Currently viewing: <strong>{selectedOrganLabel}</strong>.
              </p>
            </div>
            <div className="atlas-prompt-tips-header-actions">
              <label className="atlas-prompt-tips-pin" title="Keep this showcase open while clicking through 3D examples during live presentations">
                <input
                  type="checkbox"
                  checked={keepOpenOnApply}
                  onChange={(e) => setKeepOpenOnApply(e.target.checked)}
                />
                <span>Presentation mode (stay open)</span>
              </label>
              <button
                type="button"
                className="atlas-prompt-tips-close"
                data-testid="atlas-prompt-tips-close"
                aria-label="Close surgical prompt showcase"
                onClick={() => setOpen(false)}
              >
                <X size={16} />
              </button>
            </div>
          </header>

          <div className="atlas-prompt-tips-tabs" role="tablist" aria-label="Surgical prompt categories">
            {CATEGORY_META.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={category === tab.id}
                data-testid={`atlas-tips-tab-${tab.id}`}
                className={category === tab.id ? "is-active" : ""}
                onClick={() => setCategory(tab.id)}
              >
                {tab.id === "pathology" && <Microscope size={12} />}
                {tab.id === "morphometry" && <Ruler size={12} />}
                {tab.id === "optics" && <Eye size={12} />}
                {tab.id === "recovery" && <RotateCcw size={12} />}
                {tab.id === "multi-organ" && <Layers size={12} />}
                {tab.id === "all" && <BookOpen size={12} />}
                <span>{tab.shortLabel}</span>
              </button>
            ))}
          </div>

          <div className="atlas-prompt-tips-grid" data-testid="atlas-prompt-tips-grid">
            {visibleTips.map((tip) => {
              const resolvedPrompt = resolveTipPrompt(tip, selectedTemplateId);
              const isSelected = currentPrompt.trim() === resolvedPrompt.trim();
              const isApplied = appliedPrompt?.trim() === resolvedPrompt.trim();
              return (
                <article
                  key={tip.id}
                  className={`atlas-prompt-tip-card ${isSelected ? "is-selected" : ""}`}
                  data-testid="atlas-prompt-tip-card"
                >
                  <div className="atlas-prompt-tip-card-top">
                    <span className={`atlas-prompt-tip-badge cat-${tip.category}`}>{tip.badge}</span>
                    <span className="atlas-prompt-tip-organ">{tip.organLabel}</span>
                  </div>
                  <h3>{tip.title}</h3>
                  <p className="atlas-prompt-tip-summary">{tip.clinicalSummary}</p>

                  <div className="atlas-prompt-tip-metrics" aria-label="Compiled parameters">
                    {tip.metrics.map((metric) => (
                      <span key={metric} className="atlas-prompt-tip-metric">
                        {metric}
                      </span>
                    ))}
                  </div>

                  <div className="atlas-prompt-tip-code">
                    <code>“{resolvedPrompt}”</code>
                  </div>

                  <div className="atlas-prompt-tip-actions">
                    <button
                      type="button"
                      className="atlas-prompt-tip-apply"
                      data-testid={`atlas-tip-apply-${tip.id}`}
                      disabled={disabled}
                      onClick={() => handleApply(tip, true)}
                    >
                      {isApplied ? <Check size={13} /> : <Play size={13} />}
                      <span>{isApplied ? "Applied to 3D Organ" : "Apply to 3D Organ"}</span>
                    </button>
                    <button
                      type="button"
                      className="atlas-prompt-tip-load"
                      data-testid={`atlas-tip-load-${tip.id}`}
                      disabled={disabled}
                      title="Load this prompt into the text box without compiling immediately so you can edit parameters"
                      onClick={() => handleApply(tip, false)}
                    >
                      <Copy size={12} />
                      <span>Load Text</span>
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
