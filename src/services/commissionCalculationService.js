const BASIS_POINTS_DENOMINATOR = 10_000;
const MAX_COMMISSION_RATE_BPS = 5_000;

/**
 * Calculate the platform commission and driver earning using integer paise.
 * The commission is rounded to the nearest paise (half paise rounds up).
 *
 * @param {{ amountRupees: number|string, commissionRateBps: number }} input
 * @returns {{ commissionBasePaise: number, commissionRateBps: number, platformCommissionPaise: number, driverEarningPaise: number }}
 */
export function calculateCommissionAmounts({ amountRupees, commissionRateBps }) {
  const amount = Number(amountRupees);
  const rateBps = Number(commissionRateBps);

  if (!Number.isFinite(amount) || amount < 0) {
    throw new TypeError("Commission base amount must be a finite non-negative INR amount.");
  }

  if (
    !Number.isInteger(rateBps) ||
    rateBps < 0 ||
    rateBps > MAX_COMMISSION_RATE_BPS
  ) {
    throw new RangeError("Commission rate must be an integer from 0 to 5000 basis points.");
  }

  const commissionBasePaise = Math.round((amount + Number.EPSILON) * 100);
  if (!Number.isSafeInteger(commissionBasePaise)) {
    throw new RangeError("Commission base amount is outside the supported range.");
  }

  // BigInt keeps the percentage calculation exact even for larger amounts.
  const numerator =
    BigInt(commissionBasePaise) * BigInt(rateBps) +
    BigInt(BASIS_POINTS_DENOMINATOR / 2);
  const platformCommissionPaise = Number(
    numerator / BigInt(BASIS_POINTS_DENOMINATOR)
  );

  if (!Number.isSafeInteger(platformCommissionPaise)) {
    throw new RangeError("Calculated commission is outside the supported range.");
  }

  const driverEarningPaise = commissionBasePaise - platformCommissionPaise;

  return {
    commissionBasePaise,
    commissionRateBps: rateBps,
    platformCommissionPaise,
    driverEarningPaise,
  };
}
