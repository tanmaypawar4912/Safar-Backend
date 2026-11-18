/**
 * Atomically consumes a refresh token exactly once.
 *
 * MongoDB's single-document findOneAndUpdate is atomic: concurrent refresh
 * requests cannot both match revokedAt:null for the same token.
 */
export function consumeRefreshTokenOnce(
  RefreshTokenModel,
  { userId, tokenHash, now = new Date() }
) {
  return RefreshTokenModel.findOneAndUpdate(
    {
      userId,
      tokenHash,
      revokedAt: null,
      expiresAt: { $gt: now },
    },
    {
      $set: { revokedAt: now },
    },
    {
      new: true,
      runValidators: true,
    }
  );
}
