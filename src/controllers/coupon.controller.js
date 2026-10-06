import Coupon from '../models/coupon.model.js';
import APIError from '../services/APIErrors.js';
import APIResponse from '../services/APIservices.js';
import asyncHandler from '../services/asyncHandler.js';
import { ERROR_CODES } from '../services/errorCodes.js';

const MAX_BATCH_SIZE = 100;
const MAX_CODE_LENGTH = 64;
// A linearizable read waits for a majority of the replica set to confirm it is current;
// bound it so a lost majority surfaces as an error instead of a hung request.
const STATS_READ_TIMEOUT_MS = 5000;

// Only these fields may be set by the client. redemption_count is server-owned.
const ALLOWED_FIELDS = ['code', 'max_redemptions', 'discount_percent', 'expires_at', 'type'];

// created_by comes from the authenticated user (set by future auth middleware), never the body
const currentUserId = (req) => req.user?.id ?? req.user?._id?.toString() ?? null;

const pickAllowed = (input) =>
  Object.fromEntries(ALLOWED_FIELDS.filter((f) => input[f] !== undefined).map((f) => [f, input[f]]));

// Accepts: a single coupon object, an array of coupons, or { coupons: [...] }
const extractCoupons = (body) => {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.coupons)) return body.coupons;
  if (body && typeof body === 'object' && Object.keys(body).length) return [body];
  return [];
};

/**
 * POST /api/coupons
 * Adds one or many coupons. Each coupon is validated independently and the
 * results are accumulated, so one bad coupon doesn't reject the whole batch.
 *   201 -> all created
 *   207 -> some created, some failed (see data.failed)
 *   409 -> none created, and every failure is an existing code (COUPON_CODE_CONFLICT)
 *   400 -> none created, at least one coupon was invalid (VALIDATION_ERROR)
 * Each entry in failed carries its own errorCode so clients can tell conflicts from bad input.
 */
export const addCoupons = asyncHandler(async (req, res) => {
  const input = extractCoupons(req.body);

  if (!input.length) {
    throw new APIError(400, 'Request body must contain at least one coupon', [], ERROR_CODES.VALIDATION_ERROR);
  }
  if (input.length > MAX_BATCH_SIZE) {
    throw new APIError(400, `Cannot add more than ${MAX_BATCH_SIZE} coupons per request`, [], ERROR_CODES.VALIDATION_ERROR);
  }

  const now = new Date();
  const createdBy = currentUserId(req);
  const failed = [];
  const candidates = []; // { index, doc }
  const seenCodes = new Set();

  // 1. Validate every coupon on its own, accumulating failures
  input.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      failed.push({ index, code: null, errorCode: ERROR_CODES.VALIDATION_ERROR, errors: ['Coupon must be an object'] });
      return;
    }

    const doc = new Coupon({ ...pickAllowed(raw), created_by: createdBy });
    const errors = [];

    const validationError = doc.validateSync();
    if (validationError) {
      errors.push(...Object.values(validationError.errors).map((e) => `${e.path}: ${e.message}`));
    }
    if (doc.expires_at instanceof Date && !Number.isNaN(doc.expires_at.getTime()) && doc.expires_at <= now) {
      errors.push('expires_at: must be in the future');
    }
    if (doc.code && seenCodes.has(doc.code)) {
      errors.push(`code: duplicate code "${doc.code}" in this request`);
    }

    if (errors.length) {
      failed.push({ index, code: doc.code ?? null, errorCode: ERROR_CODES.VALIDATION_ERROR, errors });
      return;
    }

    seenCodes.add(doc.code);
    candidates.push({ index, doc });
  });

  // 2. Reject codes that already exist in the database
  if (candidates.length) {
    const existing = await Coupon.find({ code: { $in: [...seenCodes] } }, { code: 1 }).lean();
    const existingCodes = new Set(existing.map((c) => c.code));

    for (let i = candidates.length - 1; i >= 0; i--) {
      const { index, doc } = candidates[i];
      if (existingCodes.has(doc.code)) {
        failed.push({
          index,
          code: doc.code,
          errorCode: ERROR_CODES.COUPON_CODE_CONFLICT,
          errors: [`code: "${doc.code}" already exists`],
        });
        candidates.splice(i, 1);
      }
    }
  }

  // 3. Insert the rest. ordered:false keeps inserting past individual failures
  //    (e.g. a concurrent request creating the same code between step 2 and now).
  let created = [];
  if (candidates.length) {
    try {
      created = await Coupon.insertMany(
        candidates.map((c) => c.doc),
        { ordered: false }
      );
    } catch (err) {
      if (!err.writeErrors) throw err;

      created = err.insertedDocs || [];
      for (const writeError of err.writeErrors) {
        const { index, doc } = candidates[writeError.index];
        const { code, errmsg } = writeError.err ?? writeError;
        const isConflict = code === 11000;
        failed.push({
          index,
          code: doc.code,
          errorCode: isConflict ? ERROR_CODES.COUPON_CODE_CONFLICT : ERROR_CODES.INTERNAL_ERROR,
          errors: [isConflict ? `code: "${doc.code}" already exists` : errmsg || 'Insert failed'],
        });
      }
    }
  }

  failed.sort((a, b) => a.index - b.index);

  if (!created.length) {
    // Nothing wrong with the request itself, the codes are just taken -> 409
    const allConflicts = failed.every((f) => f.errorCode === ERROR_CODES.COUPON_CODE_CONFLICT);
    if (allConflicts) {
      throw new APIError(409, 'No coupons were created: every code already exists', failed, ERROR_CODES.COUPON_CODE_CONFLICT);
    }
    throw new APIError(400, 'No coupons were created', failed, ERROR_CODES.VALIDATION_ERROR);
  }

  const statusCode = failed.length ? 207 : 201;
  const message = failed.length
    ? `${created.length} of ${input.length} coupons created`
    : `${created.length} coupon(s) created`;

  return res.status(statusCode).json(new APIResponse(statusCode, message, { created, failed }));
});

