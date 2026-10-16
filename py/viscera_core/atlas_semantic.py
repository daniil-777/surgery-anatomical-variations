"""Versioned, bounded wording plans for authored anatomy appearance.

This module is deliberately separate from the frozen renderer. Language models
produce this same inert contract; all plans are checked before an atomic apply.
Health words describe an authored visual edit, never an inferred diagnosis.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import re
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "atlas-semantic-1"
POLICY_VERSION = "atlas-wording-policy-1.0.0"
INTERPRETATION = "authored_visual_design_not_clinical_inference"
MAX_TEXT_LENGTH = 4000
DISEASE_FIELDS = ("severity", "size", "spread", "irregularity", "contrast", "count")
CONTROLS = ("scale_x", "scale_y", "scale_z", "bend", "twist", "taper", "asymmetry")
DIMENSIONS = ("width", "height", "depth")
MATERIAL_BOUNDS = {"tint": (-1, 1), "pigment_contrast": (0, 1), "mottle_scale_mm": (2, 40), "wetness": (0, 1), "fine_detail": (0, 1), "structure_strength": (0, 1)}
PROFILES = {p["id"]: p for p in json.loads(Path(__file__).with_name("disease_profiles_v2.json").read_text())["profiles"]}
LEGACY_PROFILES = {p["id"]: p for p in json.loads(Path(__file__).with_name("disease_profiles.json").read_text())["profiles"]}
for _profiles in (PROFILES, LEGACY_PROFILES):
    for _entry in _profiles.values():
        _entry["organ"] = {"colon": "large-intestine", "bladder": "urinary-bladder"}.get(_entry["organ"], _entry["organ"])
ORGANS = ("small-intestine", "large-intestine", "urinary-bladder", "gallbladder", "pancreas", "stomach", "kidney", "spleen", "liver", "heart", "brain", "lung")
ORGAN_ALIASES = {**{o.replace("-", " "): o for o in ORGANS}, "small bowel": "small-intestine", "large bowel": "large-intestine", "colon": "large-intestine", "bladder": "urinary-bladder", "kidneys": "kidney", "lungs": "lung"}
PROFILE_ALIASES = {
    "cirrhosis": "liver-cirrhosis", "cirrhotic liver": "liver-cirrhosis", "hcc": "liver-hcc", "fatty liver": "liver-steatotic-enlargement", "fatty-liver": "liver-steatotic-enlargement", "steatotic liver": "liver-steatotic-enlargement",
    "liver metastases": "liver-metastases", "hepatic metastases": "liver-metastases", "hepatic cyst": "liver-capsular-cyst", "liver cyst": "liver-capsular-cyst", "liver capsular cyst": "liver-capsular-cyst",
    "renal cell carcinoma": "kidney-cancer", "kidney cancer": "kidney-cancer", "polycystic kidney": "kidney-polycystic", "kidney cyst": "kidney-cortical-cyst", "renal cortical cyst": "kidney-cortical-cyst", "kidney scarring": "kidney-cortical-scarring",
    "pancreatitis": "pancreas-pancreatitis", "pancreatic pseudocyst": "pancreas-pseudocyst", "splenic cyst": "spleen-cyst", "splenomegaly": "spleen-enlargement", "gastric distension": "stomach-distension", "emphysema": "lung-emphysema", "meningioma": "brain-meningioma", "glioblastoma": "brain-glioblastoma", "diverticulosis": "colon-diverticulosis",
}
for _id, _profile in PROFILES.items():
    PROFILE_ALIASES[_id] = _id
    PROFILE_ALIASES[_id.replace("-", " ")] = _id
    PROFILE_ALIASES[_profile["label"].lower()] = _id

_NUMBER = r"-?(?:\d+(?:\.\d+)?|\.\d+)"
_PRESERVE_FIELD = r"shape control values|shape controls|lesion size|region size|disease|lesions?|tumou?rs?|pathology|shape|geometry|dimensions?|width|height|depth|material|texture|surface|colou?r|appearance|severity|contrast|size|spread|irregularity|count|wetness|tint|bend|twist|taper|asymmetry"
_PRESERVE_PATTERNS = [
    rf"\b(?:do not|don't|never)\s+(?:change|alter|modify|touch|remove|clear|reduce|increase)\s+(?:the\s+)?({_PRESERVE_FIELD})(?:\s+(?:at all|in any way))?\b",
    rf"\bwithout\s+(?:changing|altering|modifying|removing|clearing)\s+(?:the\s+)?({_PRESERVE_FIELD})\b",
    rf"\b(?:keep|leave)\s+(?:the\s+)?({_PRESERVE_FIELD})\s+(?:unchanged|the same|as is|intact|alone)\b",
    rf"\bpreserv(?:e|ing)\s+(?:(?:the|its)\s+)?({_PRESERVE_FIELD})\b",
]
_UNSUPPORTED = re.compile(r"\b(?:resect\w*|resection|excise\w*|excision|cut\w*|remove|amputat\w*|anastom\w*|sutur\w*|transplant\w*|bleed\w*|haemorrhag\w*|hemorrhag\w*|perfus\w*|blood flow|portal pressure|blood pressure|vascular|arter(?:y|ies|ial)|vein\w*|vessel\w*|stiffness|elastic(?:ity|modulus)?|kpa|young's|clinical stage|stage\s*\d|grade\s*\d|diagnos\w*|prognos\w*|cur(?:e|ed|ing)|metastasiz\w*|resectable|operable|surgically safe|histolog\w*|chemotherap\w*|malignant transformation|benign transformation)\b")


def _normalise(text: str) -> str:
    return re.sub(r"\s+", " ", text.lower().replace("’", "'").replace("−", "-").replace("–", "-")).strip()


def operation(op: str, field: str | None = None, value: Any = None) -> dict[str, Any]:
    item: dict[str, Any] = {"op": op}
    if field is not None:
        item["field"] = field
    if value is not None:
        item["value"] = value
    return item


def make_plan(operations: list[dict[str, Any]] | None = None, *, status: str = "accepted", message: str = "Prepared bounded anatomy appearance edits.") -> dict[str, Any]:
    return {"schema_version": SCHEMA_VERSION, "status": status, "operations": operations or [], "message": message, "interpretation": INTERPRETATION}


def _refuse(message: str, status: str = "unsupported") -> dict[str, Any]:
    return make_plan(status=status, message=message)


def plan_fingerprint(plan: dict[str, Any]) -> str:
    """Semantic equality excludes explanatory prose and operation ordering."""
    payload = {"schema_version": plan.get("schema_version"), "status": plan.get("status"), "operations": sorted(plan.get("operations", []), key=lambda x: json.dumps(x, sort_keys=True))}
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def context_from_spec(spec: Any, organ: str | None = None) -> dict[str, Any]:
    raw = spec.model_dump(mode="json") if hasattr(spec, "model_dump") else copy.deepcopy(spec)
    if organ is None:
        template = raw.get("template_id", "")
        organ = next((o for o in ORGANS if o in template), None)
    return {"organ": organ, "disease": copy.deepcopy(raw.get("disease")), "controls": copy.deepcopy(raw.get("controls", {})), "material": copy.deepcopy(raw.get("material")), "appearance": raw.get("appearance", "tissue"), "renderer_version": raw.get("renderer_version", "legacy")}


def _preserve_name(value: str) -> str:
    return {"shape controls": "shape_controls", "shape control values": "shape_controls", "geometry": "shape", "dimension": "dimensions", "dimensions": "dimensions", "size": "dimensions", "lesion size": "size", "region size": "size", "lesion": "disease", "lesions": "disease", "tumor": "disease", "tumors": "disease", "tumour": "disease", "tumours": "disease", "pathology": "disease", "texture": "material", "surface": "material", "color": "material", "colour": "material"}.get(value, value)


def _extract_preserves(text: str) -> tuple[str, list[dict[str, Any]]]:
    preserves: list[dict[str, Any]] = []
    for pattern in _PRESERVE_PATTERNS:
        def found(match: re.Match[str]) -> str:
            item = operation("preserve", _preserve_name(match.group(1)))
            if item not in preserves:
                preserves.append(item)
            return " "
        text = re.sub(pattern, found, text)
    # Negative directional commands are preservation, never inverted edits.
    directions = {"wider": "width", "narrower": "width", "taller": "height", "shorter": "height", "deeper": "depth", "flatter": "depth", "healthier": "disease", "sicker": "disease", "wetter": "wetness", "drier": "wetness"}
    pattern = r"\b(?:do not|don't|never)\s+(?:make\s+)?(?:it\s+|the organ\s+)?(" + "|".join(directions) + r")\b"
    def directional(match: re.Match[str]) -> str:
        item = operation("preserve", directions[match.group(1)])
        if item not in preserves:
            preserves.append(item)
        return " "
    text = re.sub(pattern, directional, text)
    return text, preserves


def source_guard(text: str) -> dict[str, Any] | None:
    """Non-bypassable limits shared by rules, trained predictions and apply."""
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_LENGTH:
        return _refuse("Enter one anatomy edit of at most 4000 characters.")
    remaining, _ = _extract_preserves(_normalise(text))
    remaining = re.sub(r"\bremove\s+(?:the\s+)?(?:disease|pathology)(?:\s+appearance)?\b", "clear disease", remaining)
    if re.search(r"\b(?:duplicate|clon(?:e|ing)|split|join|merge|perforat\w*|hole|holes|hollow|interior|internal|segmentectom\w*|lobectom\w*|child[- ]pugh|meld|tnm|bclc|metavir|fibroscan|diagnostic|biopsy|histopatholog\w*|chemotherap\w*)\b", remaining):
        return _refuse("This request requires an unsupported anatomical or clinical operation. No edit was applied.")
    if _UNSUPPORTED.search(remaining):
        return _refuse("This request needs internal anatomy, topology, clinical inference or mechanics that this surface model does not implement. No edit was applied.")
    if re.search(r"\b(?:lesion|tumou?r|cyst|nodule|mass)(?:\s+(?:size|diameter|radius))?\s*(?:of|to|=|:)?\s*" + _NUMBER + r"\s*(?:mm|cm)\b|\b" + _NUMBER + r"\s*(?:mm|cm)\s*(?:lesion|tumou?r|cyst|nodule|mass)\b", remaining):
        return _refuse("A physical lesion diameter is not implemented; region size is a normalized authored support control. Specify a relative lesion-size edit or an organ dimension.")
    if re.search(r"\b(?:not|no|without|except|unless|avoid|never|don't|do not)\b", remaining):
        return _refuse("This negative or conditional instruction is ambiguous. State the edit and explicitly name fields to preserve.", "clarify")
    if re.search(r"\b(?:normal(?:ize|ise)?|healthy|healthier)\b", remaining) and re.search(r"\b(?:sicker|worse|more diseased|unhealthy)\b", remaining):
        return _refuse("Healthier and more diseased conflict; choose one direction.")
    return None


def request_guard(text: str, context: dict[str, Any]) -> dict[str, Any] | None:
    """Guards that must also precede an otherwise successful legacy compiler."""
    refused = source_guard(text)
    if refused:
        return refused
    source = _normalise(text)
    if re.search(r"\b(?:tumou?rs?|cysts?)\b", source):
        chosen = (context.get("disease") or {}).get("profile_id")
        selected = {pid for alias, pid in PROFILE_ALIASES.items() if re.search(r"(?<!\w)" + re.escape(alias) + r"(?!\w)", source)}
        if len(selected) == 1:
            chosen = next(iter(selected))
        profile = PROFILES.get(chosen, {})
        description = " ".join(str(profile.get(key, "")) for key in ("id", "label", "pattern", "mechanism")).lower()
        if re.search(r"\bcysts?\b", source) and "cyst" not in description:
            return _refuse("The selected appearance has no cystic region. Choose a cystic profile before editing cyst size.", "clarify")
        if re.search(r"\btumou?rs?\b", source) and not re.search(r"mass|carcinoma|cancer|metast|tumor|tumour|meningioma|glioblastoma|neuroendocrine", description):
            return _refuse("The selected appearance has no tumor region. Choose a matching mass profile before editing tumor size.", "clarify")
    if context.get("disease") and re.search(r"\b(?:width|height|depth|wide|tall|deep)\b", source) and re.search(r"\b(?:mm|cm)\b", source):
        if not re.search(r"\b(?:clear disease|clear pathology|healthy|baseline|normalise|normalize|disease-free)\b", source):
            return _refuse("Absolute dimensions of the final diseased surface cannot currently be solved. Clear the disease explicitly or request a relative dimension edit.", "clarify")
    return None


def _targets(item: dict[str, Any]) -> set[str]:
    op, field = item["op"], item.get("field")
    if op == "disease_clear":
        return {"disease", "shape", "dimensions", *DIMENSIONS, *DISEASE_FIELDS, "profile_id"}
    if op.startswith("disease_"):
        return {"disease", str(field), *({"shape", "dimensions", *DIMENSIONS} if field != "contrast" else set())}
    if op.startswith("shape_"):
        return {"shape", "shape_controls", "dimensions", str(field), CONTROLS[DIMENSIONS.index(field)]}
    if op == "control_set":
        return {"shape", "shape_controls", "dimensions", str(field), *DIMENSIONS}
    if op.startswith("material_"):
        return {"material", str(field)}
    return {str(field)}


def validate_plan(plan: dict[str, Any], context: dict[str, Any], text: str | None = None) -> dict[str, Any]:
    """Return a normalized inert plan, or a refusal with *zero* operations.

    `text` is mandatory at a learned-model boundary: hard limits, explicit
    preservation, numerical evidence and domain intent cannot be bypassed.
    """
    if not isinstance(plan, dict) or set(plan) - {"schema_version", "status", "operations", "message", "interpretation"}:
        return _refuse("Invalid wording plan fields.")
    if plan.get("schema_version") != SCHEMA_VERSION or plan.get("status") not in ("accepted", "clarify", "unsupported"):
        return _refuse("Unsupported wording plan schema or status.")
    if plan.get("interpretation") != INTERPRETATION:
        return _refuse("The wording plan must identify its authored visual scope.")
    if not isinstance(plan.get("message"), str) or len(plan["message"]) > 1000:
        return _refuse("Invalid wording explanation.")
    operations = plan.get("operations")
    if not isinstance(operations, list) or len(operations) > 24:
        return _refuse("A wording plan may contain at most 24 edits.")
    if plan["status"] != "accepted":
        return make_plan(status=plan["status"], message=plan["message"])
    if text is not None:
        refusal = request_guard(text, context)
        if refusal:
            return refusal
    normalised = []
    keys: set[str] = set()
    preserved: set[str] = set()
    active = bool(context.get("disease"))
    profile_selected = any(isinstance(x, dict) and x.get("op") == "disease_set" and x.get("field") == "profile_id" for x in operations)
    try:
        for item in operations:
            if not isinstance(item, dict) or set(item) - {"op", "field", "value"}:
                raise ValueError("Invalid operation fields.")
            op, field, value = item.get("op"), item.get("field"), item.get("value")
            if op == "disease_clear":
                if set(item) != {"op"}:
                    raise ValueError("Disease clear has no parameters.")
                key = "disease.clear"
            elif op == "preserve":
                if set(item) != {"op", "field"} or field not in {"shape", "shape_controls", "dimensions", "disease", "material", "appearance", *CONTROLS, *DIMENSIONS, *DISEASE_FIELDS, *MATERIAL_BOUNDS}:
                    raise ValueError("Unknown preservation constraint.")
                preserved.add(field)
                key = "preserve." + field
            elif op == "appearance_set":
                if field != "appearance" or value not in ("tissue", "source", "clay"):
                    raise ValueError("Unknown appearance mode.")
                key = "appearance"
            elif op == "disease_set" and field == "profile_id":
                if value not in PROFILES or not PROFILES[value]["supported"]:
                    raise ValueError("This profile has no supported external surface representation.")
                if context.get("organ") != PROFILES[value]["organ"]:
                    raise ValueError("Choose the matching organ before selecting this disease profile.")
                if context.get("renderer_version", "legacy") != "disease-v2" and (value not in LEGACY_PROFILES or not LEGACY_PROFILES[value]["supported"]):
                    return _refuse("Select the expanded disease model before using this external profile.", "clarify")
                key = "disease.profile_id"
            else:
                if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value):
                    raise ValueError("Edit values must be finite numbers.")
                if op in ("disease_relative", "disease_set"):
                    if field not in DISEASE_FIELDS:
                        raise ValueError("Unknown disease control.")
                    if not active and not profile_selected:
                        return _refuse("Select an external disease profile before changing its appearance.", "clarify")
                    if op == "disease_relative" and (field == "count" or not -0.95 <= value <= 0.95 or value == 0):
                        raise ValueError("Disease relative edits must be a nonzero fraction in [-0.95,0.95]; count is an integer setting.")
                    if op == "disease_set" and not (isinstance(value, int) and 1 <= value <= 8 if field == "count" else 0 <= value <= 1):
                        raise ValueError("Disease controls are normalized to [0,1], with integer site count 1..8.")
                    key = "disease." + field
                elif op in ("shape_relative", "shape_absolute"):
                    if field not in DIMENSIONS or (not -0.95 <= value <= 0.95 or value == 0 if op == "shape_relative" else not 0 < value <= 2000):
                        raise ValueError("Dimensions require positive millimetres or a nonzero relative fraction in [-0.95,0.95].")
                    key = "shape." + field
                elif op == "control_set":
                    if field not in CONTROLS or not -1 <= value <= 1:
                        raise ValueError("Shape controls must be within [-1,1].")
                    key = "shape." + (DIMENSIONS[CONTROLS.index(field)] if field in CONTROLS[:3] else field)
                elif op in ("material_relative", "material_set"):
                    if field not in MATERIAL_BOUNDS:
                        raise ValueError("Unknown material control.")
                    lo, hi = MATERIAL_BOUNDS[field]
                    if op == "material_relative" and not -0.5 <= value <= 0.5 or op == "material_set" and not lo <= value <= hi:
                        raise ValueError("Material edit is outside the authored control bounds.")
                    key = "material." + field
                else:
                    raise ValueError("Unknown wording operation.")
            if key in keys:
                raise ValueError("A field was edited twice or in conflicting directions; no edit was applied.")
            keys.add(key)
            normalised.append(copy.deepcopy(item))
        if "disease.clear" in keys and any(k.startswith("disease.") and k != "disease.clear" for k in keys):
            raise ValueError("Baseline and disease edits cannot be requested together.")
        for item in normalised:
            if item["op"] != "preserve" and preserved & _targets(item):
                raise ValueError("An edit conflicts with an explicit preservation constraint.")
        if any(x["op"].startswith("material_") for x in normalised) and any(x["op"] == "appearance_set" and x["value"] != "tissue" for x in normalised):
            raise ValueError("Authored material edits require tissue appearance.")
        if text is not None:
            _, required = _extract_preserves(_normalise(text))
            if any(item not in normalised for item in required):
                raise ValueError("The model omitted an explicit preservation instruction.")
            # A model cannot silently turn a clearly requested edit into a no-op.
            if not normalised and not (context.get("disease") is None and re.search(r"\b(?:healthier|less diseased|healthy|baseline|normalise|normalize|improved|improving|recovering|recovery|reduce|decrease|down|back|less severe overall)\b", _normalise(text))):
                raise ValueError("No supported edit or explicit preservation was produced.")
            evidence_error = _learned_domain_guard(normalised, text, context)
            if evidence_error:
                raise ValueError(evidence_error)
    except (ValueError, TypeError, KeyError) as exc:
        return _refuse(str(exc))
    return make_plan(normalised, message=plan["message"])


def _learned_domain_guard(operations: list[dict[str, Any]], text: str, context: dict[str, Any]) -> str | None:
    """Evidence guards constrain learned paraphrases without parser equality."""
    source = _normalise(text)
    evidence_source, _ = _extract_preserves(source)
    # Strip explicit profile spans before lexical coverage checks. The words
    # within a label may be clinical, but the label identifies a bounded proxy.
    lexical = evidence_source
    for alias in sorted(PROFILE_ALIASES, key=len, reverse=True):
        lexical = re.sub(r"(?<!\w)" + re.escape(alias) + r"(?!\w)", " ", lexical)
    organ_text = lexical
    mentioned_organs = set()
    for alias, organ in sorted(ORGAN_ALIASES.items(), key=lambda pair: -len(pair[0])):
        if re.search(r"\b" + re.escape(alias) + r"\b", organ_text):
            mentioned_organs.add(organ)
            organ_text = re.sub(r"\b" + re.escape(alias) + r"\b", " ", organ_text)
    if mentioned_organs and mentioned_organs != {context.get("organ")}:
        return "The requested organ differs from the current anatomy; select it first."
    # Unknown modifiers and verbs are allowed around grounded edit domains.
    # Every additional substantive clause still needs its own grounded domain;
    # a model cannot discard an unimplemented second request. This permits a
    # learned paraphrase such as "ease the pathology's visual footprint".
    domains = {
        "disease": r"health|sick|diseas|patholog|sever|morpholog|lesion|tumou?r|cyst|nodul|scar|swoll|swelling|normal|baseline|contrast|spread|irregular|size|sites|count|profile|region|improv|recover|worse|better",
        "material": r"wet|drier|dry|moist|sheen|gloss|matte|mottl|pigment|tint|warm|cool|redder|detail|grain|structure strength|mottle scale|material|texture",
        "shape": r"width|wide|narrow|height|tall|short|depth|deep|flat|broad|larg|small|big|bend|twist|taper|asymmetr|scale_[xyz]|dimension",
        "appearance": r"\b(?:tissue|source|clay)\b",
    }
    represented = {"disease" if x["op"].startswith("disease_") else "material" if x["op"].startswith("material_") else "shape" if x["op"].startswith("shape_") or x["op"] == "control_set" else "appearance" for x in operations if x["op"] != "preserve"}
    if not context.get("disease"):
        represented.add("disease")  # contextual baseline no-op is meaningful
    clause_text = evidence_source
    for alias in sorted(PROFILE_ALIASES, key=len, reverse=True):
        clause_text = re.sub(r"(?<!\w)" + re.escape(alias) + r"(?!\w)", " disease profile ", clause_text)
    polite = r"\b(?:please|for|this|that|the|a|an|current|anatomy|model|organ|specimen|it|me|i|you|my|would|could|can|want|like|to|in|now|look|make|of)\b|[\s.!?:]+"
    for clause in re.split(r";|,|\b(?:and|but|while|also|with)\b", clause_text):
        if not re.sub(polite, "", clause):
            continue
        grounded = {domain for domain, pattern in domains.items() if re.search(pattern, clause)}
        if not grounded or not grounded & represented:
            return "The model did not ground every requested clause in a supported edit; no partial edit was applied."
    health_down = re.search(r"\b(?:healthier|less diseased|less pathological|less healthy|less severe overall|less severe disease|less sick|more healthy|improved|improving|recovering|reduce both disease|reduce disease severity and contrast)\b", evidence_source)
    health_up = re.search(r"\b(?:sicker|more diseased|more pathological|unhealthier|worse|increase both disease)\b", evidence_source)
    if "less healthy" in evidence_source:
        health_down, health_up = None, re.search("less healthy", evidence_source)
    if health_down and health_up:
        return "The disease directions conflict."
    # Explicit relative percentages are source values, never free model choices.
    percents = [float(n) / 100 for n in re.findall(r"(" + _NUMBER + r")\s*%", evidence_source)]
    touched = {item.get("field") for item in operations if item["op"] != "preserve"}
    if (health_down or health_up) and context.get("disease") and not {"severity", "contrast"}.issubset(touched):
        # An already-baseline request has no disease operations by design.
        return "The model omitted part of the requested overall disease appearance edit."
    for item in operations:
        op, field, value = item["op"], item.get("field"), item.get("value")
        relative_percents = percents
        simple_health = re.search(r"\b(?:healthier|sicker|less diseased|more diseased|less pathological|more pathological|less healthy|more healthy|less sick|unhealthier|worse|improved|improving|recovering)\b", evidence_source)
        if op == "disease_relative" and field in ("severity", "contrast") and simple_health:
            prefix = re.search(r"(" + _NUMBER + r")\s*%\s*$", evidence_source[:simple_health.start()])
            suffix = re.match(r"\s*(?:by\s+)?(" + _NUMBER + r")\s*%", evidence_source[simple_health.end():])
            relative_percents = [float((prefix or suffix).group(1)) / 100] if prefix or suffix else []
        if op == "disease_set" and field == "profile_id":
            if not any(re.search(r"(?<!\w)" + re.escape(alias) + r"(?!\w)", evidence_source) for alias, pid in PROFILE_ALIASES.items() if pid == value):
                return "The model invented a disease profile that was not explicitly requested."
        if op == "disease_relative" and field in ("severity", "contrast") and (health_down or health_up):
            if (health_down and value >= 0) or (health_up and value <= 0):
                return "The model reversed the requested disease direction."
            if not relative_percents and abs(value) != (0.1 if re.search(r"\b(?:slightly|a little|somewhat)\b", evidence_source) else 0.2):
                return "Comparative health wording uses the declared conservative relative step."
        if op.endswith("_relative") and op != "material_relative" and relative_percents and not any(abs(abs(value) - abs(pct)) < 1e-7 for pct in relative_percents):
            return "The model changed a requested relative percentage."
        if op.endswith("_relative") and op != "material_relative" and relative_percents:
            anchors = {
                "width": r"width|wide|wider|broader|narrower", "height": r"height|tall|taller|shorter", "depth": r"depth|deep|deeper|flatter",
                "severity": r"healthier|sicker|diseased|health|severity|strength|intensity", "contrast": r"healthier|sicker|diseased|health|contrast",
                "size": r"lesion|tumor|tumour|cyst|size", "spread": r"spread", "irregularity": r"irregularity|irregular",
            }
            field_matches = list(re.finditer(r"\b(?:" + anchors.get(field, re.escape(str(field))) + r")\b", evidence_source))
            percent_matches = list(re.finditer(r"(" + _NUMBER + r")\s*%", evidence_source))
            if field_matches and percent_matches:
                nearest = min(percent_matches, key=lambda p: min(min(abs(p.end() - a.start()), abs(p.start() - a.end())) for a in field_matches))
                if abs(abs(value) - abs(float(nearest.group(1))) / 100) > 1e-7:
                    return "The model assigned a percentage to the wrong requested field."
        if op in ("shape_relative", "shape_absolute"):
            anchors = {"width": r"\b(?:width|wide|wider|broader|narrower)\b", "height": r"\b(?:height|tall|taller|shorter)\b", "depth": r"\b(?:depth|deep|deeper|flatter)\b"}
            if not re.search(anchors[field], evidence_source) and not (op == "shape_relative" and re.search(r"\b(?:larger|smaller|bigger)\b", evidence_source)):
                return "The model edited a dimension that was not requested."
            if op == "shape_relative":
                negative = {"width": "narrower", "height": "shorter", "depth": "flatter"}[field]
                positive = {"width": "wider|broader", "height": "taller", "depth": "deeper"}[field]
                if re.search(r"\b(?:" + negative + r"|smaller)\b", evidence_source) and value >= 0 or re.search(r"\b(?:" + positive + r"|larger|bigger)\b", evidence_source) and value <= 0:
                    return "The model reversed a requested shape direction."
        if op == "control_set" and not re.search(r"\b" + re.escape(field) + r"\b", evidence_source):
            return "The model changed a shape control that was not requested."
        if op == "disease_relative" and field not in ("severity", "contrast"):
            field_anchors = {"size": "lesion(?:s)?|tumou?r(?:s)?|cyst(?:s)?|size", "spread": "spread|widespread|locali[sz]ed", "irregularity": "irregular(?:ity)?|regular"}[field]
            negative = r"\b(?:less|reduce|decrease|smaller|down)\b[^,;]*?\b(?:" + field_anchors + r")\b|\b(?:" + field_anchors + r")\b[^,;]*?\b(?:smaller|down|less)\b"
            positive = r"\b(?:more|increase|larger|bigger|up)\b[^,;]*?\b(?:" + field_anchors + r")\b|\b(?:" + field_anchors + r")\b[^,;]*?\b(?:larger|bigger|up|more)\b"
            if field == "irregularity":
                negative = r"less irregular|more regular|(?:reduce|decrease)\s+(?:the\s+|disease\s+)?irregularity|irregularity\s+down"
                positive = r"more irregular|less regular|increase\s+(?:the\s+|disease\s+)?irregularity|irregularity\s+up"
            if field == "spread":
                negative = r"less (?:widespread|spread out)|more locali[sz]ed|(?:reduce|decrease)\s+(?:the\s+|disease\s+)?spread|spread\s+down"
                positive = r"more (?:widespread|spread out)|less locali[sz]ed|increase\s+(?:the\s+|disease\s+)?spread|spread\s+up"
            if re.search(negative, evidence_source) and value >= 0 or re.search(positive, evidence_source) and value <= 0:
                return "The model reversed the requested disease-control direction."
        if op == "material_relative":
            authored_step = .2 if field == "tint" else .15
            if abs(abs(value) - authored_step) > 1e-7:
                return "Qualitative surface edits use the declared conservative material step."
            direction_words = {
                "wetness": ("drier|less moist|less glossy|less sheen|more matte", "wetter|more moist|more glossy|glossier|more sheen"),
                "tint": ("cooler|less red", "warmer|redder"),
                "pigment_contrast": ("less mottl|reduce.*mottl", "more mottl|increase.*mottl"),
                "fine_detail": ("less fine detail", "more fine detail"),
                "structure_strength": ("less tissue grain", "more tissue grain"),
            }
            negative, positive = direction_words.get(field, (r"(?!)", r"(?!)"))
            if re.search(negative, evidence_source) and value >= 0 or re.search(positive, evidence_source) and value <= 0:
                return "The model reversed the requested material direction."
    # Every explicitly named actionable field must be represented. This is a
    # coverage check, not equality with a deterministic parser's prediction.
    coverage = {
        "width": r"\b(?:width|wide|wider|broader|narrower)\b",
        "height": r"\b(?:height|tall|taller|shorter)\b",
        "depth": r"\b(?:depth|deep|deeper|flatter)\b",
        "wetness": r"\b(?:wetness|wetter|drier|moist|glossy|glossier|sheen|matte)\b",
        "pigment_contrast": r"\b(?:pigment contrast|mottled|mottling)\b",
        "tint": r"\b(?:tint|warmer|cooler|redder)\b",
        "bend": r"\bbend\b", "twist": r"\btwist\b", "taper": r"\btaper\b", "asymmetry": r"\basymmetry\b",
        "severity": r"\b(?:severity|morphology strength|disease strength|disease intensity)\b",
        "size": r"\b(?:lesion size|region size)\b|\b(?:lesions?|tumou?rs?|cysts?)\b[^,;]*?\b(?:smaller|larger|bigger)\b|\b(?:smaller|larger|bigger)\s+(?:lesions?|tumou?rs?|cysts?)\b", "spread": r"\b(?:spread|widespread)\b",
        "irregularity": r"\b(?:irregularity|irregular)\b", "count": r"\b(?:count|sites)\b",
    }
    for field, pattern in coverage.items():
        if re.search(pattern, evidence_source) and field not in touched and not (field in DISEASE_FIELDS and not context.get("disease") and not any(x["op"].startswith("disease_") for x in operations)):
            return "The model omitted the requested " + field.replace("_", " ") + " edit."
    disease_words = r"health|sick|diseas|patholog|lesion|tumou?r|cyst|nodul|scar|sever|morpholog|swoll|swelling|inflamm|normal|baseline|cirrhos|contrast|spread|irregular|region|pattern|sites|count|size|worse|better|improv|recover|resolve|mild|subtle|aggress|pronounc|inten|prominen|fibros|bulg|retract|enlarg|distend|atroph"
    material_words = r"wet|dry|drier|moist|sheen|gloss|matte|mottl|pigment|tint|warm|cool|red|detail|grain|structure|textur|material|surface|colour|color|contrast"
    shape_words = r"width|wide|narrow|height|tall|short|depth|deep|flat|broad|larg|small|big|size|shape|scal|bend|bent|twist|taper|asymmetr|dimension|enlarg|contract|shrink|length"
    for item in operations:
        op = item["op"]
        field = item.get("field")
        if op.startswith("disease_") and op != "disease_clear" and not re.search(disease_words, source):
            # Explicit profile IDs and labels are valid evidence too.
            if not (op == "disease_set" and item.get("field") == "profile_id" and any(alias in source for alias, pid in PROFILE_ALIASES.items() if pid == item["value"])):
                return "The model proposed disease edits without disease wording."
        if op == "disease_clear" and not re.search(r"\b(?:healthy|normal|normalise|normalize|baseline|clear disease|clear pathology|remove (?:the )?disease|remove (?:the )?pathology|disease free|disease-free|reset disease|reset pathology|restore reference)\b", source):
            return "The model may clear disease only after an explicit baseline request."
        if op.startswith("material_") and not re.search(material_words, source):
            return "The model proposed material edits without surface wording."
        if (op.startswith("shape_") or op == "control_set") and not re.search(shape_words, source):
            return "The model proposed geometry edits without geometry wording."
        if op in ("shape_absolute", "control_set", "material_set") or (op == "disease_set" and item.get("field") != "profile_id"):
            numbers = [float(n) for n in re.findall(_NUMBER, source)]
            numbers.extend(float(i) for i, word in enumerate(("zero", "one", "two", "three", "four", "five", "six", "seven", "eight")) if re.search(r"\b" + word + r"\b", source))
            expected = float(item["value"])
            if not any(abs(n - expected) < 1e-7 or (op == "shape_absolute" and "cm" in source and abs(n * 10 - expected) < 1e-7) for n in numbers):
                return "The model invented a numeric setting not present in the request."
            aliases = {"pigment_contrast": "pigment contrast", "mottle_scale_mm": "mottle scale", "fine_detail": "fine detail", "structure_strength": "structure strength", "width": "width|wide", "height": "height|tall", "depth": "depth|deep", "count": "count|sites"}
            labels = list(re.finditer(r"\b(?:" + aliases.get(field, re.escape(field)) + r")\b", evidence_source))
            numeric_source = evidence_source
            for i, word in enumerate(("zero", "one", "two", "three", "four", "five", "six", "seven", "eight")):
                numeric_source = re.sub(r"\b" + word + r"\b", str(i).ljust(len(word)), numeric_source)
            numeric_matches = list(re.finditer(_NUMBER, numeric_source))
            if labels and numeric_matches:
                nearest = min(numeric_matches, key=lambda n: min(min(abs(n.end() - label.start()), abs(n.start() - label.end())) for label in labels))
                actual = float(nearest.group())
                if op == "shape_absolute" and re.match(r"\s*cm\b", numeric_source[nearest.end():]):
                    actual *= 10
                if abs(actual - expected) > 1e-7:
                    return "The model bound a numeric value to the wrong requested field."
    return None


def parse_semantic(text: str, context: dict[str, Any]) -> dict[str, Any]:
    """Deterministic useful default; optional trained adapters share this contract."""
    refusal = request_guard(text, context)
    if refusal:
        return refusal
    remaining, ops = _extract_preserves(_normalise(text).rstrip(".!"))
    notes: list[str] = []
    try:
        # Explicit profiles are longest-first to avoid consuming a short alias.
        selected: list[str] = []
        for alias, profile_id in sorted(PROFILE_ALIASES.items(), key=lambda pair: -len(pair[0])):
            pattern = r"(?<!\w)" + re.escape(alias) + r"(?!\w)"
            if re.search(pattern, remaining):
                selected.append(profile_id)
                remaining = re.sub(pattern, " ", remaining)
        if len(set(selected)) > 1:
            return _refuse("Choose one external disease profile per request.")
        if selected:
            ops.append(operation("disease_set", "profile_id", selected[0]))
        active = bool(context.get("disease") or selected)

        def health(match: re.Match[str]) -> str:
            phrase = match.group("health")
            direction = -1 if phrase in ("healthier", "less diseased", "less pathological", "less severe disease", "less sick", "better", "improved", "improving", "recovering", "more healthy") else 1
            fraction = float(match.group("percent")) / 100 if match.group("percent") else (0.1 if match.group("qualifier") in ("slightly", "a little", "somewhat") else 0.2)
            if not 0 < fraction <= 0.95:
                raise ValueError("Relative disease changes must be between 0% and 95%.")
            if not active:
                if direction > 0:
                    raise LookupError("Select a disease profile before asking for a more diseased appearance.")
                notes.append("Already at the authored baseline; healthier leaves the recipe unchanged.")
            else:
                ops.extend([operation("disease_relative", "severity", round(direction * fraction, 8)), operation("disease_relative", "contrast", round(direction * fraction, 8))])
                notes.append("Health wording changes authored morphology strength and color contrast, not measured health or clinical stage.")
            return " "
        remaining = re.sub(r"\b(?:(?P<percent>\d+(?:\.\d+)?)\s*%\s*|(?P<qualifier>slightly|a little|somewhat|much)\s+)?(?P<health>less severe disease|less pathological|less diseased|more diseased|more pathological|more unhealthy|more healthy|less healthy|less sick|healthier|sicker|unhealthier|worse|better|improved|improving|recovering)\b", health, remaining)
        baseline = r"\b(?:normalise|normalize|return to (?:the )?(?:normal|baseline)|restore (?:the )?(?:normal|baseline)|clear disease|clear pathology|remove (?:the )?disease|remove (?:the )?pathology|reset disease|reset pathology|disease[- ]free|healthy|baseline|normal)\b"
        if re.search(baseline, remaining):
            remaining = re.sub(baseline, " ", remaining)
            ops.append(operation("disease_clear"))
            notes.append("Baseline clears the selected authored disease recipe and preserves shape and material.")

        def lesion_percent(match: re.Match[str]) -> str:
            sign = -1 if match.group("direction") == "smaller" else 1
            ops.append(operation("disease_relative", "size", sign * float(match.group("percent")) / 100))
            return " "
        remaining = re.sub(r"\b(?:lesions?|tumou?rs?|cysts?|nodules?|regions?)\s+(?P<percent>\d+(?:\.\d+)?)\s*%\s*(?P<direction>smaller|larger|bigger)\b", lesion_percent, remaining)
        def disease_by(match: re.Match[str]) -> str:
            field = {"disease severity": "severity", "disease intensity": "severity", "morphology strength": "severity", "lesion size": "size", "region size": "size", "disease contrast": "contrast"}.get(match.group("field"), match.group("field"))
            ops.append(operation("disease_relative", field, (-1 if match.group("verb") in ("reduce", "decrease") else 1) * float(match.group("percent")) / 100))
            return " "
        remaining = re.sub(r"\b(?P<verb>reduce|decrease|increase)\s+(?:the\s+)?(?P<field>disease severity|disease intensity|morphology strength|lesion size|region size|disease contrast|severity|spread|irregularity|contrast)\s+by\s+(?P<percent>\d+(?:\.\d+)?)\s*%", disease_by, remaining)

        # Disease parameters use their explicit authored names and common aliases.
        disease_labels = {"severity": "severity", "morphology strength": "severity", "disease intensity": "severity", "lesion size": "size", "region size": "size", "size": "size", "spread": "spread", "irregularity": "irregularity", "disease contrast": "contrast", "contrast": "contrast", "site count": "count", "lesion count": "count", "count": "count"}
        for label, field in sorted(disease_labels.items(), key=lambda pair: -len(pair[0])):
            def diseased_number(match: re.Match[str], field: str = field) -> str:
                value = float(match.group(1))
                if field == "count" and not value.is_integer():
                    raise ValueError("Disease site count must be an integer.")
                ops.append(operation("disease_set", field, int(value) if field == "count" else value))
                return " "
            remaining = re.sub((r"(?<!pigment )" if label == "contrast" else "") + r"\b" + re.escape(label) + r"\s*(?:to|=|:)?\s*(" + _NUMBER + r")\b(?!\s*(?:%|mm|cm))", diseased_number, remaining)
        disease_directions = [
            (r"(?:smaller|less prominent|reduced)\s+(?:lesions?|tumou?rs?|cysts?|nodules?|regions?)|(?:lesions?|tumou?rs?|cysts?|nodules?|regions?)\s+(?:smaller|less prominent)", "size", -1),
            (r"(?:larger|bigger|more prominent)\s+(?:lesions?|tumou?rs?|cysts?|nodules?|regions?)|(?:lesions?|tumou?rs?|cysts?|nodules?|regions?)\s+(?:larger|bigger|more prominent)", "size", 1),
            (r"less (?:severe|intense|pronounced|obvious)|milder(?: disease| pathology)?|reduce (?:the )?(?:severity|disease intensity)", "severity", -1),
            (r"more (?:severe|intense|pronounced|obvious)|stronger disease|increase (?:the )?(?:severity|disease intensity)", "severity", 1),
            (r"less (?:widespread|spread out)|more localised|more localized|reduce (?:the )?spread", "spread", -1),
            (r"more (?:widespread|spread out)|less localised|less localized|increase (?:the )?spread", "spread", 1),
            (r"less irregular|more regular|reduce (?:the )?irregularity", "irregularity", -1),
            (r"more irregular|less regular|increase (?:the )?irregularity", "irregularity", 1),
            (r"less (?:disease |lesion )?contrast|subtler (?:disease |lesion )?(?:color|colour)|reduce (?:the )?(?:disease |lesion )?contrast", "contrast", -1),
            (r"more (?:disease |lesion )?contrast|stronger (?:disease |lesion )?(?:color|colour)|increase (?:the )?(?:disease |lesion )?contrast", "contrast", 1),
        ]
        for pattern, field, sign in disease_directions:
            def disease_relative(match: re.Match[str], field: str = field, sign: int = sign) -> str:
                fraction = float(match.group("pct")) / 100 if match.group("pct") else 0.2
                ops.append(operation("disease_relative", field, round(sign * fraction, 8)))
                return " "
            remaining = re.sub(r"\b(?:(?P<pct>\d+(?:\.\d+)?)\s*%\s*)?(?:" + pattern + r")\b", disease_relative, remaining)
        morphology = [("nodular", ("cirrhosis", "polycystic", "multicystic")), ("swollen", ("swelling", "enlargement", "distension", "dilation", "pancreatitis")), ("scarred", ("scarring", "retraction", "infarct", "cirrhosis", "atrophy"))]
        for word, required in morphology:
            pattern = r"\b(less|more)\s+" + word + r"\b"
            if re.search(pattern, remaining):
                pid = selected[0] if selected else (context.get("disease") or {}).get("profile_id", "")
                if not any(token in pid for token in required):
                    raise LookupError(f"Select a compatible external {word} profile before changing that appearance.")
                def strength(match: re.Match[str]) -> str:
                    ops.append(operation("disease_relative", "severity", -0.2 if match.group(1) == "less" else 0.2))
                    return " "
                remaining = re.sub(pattern, strength, remaining)

        # Measured organ dimensions are solved only at atomic apply time.
        def absolute(match: re.Match[str]) -> str:
            field = {"wide": "width", "tall": "height", "deep": "depth"}.get(match.group("axis"), match.group("axis"))
            ops.append(operation("shape_absolute", field, round(float(match.group("number")) * (10 if match.group("unit") == "cm" else 1), 8)))
            return " "
        remaining = re.sub(r"\b(?P<axis>width|height|depth)\s*(?:of|to|=|:)?\s*(?P<number>" + _NUMBER + r")\s*(?P<unit>mm|cm)\b", absolute, remaining)
        remaining = re.sub(r"\b(?P<number>" + _NUMBER + r")\s*(?P<unit>mm|cm)\s*(?P<axis>wide|tall|deep)\b", absolute, remaining)
        directions = {"wider": ("width", 1), "broader": ("width", 1), "narrower": ("width", -1), "taller": ("height", 1), "shorter": ("height", -1), "deeper": ("depth", 1), "flatter": ("depth", -1), "larger": ("all", 1), "bigger": ("all", 1), "smaller": ("all", -1)}
        def shape_relative(match: re.Match[str]) -> str:
            field, sign = directions[match.group("direction")]
            fraction = float(match.group("pct")) / 100 if match.group("pct") else (0.03 if match.group("qualifier") in ("slightly", "a little") else 0.05)
            for target in DIMENSIONS if field == "all" else [field]:
                ops.append(operation("shape_relative", target, round(sign * fraction, 8)))
            return " "
        remaining = re.sub(r"\b(?:(?P<pct>\d+(?:\.\d+)?)\s*%\s*|(?P<qualifier>slightly|a little)\s+)?(?P<direction>" + "|".join(directions) + r")\b", shape_relative, remaining)
        for field in CONTROLS:
            def control(match: re.Match[str], field: str = field) -> str:
                ops.append(operation("control_set", field, float(match.group(1))))
                return " "
            remaining = re.sub(r"\b" + field + r"\s*(?:to|=|:)?\s*(" + _NUMBER + r")\b", control, remaining)

        material_labels = {"tint": "tint", "pigment contrast": "pigment_contrast", "mottle scale": "mottle_scale_mm", "wetness": "wetness", "fine detail": "fine_detail", "structure strength": "structure_strength"}
        for label, field in material_labels.items():
            def material_number(match: re.Match[str], field: str = field) -> str:
                ops.append(operation("material_set", field, float(match.group(1))))
                return " "
            remaining = re.sub(r"\b" + label + r"\s*(?:to|=|:)?\s*(" + _NUMBER + r")\b" + (r"(?:\s*mm)?" if field == "mottle_scale_mm" else ""), material_number, remaining)
        materials = [("wetter|more moist|more glossy|glossier|more sheen", "wetness", 0.15), ("drier|less moist|less glossy|more matte|less sheen", "wetness", -0.15), ("warmer|redder", "tint", 0.2), ("cooler|less red", "tint", -0.2), ("more mottled|more mottling", "pigment_contrast", 0.15), ("less mottled|less mottling", "pigment_contrast", -0.15), ("more fine detail", "fine_detail", 0.15), ("less fine detail", "fine_detail", -0.15), ("more tissue grain", "structure_strength", 0.15), ("less tissue grain", "structure_strength", -0.15)]
        for pattern, field, delta in materials:
            def material_relative(match: re.Match[str], field: str = field, delta: float = delta) -> str:
                ops.append(operation("material_relative", field, delta))
                return " "
            remaining = re.sub(r"\b(?:" + pattern + r")\b", material_relative, remaining)
        for appearance in ("tissue", "clay", "source"):
            pattern = r"\b" + appearance + r"(?:\s+appearance)?\b"
            if re.search(pattern, remaining):
                ops.append(operation("appearance_set", "appearance", appearance))
                remaining = re.sub(pattern, " ", remaining)
        mentioned = set()
        for alias, organ in sorted(ORGAN_ALIASES.items(), key=lambda pair: -len(pair[0])):
            if re.search(r"\b" + re.escape(alias) + r"\b", remaining):
                mentioned.add(organ)
                remaining = re.sub(r"\b" + re.escape(alias) + r"\b", " ", remaining)
        if mentioned and mentioned != {context.get("organ")}:
            return _refuse("Select the requested organ first; this edit applies to the current anatomy.", "clarify")
        remaining = re.sub(r"\b(?:make|the|a|an|please|generate|create|show|use|select|organ|reference|shape|and|with|set|to|be|it|look|looking|appear|appearance|this|current|my|model|specimen|slightly|somewhat|now|then|but|while|also|for me)\b", " ", remaining)
        remaining = re.sub(r"[\s,;:.!?]+", " ", remaining).strip()
        if remaining:
            return _refuse("The request contains wording that needs clarification: " + remaining + ". No partial edit was applied.", "clarify")
        if not ops and not notes:
            return _refuse("Name a shape, material or disease-appearance edit.", "clarify")
        plan = make_plan(ops, message=" ".join(notes) or "Prepared bounded anatomy appearance edits; unspecified recipe fields are preserved.")
        return validate_plan(plan, context, text=text)
    except LookupError as exc:
        return _refuse(str(exc), "clarify")
    except ValueError as exc:
        return _refuse(str(exc))


def apply_plan(root: str | Path, spec: Any, plan: dict[str, Any], *, text: str | None = None) -> dict[str, Any]:
    """Apply all validated operations to a deep copy; any failure applies none."""
    from .atlas_material_text import compile_text as compile_surface
    from .atlas_materials import MaterialRecipe, make_recipe
    from .atlas_scene import get_template
    from .atlas_surface_scene import SurfaceAtlasSpec

    original = spec.model_dump(mode="json")
    organ = get_template(root, spec.template_id).metadata["organ"]
    context = context_from_spec(spec, organ)
    plan = validate_plan(plan, context, text=text)
    if plan["status"] != "accepted":
        return {**plan, "policy_version": POLICY_VERSION}
    target = copy.deepcopy(original)
    geometry: list[str] = []
    disease = copy.deepcopy(target.get("disease"))
    material = copy.deepcopy(target.get("material"))
    ops = plan["operations"]
    try:
        profile = next((x["value"] for x in ops if x["op"] == "disease_set" and x["field"] == "profile_id"), None)
        if profile:
            if target.get("renderer_version") == "disease-v2":
                from .atlas_disease_v2 import DiseaseSpecV2 as DiseaseRecipe
            else:
                from .atlas_disease import DiseaseSpec as DiseaseRecipe
            disease = disease if disease and disease["profile_id"] == profile else DiseaseRecipe(profile_id=profile, seed=target.get("seed", 42)).model_dump(mode="json")
        for item in ops:
            op, field, value = item["op"], item.get("field"), item.get("value")
            if op == "disease_clear":
                disease = None
            elif op == "disease_relative":
                disease[field] = round(min(1, max(0, disease[field] * (1 + value))), 8)
            elif op == "disease_set" and field != "profile_id":
                disease[field] = value
            elif op == "shape_relative":
                direction = {"width": ("wider", "narrower"), "height": ("taller", "shorter"), "depth": ("deeper", "flatter")}[field][value < 0]
                geometry.append(f"{abs(value) * 100:g}% {direction}")
            elif op == "shape_absolute":
                geometry.append(f"{field} {value:g} mm")
            elif op == "control_set":
                geometry.append(f"{field} {value:g}")
            elif op in ("material_relative", "material_set"):
                material = material or make_recipe(organ).model_dump(mode="json")
                lo, hi = MATERIAL_BOUNDS[field]
                material[field] = round(min(hi, max(lo, material[field] + value)), 8) if op == "material_relative" else value
                target["appearance"] = "tissue"
            elif op == "appearance_set":
                target["appearance"] = value
                if value != "tissue":
                    material = None
        if geometry:
            surface = SurfaceAtlasSpec.model_validate({key: value for key, value in target.items() if key not in ("disease", "renderer_version")})
            result = compile_surface(root, ", ".join(geometry), surface)
            if result["status"] != "accepted":
                return {**_refuse(result["message"]), "policy_version": POLICY_VERSION}
            target.update(result["spec"])
        if material is not None:
            material = MaterialRecipe.model_validate(material).model_dump(mode="json")
        target["material"] = material
        target["disease"] = disease
        target["template_sha256"] = None
        target["realized_id"] = None
        if target.get("renderer_version") == "disease-v2":
            from .atlas_disease_scene_v2 import DiseaseAtlasSpecV2
            parsed = DiseaseAtlasSpecV2.model_validate(target)
        else:
            from .atlas_disease_scene import DiseaseAtlasSpec
            parsed = DiseaseAtlasSpec.model_validate(target)
        if spec.model_dump(mode="json") != original:
            raise RuntimeError("Atomic wording application mutated the input")
        summary = _application_message(ops, context)
        plan["message"] = summary
        return {"status": "accepted", "spec": parsed.model_dump(mode="json"), "message": summary, "policy_version": POLICY_VERSION, "semantic_plan": plan, "plan_sha256": plan_fingerprint(plan), "interpretation": INTERPRETATION}
    except (ValueError, KeyError, TypeError) as exc:
        return {**_refuse(str(exc)), "policy_version": POLICY_VERSION}


def compile_text(root: str | Path, text: str, spec: Any) -> dict[str, Any]:
    from .atlas_scene import get_template
    context = context_from_spec(spec, get_template(root, spec.template_id).metadata["organ"])
    return apply_plan(root, spec, parse_semantic(text, context), text=text)


def _application_message(ops: list[dict[str, Any]], context: dict[str, Any]) -> str:
    """Explain applied operations from trusted code, never free model prose."""
    active_ops = [item for item in ops if item["op"] != "preserve"]
    if not active_ops:
        return "No disease modifier is active; the anatomy is unchanged." if not context.get("disease") else "The requested fields were preserved; no edit was applied."
    if len(active_ops) == 2 and {x.get("field") for x in active_ops} == {"severity", "contrast"} and all(x["op"] == "disease_relative" for x in active_ops) and active_ops[0]["value"] == active_ops[1]["value"]:
        value = active_ops[0]["value"]
        return f"{'Reduced' if value < 0 else 'Increased'} the selected disease strength and color contrast by {abs(value) * 100:g}%. Other recipe controls are unchanged."
    parts = []
    for item in active_ops:
        op, field, value = item["op"], item.get("field"), item.get("value")
        label = {"severity": "disease strength", "size": "disease region size", "contrast": "disease color contrast", "wetness": "surface sheen", "pigment_contrast": "surface mottling"}.get(field, (field or "").replace("_", " "))
        if op == "disease_clear":
            parts.append("Cleared the disease modifier")
        elif op in ("disease_relative", "shape_relative"):
            parts.append(f"{'Reduced' if value < 0 else 'Increased'} {label} by {abs(value) * 100:g}%")
        elif op == "material_relative":
            parts.append(f"{'Reduced' if value < 0 else 'Increased'} {label}")
        elif op == "shape_absolute":
            parts.append(f"Set {label} to {value:g} mm")
        else:
            parts.append(f"Set {label} to {value}")
    return "; ".join(parts) + "."
