VISCERA control models, not a standalone free-form 3D foundation model.
Keep the exact final dataset bundle: its licensed atlas templates, source code and procedural decoders are required for inference.
shape/: seven geometry controls; material/: six procedural appearance controls; disease/: nine visual recipe controls.
clinical/: retrieval prior from the measured training cases only, not a population generator.
language/ exists only when optional pretrained Qwen LoRA training completed. Studio can explicitly enable it after downloading the pinned base model; every shape proposal must exactly pass the compiler guard. No automatic activation or disease/appearance text prediction.
No tissue stiffness, contact mechanics or calibrated surgical simulator was learned.
Smoke-profile artifacts are diagnostic only. Read metrics.json for the selected baseline/neural method and run_identity.json for the profile.
Split holdouts for synthetic controls share source atlas lineages. Clinical cases are split by patient.
