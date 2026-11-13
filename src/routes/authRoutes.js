import express from "express";
import rateLimit from "express-rate-limit";

import {
  register,
  login,
  refreshAccessToken,
  logout,
  getCurrentUser,
  updateProfile,
  requestPasswordReset,
  resetPassword,
} from "../controllers/authController.js";

import {
  changeEmail,
  changePassword,
} from "../controllers/accountSecurityController.js";

import { protect } from "../middleware/authMiddleware.js";
import { validate } from "../middleware/validateMiddleware.js";

import {
  registerSchema,
  loginSchema,
  updateProfileSchema,
} from "../validators/authValidator.js";

import {
  requestPasswordResetSchema,
  resetPasswordSchema,
} from "../validators/passwordResetValidator.js";

const router = express.Router();

// Slow down credential-stuffing and scripted account-creation attempts.
// Keep this separate from recovery limits so normal authenticated API polling
// is not affected by authentication-specific controls.
const credentialAttemptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    code: "AUTH_RATE_LIMITED",
    message: "Too many sign-in or registration attempts. Please wait 15 minutes and try again.",
  },
  handler: (req, res, _next, options) => {
    res.status(options.statusCode).json(options.message);
  },
});

const passwordRecoveryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many password recovery attempts. Please try again later.",
  },
});

router.post("/register", credentialAttemptLimiter, validate(registerSchema), register);
router.post("/login", credentialAttemptLimiter, validate(loginSchema), login);

router.post(
  "/forgot-password",
  passwordRecoveryLimiter,
  validate(requestPasswordResetSchema),
  requestPasswordReset
);

router.post(
  "/reset-password",
  passwordRecoveryLimiter,
  validate(resetPasswordSchema),
  resetPassword
);

router.post("/refresh", refreshAccessToken);
router.post("/logout", logout);

router.patch(
  "/profile",
  protect,
  validate(updateProfileSchema),
  updateProfile
);

router.patch("/change-email", protect, changeEmail);
router.patch("/change-password", protect, changePassword);

router.get("/me", protect, getCurrentUser);

export default router;