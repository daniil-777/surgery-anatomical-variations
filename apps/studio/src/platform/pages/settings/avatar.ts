// Profile photos are stored small: a centred square crop, 256 × 256, WebP where the browser can encode it (PNG
// otherwise). Both are on the bucket's MIME allow-list, and the original file never leaves the device.

export const AVATAR_SIZE = 256;
export const AVATAR_MAX_SOURCE_BYTES = 20_000_000;

export class AvatarError extends Error {
  override readonly name = "AvatarError";
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** The square, downscaled image to upload as the profile photo. Rejects with an AvatarError the UI can show. */
export async function prepareAvatar(file: File): Promise<Blob> {
  if (!/^image\/(png|jpeg|webp|avif|gif)$/.test(file.type)) throw new AvatarError("Choose a PNG, JPEG or WebP image.");
  if (file.size > AVATAR_MAX_SOURCE_BYTES) throw new AvatarError("Choose an image smaller than 20 MB.");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new AvatarError("This image couldn’t be opened. Choose a PNG, JPEG or WebP file.");
  }
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    if (side < 1) throw new AvatarError("This image is empty.");
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw new AvatarError("This browser couldn’t prepare the image.");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
    const webp = await toBlob(canvas, "image/webp", 0.9);
    if (webp && webp.type === "image/webp") return webp;
    const png = await toBlob(canvas, "image/png");
    if (!png) throw new AvatarError("This browser couldn’t prepare the image.");
    return png;
  } finally {
    bitmap.close();
  }
}