/**
 * GET /api/coupons/:code
 * Returns { redeemed_count, remaining, max_redemptions } for a coupon.
 *
 * The counts must be exact at the moment of the request, never eventually correct:
 * - Read from the primary with readConcern 'linearizable': the result reflects every
 *   write that was majority-acknowledged before this read started. Redemptions commit
 *   with w: majority (see db/transaction.js), so a redeem that has returned is always
 *   visible here, and a count that could still be rolled back never is.
 * - redemption_count only changes inside redemption/cancel transactions, so it is never
 *   seen half-applied: an increment becomes visible together with its order, or not at all.
 * - An expired coupon can't be redeemed any more, so it reports remaining: 0.
 * - The response always satisfies redeemed_count + remaining = max_redemptions: whenever
 *   remaining is 0 (exhausted or expired), redeemed_count is reported as max_redemptions.
 */
export const getCouponStats = asyncHandler(async (req, res) => {
  const code = req.params.code?.trim().toUpperCase();
  if (!code || code.length > MAX_CODE_LENGTH) {
    throw new APIError(400, `code must be 1-${MAX_CODE_LENGTH} characters`, [], ERROR_CODES.VALIDATION_ERROR);
  }

  const coupon = await Coupon.findOne({ code }, { redemption_count: 1, max_redemptions: 1, expires_at: 1 })
    .read('primary')
    .readConcern('linearizable')
    .maxTimeMS(STATS_READ_TIMEOUT_MS)
    .lean();

  if (!coupon) {
    throw new APIError(404, `Coupon "${code}" does not exist`, [], ERROR_CODES.COUPON_NOT_FOUND);
  }

  const expired = coupon.expires_at.getTime() <= Date.now();
  const remaining = expired ? 0 : Math.max(coupon.max_redemptions - coupon.redemption_count, 0);

  return res.status(200).json(
    new APIResponse(200, 'Coupon stats', {
      redeemed_count: remaining === 0 ? coupon.max_redemptions : coupon.redemption_count,
      remaining,
      max_redemptions: coupon.max_redemptions,
    })
  );
});
