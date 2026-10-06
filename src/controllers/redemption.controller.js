import crypto from 'node:crypto';
import { runInTransaction } from '../db/transaction.js';
import Coupon, { COUPON_TYPES } from '../models/coupon.model.js';
import Order, { ORDER_STATUS } from '../models/order.model.js';
import IdempotencyKey, { IDEMPOTENCY_STATUS } from '../models/idempotencyKey.model.js';
import { createOrder } from './order.controller.js';
import APIError from '../services/APIErrors.js';
import APIResponse from '../services/APIservices.js';
import asyncHandler from '../services/asyncHandler.js';
import { ERROR_CODES } from '../services/errorCodes.js';

const ENDPOINT = 'POST /redeem';
const MAX_KEY_LENGTH = 255;
// A key left IN_PROGRESS longer than this (e.g. the server crashed mid-request) may be taken over
const STALE_LOCK_MS = 30 * 1000;

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

function validateRequest(req) {
  const key = req.get('Idempotency-Key')?.trim();
  if (!key) {
    throw new APIError(400, 'Idempotency-Key header is required', [], ERROR_CODES.IDEMPOTENCY_KEY_MISSING);
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new APIError(400, `Idempotency-Key must be at most ${MAX_KEY_LENGTH} characters`, [], ERROR_CODES.VALIDATION_ERROR);
  }

  const { code, customer_id, order_id, amount } = req.body ?? {};
  const errors = [];
  if (!isNonEmptyString(code)) errors.push('code: required string');
  if (!isNonEmptyString(customer_id)) errors.push('customer_id: required string');
  if (!isNonEmptyString(order_id)) errors.push('order_id: required string');
  if (amount !== undefined && !(typeof amount === 'number' && Number.isFinite(amount) && amount >= 0)) {
    errors.push('amount: must be a non-negative number');
  }
  if (errors.length) {
    throw new APIError(400, 'Invalid redemption request', errors, ERROR_CODES.VALIDATION_ERROR);
  }

  const payload = {
    code: code.trim().toUpperCase(),
    customer_id: customer_id.trim(),
    order_id: order_id.trim(),
    amount: amount ?? null,
  };
  return { key, payload };
}

const hashPayload = (payload) => crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');

/**
 * Claims the idempotency key for this attempt.
 * Returns { lockId } when this request should run, or { replay } with the
 * stored record when the same request already completed.
 */
async function claimIdempotencyKey(key, requestHash) {
  const lockId = crypto.randomUUID();

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await IdempotencyKey.create({ key, endpoint: ENDPOINT, request_hash: requestHash, lock_id: lockId });
      return { lockId };
    } catch (err) {
      if (err.code !== 11000) throw err;
    }

    const existing = await IdempotencyKey.findOne({ key }).lean();
    if (!existing) continue; // expired between our insert and read; try again

    if (existing.endpoint !== ENDPOINT || existing.request_hash !== requestHash) {
      throw new APIError(
        422,
        'Idempotency-Key was already used with a different request',
        [],
        ERROR_CODES.IDEMPOTENCY_KEY_REUSED
      );
    }

    if (existing.status === IDEMPOTENCY_STATUS.COMPLETED) {
      return { replay: existing };
    }

    // IN_PROGRESS: take over only if the previous attempt looks dead
    const takenOver = await IdempotencyKey.findOneAndUpdate(
      {
        key,
        status: IDEMPOTENCY_STATUS.IN_PROGRESS,
        locked_at: { $lt: new Date(Date.now() - STALE_LOCK_MS) },
      },
      { lock_id: lockId, locked_at: new Date() }
    );
    if (takenOver) return { lockId };

    throw new APIError(
      409,
      'A request with this Idempotency-Key is still being processed',
      [],
      ERROR_CODES.IDEMPOTENCY_REQUEST_IN_PROGRESS
    );
  }

  throw new APIError(409, 'Could not acquire Idempotency-Key, please retry', [], ERROR_CODES.IDEMPOTENCY_REQUEST_IN_PROGRESS);
}

const completeIdempotencyKey = (key, lockId, statusCode, body, session) =>
  IdempotencyKey.updateOne(
    { key, lock_id: lockId, status: IDEMPOTENCY_STATUS.IN_PROGRESS },
    { status: IDEMPOTENCY_STATUS.COMPLETED, response_status: statusCode, response_body: body },
    { session }
  );

// Duplicate-key errors raised by unique indexes inside the transaction
function mapDuplicateKeyError(err) {
  if (err?.code !== 11000) return err;
  const fields = Object.keys(err.keyPattern || {});
  if (fields.includes('orderId')) {
    return new APIError(409, 'An order with this order_id already exists', [], ERROR_CODES.ORDER_ALREADY_EXISTS);
  }
  if (fields.includes('couponId') && fields.includes('userId')) {
    return new APIError(409, 'This coupon has already been used by this customer', [], ERROR_CODES.COUPON_ALREADY_USED);
  }
  return err;
}

