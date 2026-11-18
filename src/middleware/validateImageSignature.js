const IMAGE_SIGNATURES = {
  "image/jpeg": (buffer) =>
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff,
  "image/png": (buffer) =>
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    ),
  "image/webp": (buffer) =>
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP",
};

export function matchesImageSignature(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer)) return false;
  const check = IMAGE_SIGNATURES[mimeType];
  return typeof check === "function" && check(buffer);
}

/**
 * Verify the actual uploaded bytes after Multer has buffered the file.
 * Missing-file validation remains with the existing upload controllers.
 */
export function validateImageSignature(req, res, next) {
  if (!req.file?.buffer) return next();

  if (!matchesImageSignature(req.file.buffer, req.file.mimetype)) {
    return res.status(422).json({
      success: false,
      message:
        "The file content does not match its declared image type. Upload a valid JPG, PNG or WEBP image.",
    });
  }

  return next();
}
