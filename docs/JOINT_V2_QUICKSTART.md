# Expanded organ variations: Run All → Studio

The new release uses a separate spline-flow model. Your existing Joint VAE and its
original reference meshes remain stored and can be selected again.

## Train

1. Open the private [expanded training folder](https://drive.google.com/drive/folders/1v6eyPZZ-kmL6wkOuJaio-mBYXpCQr5oa).
2. Open `VISCERA_expanded_disease_run_all.ipynb` in Google Colab. Keep its three
   training archives in the same named Drive folder. Files labelled
   `SUPERSEDED-RC1-DO-NOT-TRAIN` are excluded from the final notebook.
3. Choose **Runtime → Change runtime type → A100 GPU**, if your account offers it.
   Other CUDA GPUs are supported. The notebook reports the actual allocated GPU.
4. Choose **Run all** and complete Google's Drive authorization if prompted.
5. Wait for training, held-out comparisons and full-mesh checks. The last cell
   downloads `viscera-joint-v2-weights.zip`. A copy, logs, checkpoints and reports
   remain under the training folder's `runs` directory.

The notebook verifies archive checksums and resumes only a compatible checkpoint.
If a quality check fails, it stops without claiming successful weights. There is
no instruction to disable the check or rename an old archive to satisfy it.

## Generate and edit

1. In Studio, open **Trained models → Colab weight archive**, select the new ZIP,
   and choose **Validate & activate**.
2. Select an organ, open **Disease**, then choose a supported profile.
3. Choose **Disease design range**: automatic, mild, moderate or severe.
4. Use **Joint flow variation**. Change the joint seed to produce another
   combination of shape, material, disease controls and spatial pattern.
5. Continue using the shape, surface and disease controls. **Export GLB** exports
   the displayed, bound specimen with its textures.

Try liver capsular cyst, kidney cortical scarring, gallbladder distension or
pancreatic atrophy. Disease commands also accept the exact supported profile ID,
for example `liver-capsular-cyst severity 0.8`; this is a deterministic command,
separate from the optional trained shape-text adapter.

If the source mesh limits deformation, Studio shows the retained displacement
fraction. The requested severity range is an authored design control, not a
clinical stage. Some source meshes permit only subtle safe external changes.

## Return to a previous model

Open **Trained models → Preserved joint models**, choose a prior VAE or flow and
select **Use selected version**. Generate another variation to use that version.
The displayed specimen remains unchanged until another generation. Switching
versions does not delete any retained model archive.

## What the release learns

The exported flow learns a bounded distribution over shape, material and disease
recipe controls. The renderer converts those controls into organ-specific meshes
and spatial appearance. The default control density is pooled by healthy/disease;
it does not establish patient-population differences among diseases. The separate
surface-field network is diagnostic by default and is not the deployed renderer.

The photographic references are unpaired and uncalibrated. The new clinical CT
cases are review evidence; they are not paired mesh/photograph training targets.
The release does not train tissue physics, internal anatomy or a new language
model. Numerical mesh checks and variation diversity are engineering checks,
not a clinical realism certification. See `JOINT_V2_EVIDENCE.md`,
`JOINT_V2_DELIVERY.md` and the dataset cards for the exact source use and limits.