/**
 * The redemption itself, run as a single ACID transaction (see runInTransaction):
 *
 * - Atomicity:   coupon increment, order insert, customer link and the stored
 *                idempotent response commit together, or none of them do.
 *                Any throw below aborts and rolls back every earlier write.
 * - Consistency: redemption_count can never pass max_redemptions (conditional $inc),
 *                and unique indexes (orderId; userId+couponId for active STANDARD
 *                orders) reject anything the checks below could miss.
 * - Isolation:   snapshot reads; two transactions touching the same coupon conflict,
 *                the loser is rolled back and re-run against the new state, so
 *                concurrent redemptions behave as if they ran one after another.
 * - Durability:  commit waits for a majority of replica set members to journal it.
 *
 * Because the callback can be re-run on a write conflict, it only reads and
 * writes through `session` and keeps no outside side effects.
 */
async function redeemInTransaction(session, { key, lockId, payload }) {
  const { code, customer_id, order_id, amount } = payload;
  const now = new Date();

  if (await Order.exists({ orderId: order_id }).session(session)) {
    throw new APIError(409, 'An order with this order_id already exists', [], ERROR_CODES.ORDER_ALREADY_EXISTS);
  }

  // 1. Unknown code
  const coupon = await Coupon.findOne({ code }).select('-used_by').session(session);
  if (!coupon) {
    throw new APIError(404, `Coupon "${code}" does not exist`, [], ERROR_CODES.COUPON_NOT_FOUND);
  }

  // 2. Expired
  if (coupon.isExpired(now)) {
    throw new APIError(410, `Coupon "${code}" expired at ${coupon.expires_at.toISOString()}`, [], ERROR_CODES.COUPON_EXPIRED);
  }

  // 3. STANDARD coupons: this customer must not have an active order using it
  if (coupon.type === COUPON_TYPES.STANDARD) {
    const alreadyUsed = await Order.exists({
      userId: customer_id,
      couponId: coupon._id,
      status: ORDER_STATUS.PLACED,
    }).session(session);
    if (alreadyUsed) {
      throw new APIError(409, `Coupon "${code}" has already been used by this customer`, [], ERROR_CODES.COUPON_ALREADY_USED);
    }
  }

  // 4. Redemptions left: increment only while redemption_count < max_redemptions,
  //    and record who used it in the same atomic update
  const updated = await Coupon.findOneAndUpdate(
    {
      _id: coupon._id,
      expires_at: { $gt: now },
      $expr: { $lt: ['$redemption_count', '$max_redemptions'] },
    },
    {
      $inc: { redemption_count: 1 },
      $push: { used_by: { customer_id, order_id, used_at: now } },
    },
    { new: true, session, projection: { used_by: 0 } } // used_by can be large; not needed here
  );
  if (!updated) {
    throw new APIError(409, `Coupon "${code}" has no redemptions left`, [], ERROR_CODES.COUPON_EXHAUSTED);
  }

  const order = await createOrder({ session, orderId: order_id, userId: customer_id, coupon: updated, amount });

  const statusCode = 201;
  const body = new APIResponse(statusCode, 'Coupon redeemed', {
    remaining: updated.max_redemptions - updated.redemption_count,
    code: updated.code,
    customer_id,
    order_id,
    discount_percent: order.discount_percent,
    amount: order.amount,
    discount_amount: order.discount_amount,
    final_amount: order.final_amount,
  });

  // Store the response in the same transaction, so a committed redemption always has a replayable response
  const { matchedCount } = await completeIdempotencyKey(key, lockId, statusCode, body, session);
  if (!matchedCount) {
    throw new Error('Lost the Idempotency-Key lock during redemption'); // aborts the transaction
  }

  return { statusCode, body };
}

/**
 * POST /redeem
 * Header: Idempotency-Key
 * Body:   { code, customer_id, order_id, amount? }
 */
export const redeemCoupon = asyncHandler(async (req, res) => {
  const { key, payload } = validateRequest(req);
  const claim = await claimIdempotencyKey(key, hashPayload(payload));

  // Same key + same request already completed: nothing is redeemed again
  if (claim.replay) {
    const { response_status: originalStatus, response_body: originalBody } = claim.replay;
    res.set('Idempotent-Replayed', 'true');

    // The original attempt was rejected: return that same error
    if (originalStatus >= 400) {
      return res.status(originalStatus).json(originalBody);
    }

    // The original attempt redeemed the coupon: report it as already redeemed (409),
    // with the original result attached so a client that lost it can still read it
    throw new APIError(
      409,
      `Coupon "${payload.code}" was already redeemed for order "${payload.order_id}" by this request`,
      [{ original_status: originalStatus, original_response: originalBody }],
      ERROR_CODES.COUPON_ALREADY_REDEEMED
    );
  }

  try {
    const { statusCode, body } = await runInTransaction((session) =>
      redeemInTransaction(session, { key, lockId: claim.lockId, payload })
    );
    return res.status(statusCode).json(body);
  } catch (rawErr) {
    const err = mapDuplicateKeyError(rawErr);

    if (err instanceof APIError && err.statusCode < 500) {
      // Business rejection: remember it, so a retry with this key gets the same answer
      await completeIdempotencyKey(key, claim.lockId, err.statusCode, err.toJSON());
    } else {
      // Unexpected failure: nothing was committed, release the key so the client can retry
      await IdempotencyKey.deleteOne({ key, lock_id: claim.lockId });
    }
    throw err;
  }
});
