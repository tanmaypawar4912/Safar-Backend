import cloudinary from "../config/cloudinary.js";
import User from "../models/User.js";

const MAX_FILE_SIZE = 8 * 1024 * 1024;

const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function respondError(res, status, message) {
  return res.status(status).json({
    success: false,
    message,
  });
}

function uploadBufferToCloudinary(buffer, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      options,
      (error, result) => {
        if (error) {
          reject(error);
          return;
        }

        if (!result) {
          reject(new Error("Cloudinary returned no upload result"));
          return;
        }

        resolve(result);
      }
    );

    stream.end(buffer);
  });
}

export const uploadDriverProfilePhoto = async (req, res) => {
  let uploadResult = null;
  let profileUpdated = false;

  try {
    const ownerId = req.user?.userId || req.user?._id;

    if (!ownerId || req.user?.role !== "driver") {
      return respondError(
        res,
        403,
        "Only authenticated drivers can update their profile photo"
      );
    }

    if (!req.file?.buffer) {
      return respondError(res, 400, "Please select an image to upload");
    }

    if (!ALLOWED_IMAGE_TYPES.has(req.file.mimetype)) {
      return respondError(
        res,
        422,
        "Only JPG, PNG and WEBP images are allowed"
      );
    }

    if (req.file.size > MAX_FILE_SIZE) {
      return respondError(
        res,
        413,
        "Image size must be 8 MB or less"
      );
    }

    const folder = `logigo/drivers/${ownerId}/profile-photos`;

    uploadResult = await uploadBufferToCloudinary(
      req.file.buffer,
      {
        folder,
        resource_type: "image",
        type: "upload",
        use_filename: false,
        unique_filename: true,
        overwrite: false,
        transformation: [
          {
            width: 600,
            height: 600,
            crop: "fill",
            gravity: "face",
            quality: "auto:good",
            fetch_format: "auto",
          },
        ],
        context: {
          application: "logigo",
          ownerId: String(ownerId),
          kind: "driver-profile-photo",
        },
      }
    );

    if (!uploadResult.secure_url || !uploadResult.public_id) {
      throw new Error("The uploaded profile image could not be verified");
    }

    const user = await User.findOneAndUpdate(
      {
        _id: ownerId,
        role: "driver",
        isActive: true,
      },
      {
        $set: {
          profileImage: uploadResult.secure_url,
        },
      },
      {
        new: true,
        runValidators: true,
      }
    );

    if (!user) {
      return respondError(
        res,
        404,
        "Driver account was not found or is inactive"
      );
    }

    profileUpdated = true;

    return res.status(200).json({
      success: true,
      message: "Profile photo updated successfully",
      profileImage: user.profileImage,
    });
  } catch (error) {
    console.error("Upload driver profile photo:", error.message);

    // Clean up an uploaded image if it could not be saved to the account.
    if (uploadResult?.public_id && !profileUpdated) {
      try {
        await cloudinary.uploader.destroy(
          uploadResult.public_id,
          {
            resource_type: "image",
            type: uploadResult.type || "upload",
            invalidate: true,
          }
        );
      } catch (cleanupError) {
        console.error(
          "Profile-photo cleanup failed:",
          cleanupError.message
        );
      }
    }

    return respondError(
      res,
      500,
      "Unable to update your profile photo. Please try again."
    );
  }
};