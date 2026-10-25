# Guarded contact and temporal review

The review has two distinct questions: whether an instrument can reach a visible surface in the intact scene, and how a specific tissue responds after contact. An inaccessible duct is not a successful intact-scene contact test. Explicit surface isolation can test its mechanics but cannot establish access through its overlying anatomy.

## Reproduction

Serve the built `public-copy` at port 5177. The scripts use the installed local Chrome with Metal; this is separate from the software-rendered deployment smoke test.

```sh
CONTACT_OUTPUT=/tmp/viscera-cavity-contact/intact \
  node scripts/review_virtamed_contact.mjs

CONTACT_ISOLATED=1 CONTACT_ANGLES=0 CONTACT_MODES=Push \
CONTACT_PARTS=cystic-duct,hepatic-duct,cystic-artery,duodenum,small-intestine \
CONTACT_OUTPUT=/tmp/viscera-cavity-contact/isolated \
  node scripts/review_virtamed_contact.mjs

CONTACT_VIEW=anterior CONTACT_ANGLES=0 CONTACT_MODES=Push \
CONTACT_PARTS=abdominal-wall CONTACT_OUTPUT=/tmp/viscera-cavity-contact/anterior \
  node scripts/review_virtamed_contact.mjs

node scripts/analyze_virtamed_contact_video.mjs /tmp/viscera-cavity-contact/intact
```

The default matrix samples the video camera and two public mouse-orbit offsets of ±65 pixels; these are not 65-degree rotations. Camera poses are stored with every sample. It tests Push on all 12 parts and Grasp on gallbladder, foreground bowel, fatty apron and both membrane sheets. The initial probe radius is 3 mm, initial depth 0 mm, then two public 1 mm depth commands. `CONTACT_DEPTH_STEPS` changes the requested indentation for a separate stress run; a guard may reject a command.

The anterior-wall case enters the cavity, turns left 18 public camera steps and preserves that camera for instruments. The isolated mode uses public Hide controls and stores every hidden structure. Collision guards remain enabled in both protocols. Hidden geometry is excluded from contact tests by the existing application behavior.

## Recorded evidence

Each successful contact records rest, engagement, hold, small lateral motion, withdrawal and 2.2 seconds of release. Unmodified full-viewport stills and a native 25 fps browser recording show actual rendered states. The gallery links those stills. The structured receipt includes camera, organ, material, tool, force and solver diagnostics at each stage.

When `window.__visceraSceneSnapshot()` is available, a bounded animation-frame trace records force, tip clearance, rendered/solver anchor gap, displacement, energy, component response, complete instrument-to-camera clearance and physical time. Every frame carries its actual timestamp; rendering and screenshot capture can delay sampling. This review is not a performance benchmark. The ordinary published DOM snapshot fallback updates roughly every 500 ms and cannot establish subframe behavior.

Checks include finite solver state, the 3 N virtual-tool cap,≤0.02 mm rendered/contact-anchor discrepancy, no observed tip penetration beyond numerical tolerance, nonnegative camera clearance, recovery and zero direct displacement of disconnected components while breathing is disabled. Five displayed vertex samples per organ provide a diagnostic, not a proof that every triangle remains nonintersecting. The companion solver tests establish attachment continuity and energy behavior at physical substeps.

## Harness defects found and corrected

The first baseline read the published contact snapshot too soon and falsely labeled some contacts blocked. The corrected baseline waited for a new timestamp; the final harness uses the live getter.

A membrane oblique approach hit a neighboring liver surface, then the instrument guard automatically released it. A stale Release-button click timed out. The final harness uses the public Escape gesture, which is safe after an automatic release, and reports the contact result rather than suppressing the guard.

Element-only Playwright screenshots temporarily changed the recorded clip, creating gray borders and apparent frame jumps in the baseline video. Adjacent raw frames confirmed this was a capture artifact. Final temporal recordings use full-viewport screenshots. The original failed recording is retained as evidence.

A later complete matrix passed the original numerical checks but failed visual acceptance: consecutive video frames exposed the camera intersecting the proximal shaft or handle. This produced black views and an enormous white metal disk. The camera-only guard now includes the entire visible instrument and a 4 mm lens clearance sphere, with swept-motion checks and guarded alternate approaches. The final matrix requires camera-clearance diagnostics and repeats every angle; the failed video remains available.

Lateral commands return directly to the contact's screen location before a 12 × 5 pixel slide. Otherwise an automated pointer path from a distant sidebar button can accidentally request a large tool displacement. Separate application tests cover pointer reentry behavior.

## Interpretation

A passing matrix demonstrates bounded, internally consistent interaction in the tested states. It does not validate human tissue stiffness, surgical instrument forces, realistic organ-organ friction, insufflation pressure, cutting or fluid flow. An intact scene can legitimately obstruct an approach; isolated surface results are always identified separately.

## Recorded release review

The final primary run recorded 57 cases: 51 intact approaches, five explicit isolated fixtures and one anterior-wall contact. It established 41 contacts and 39 force-bearing deformations across all 12 parts. Sixteen intact cases had no visible candidate, and two active contacts remained touch-only because the finite probe guard blocked depth; another view loaded each of those tissues. All 16,224 animation samples passed the stated numerical and camera-clearance checks. Minimum instrument/lens clearance was 17.78 mm.

The three original 25 fps recordings total 491.6 seconds. Their 4,913 consecutive sampled frame pairs, 281 actual viewport PNGs, extracted original frames and detailed receipts are preserved in `/tmp/viscera-cavity-contact/`. `final-summary.json` and `final-review.md` distinguish the successful protocol from access limits and the earlier failed visual run. The compiled bundle hashes in `matrix-build-assets.json` identify the primary run; a separate final-build follow-up covers the subsequent narrow lighting-restoration and first-engagement guard-cache corrections.

Visual review found no recurrence of the former black view or oversized instrument disk in the targeted held images. The remaining broad silhouettes, repetitive wall mottling and sparse fine detail still read as synthetic; the review does not claim photographic or clinical equivalence.

The final compiled-build follow-up passed four additional loaded Grasp contacts on foreground bowel and cranial sheet at both orbit offsets. Its 1,601 animation samples remained finite and clear of the camera, with a minimum clearance of 32.12 mm. Including this separately identified follow-up gives 61 cases, 45 active contacts, 43 loaded deformations and 17,825 animation samples. `final-build-assets.json` identifies that bundle and `final-build-regression/` preserves its screenshots, video and traces.
