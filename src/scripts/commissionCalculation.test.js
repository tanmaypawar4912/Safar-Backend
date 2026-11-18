import test from "node:test";
import assert from "node:assert/strict";

import { calculateCommissionAmounts } from "../services/commissionCalculationService.js";

test("10% commission splits a ₹1,000 booking into ₹100 and ₹900", () => {
  assert.deepEqual(
    calculateCommissionAmounts({ amountRupees: 1000, commissionRateBps: 1000 }),
    {
      commissionBasePaise: 100000,
      commissionRateBps: 1000,
      platformCommissionPaise: 10000,
      driverEarningPaise: 90000,
    }
  );
});

test("commission rounds to the nearest paise and preserves the full base", () => {
  const result = calculateCommissionAmounts({
    amountRupees: 999.99,
    commissionRateBps: 1000,
  });

  assert.equal(result.commissionBasePaise, 99999);
  assert.equal(result.platformCommissionPaise, 10000);
  assert.equal(result.driverEarningPaise, 89999);
  assert.equal(
    result.platformCommissionPaise + result.driverEarningPaise,
    result.commissionBasePaise
  );
});

test("zero commission leaves the full amount for the driver", () => {
  assert.deepEqual(
    calculateCommissionAmounts({ amountRupees: 125.5, commissionRateBps: 0 }),
    {
      commissionBasePaise: 12550,
      commissionRateBps: 0,
      platformCommissionPaise: 0,
      driverEarningPaise: 12550,
    }
  );
});

test("invalid or out-of-range commission rates are rejected", () => {
  for (const commissionRateBps of [-1, 5001, 10.5, "not-a-rate"]) {
    assert.throws(
      () => calculateCommissionAmounts({ amountRupees: 100, commissionRateBps }),
      /Commission rate/
    );
  }
});

test("negative or non-finite fare amounts are rejected", () => {
  for (const amountRupees of [-1, Number.NaN, Number.POSITIVE_INFINITY, "bad"]) {
    assert.throws(
      () => calculateCommissionAmounts({ amountRupees, commissionRateBps: 1000 }),
      /Commission base amount/
    );
  }
});
