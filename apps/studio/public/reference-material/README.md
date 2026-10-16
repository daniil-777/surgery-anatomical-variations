# Bundled surgical reference photographs

These three images are frames from **one ex-vivo porcine colon specimen**, from DRENDS sequence `Seq01_Colon_Med`. They provide three views of the same source, not examples of three distinct organs or patients. The associated region selections are editable appearance-sampling suggestions, not clinical annotations.

**Attribution:** Gerardo Loza, Mattia Magro, Benjamin Calmé, Junlei Hu, Dominic Jones, Elena de Momi, Sharib Ali and Pietro Valdastri, *DRENDS: A Dataset for Depth in Robotic Endoscopy with Dynamic Scenarios* (2025).

- Dataset: [Zenodo record 17598453](https://zenodo.org/records/17598453).
- Project: [DRENDS](https://l0za007.github.io/DRENDS).
- License: [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/).
- Source archive: `DRENDS_ExVivo_Sequences.zip`; member `Seq01_Colon_Med/left.mp4`.
- Changes: frames were previously extracted as PNGs for the repository's DRENDS review. The bundled PNGs are byte-for-byte copies of those retained frames; no additional cropping, recoloring or compression was applied here.

| Public asset | Retained source frame | SHA-256 |
|---|---|---|
| `colon-view-1.png` | `frame-00000-left.png` | `f7e613384751b567d0e0fdb4644273097e3d00f12f10ff9b45af9304c0c4a9b3` |
| `colon-view-2.png` | `frame-00020-left.png` | `2b5ccb6bee1c3fac28caabd2f0a274a37fca564100020b40a6fab98114f86f8b` |
| `colon-view-3.png` | `frame-00040-left.png` | `4020c60461add3fb8fceda70671f9778bad0c78efb2b848c98535c229dd65465` |

Each source is 1920×1080. Repository provenance and extraction review are retained under `viscera/artifacts/ground-truth/drends-pilot/`. The archive's selected-member CRCs were verified during acquisition; its full 3.8 GB archive checksum was not verified.

On 2026-10-08, all three examples were analyzed through the live local material-reference API with both SAM 2.1 and the classical local method. The source images and generated overlays were visually inspected. The first two selections target the central pink tissue near the instrument; the third targets the pale tissue patch at lower right. Masks still require review, especially at folds and wet highlights. There is no independent segmentation truth, calibrated tissue-color measurement or automatic organ-identity claim.

View 2 uses a smaller interior region because its initial broader box caused the local method to include adjacent background. The final region produced useful tissue patches with both methods. Accepted color-sampling pixels at the API's 1024×576 analysis resolution were 55,893 / 35,239 / 32,436 for SAM 2.1 and 47,982 / 15,385 / 45,895 for the local method. These counts describe retained samples, not segmentation accuracy. The selections deliberately need not cover an entire organ.
