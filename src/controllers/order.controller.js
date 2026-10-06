import { runInTransaction } from '../db/transaction.js';
import Order, { ORDER_STATUS } from '../models/order.model.js';
import Customer from '../models/customer.model.js';
import Coupon from '../models/coupon.model.js';
import APIError from '../services/APIErrors.js';
import APIResponse from '../services/APIservices.js';
import asyncHandler from '../services/asyncHandler.js';
import { ERROR_CODES } from '../services/errorCodes.js';

const MAX_ORDER_ID_LENGTH = 255;

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Creates an order for a redeemed coupon and links it to the customer.
 * Must be called inside a transaction (pass its session) so the order, the
 * customer link and the coupon's redemption_count commit or roll back together.
 * The customer is created on first order if it doesn't exist yet.
 */
export async function createOrder({ session, orderId, userId, coupon, amount = null }) {
  const hasAmount = typeof amount === 'number';
  const discountAmount = hasAmount ? round2((amount * coupon.discount_percent) / 100) : null;

  const [order] = await Order.create(
    [
      {
        orderId,
        userId,
        couponId: coupon._id,
        coupon_type: coupon.type,
        discount_percent: coupon.discount_percent,
        amount: hasAmount ? amount : null,
        discount_amount: discountAmount,
        final_amount: hasAmount ? round2(amount - discountAmount) : null,
      },
    ],
    { session }
  );

  await Customer.updateOne(
    { userId },
    { $addToSet: { orderIds: orderId } },
    { upsert: true, session }
  );

  return order;
}

/**
 * POST /orders/:order_id/cancel
 *
 * Cancels an order and gives its coupon redemption slot back (redemption_count - 1).
 * The slot is returned at most once per order, however many times this is called:
 *
 * - The PLACED -> CANCELLED transition is a conditional update that only matches a
 *   PLACED order, so exactly one call can make it. The decrement runs only when this
 *   call made the transition, in the same transaction, so the status change and the
 *   refund commit together or not at all.
 * - Concurrent cancels of the same order write-conflict; the loser's transaction is
 *   re-run, now sees CANCELLED, and becomes a no-op.
 * - Calling it again later returns 200 with already_cancelled: true and changes nothing.
 *
 * Cancelling frees a STANDARD coupon for the same customer again, since the
 * one-use-per-customer unique index only covers PLACED orders.
 */
export const cancelOrder = asyncHandler(async (req, res) => {
  const orderId = req.params.order_id?.trim();
  if (!orderId || orderId.length > MAX_ORDER_ID_LENGTH) {
    throw new APIError(400, `order_id must be 1-${MAX_ORDER_ID_LENGTH} characters`, [], ERROR_CODES.VALIDATION_ERROR);
  }

  const result = await runInTransaction(async (session) => {
    const now = new Date();

    const cancelled = await Order.findOneAndUpdate(
      { orderId, status: ORDER_STATUS.PLACED },
      { status: ORDER_STATUS.CANCELLED, cancelled_at: now },
      { new: true, session }
    );

    if (!cancelled) {
      const existing = await Order.findOne({ orderId }).session(session).lean();
      if (!existing) {
        throw new APIError(404, `Order "${orderId}" does not exist`, [], ERROR_CODES.ORDER_NOT_FOUND);
      }
      // Already cancelled by an earlier call: no-op, the slot was returned back then
      return { order: existing, alreadyCancelled: true, slotReleased: false, couponCode: null };
    }

    if (!cancelled.couponId) {
      return { order: cancelled, alreadyCancelled: false, slotReleased: false, couponCode: null };
    }

    // Give the slot back and drop this order from used_by in one atomic update,
    // so used_by.length keeps matching redemption_count
    const coupon = await Coupon.findOneAndUpdate(
      { _id: cancelled.couponId, redemption_count: { $gt: 0 } },
      {
        $inc: { redemption_count: -1 },
        $pull: { used_by: { order_id: orderId } },
      },
      { new: true, session, projection: { used_by: 0 } }
    );

    if (!coupon) {
      if (await Coupon.exists({ _id: cancelled.couponId }).session(session)) {
        // The order holds a slot but the counter is already 0: data is inconsistent.
        // Throwing aborts the transaction, so the order stays PLACED.
        throw new Error(`Coupon ${cancelled.couponId} has redemption_count 0 but order "${orderId}" still holds a slot`);
      }
      // Coupon was deleted: nothing to give back, the order is still cancelled
      return { order: cancelled, alreadyCancelled: false, slotReleased: false, couponCode: null };
    }

    return { order: cancelled, alreadyCancelled: false, slotReleased: true, couponCode: coupon.code };
  });

  const { order, alreadyCancelled, slotReleased, couponCode } = result;
  const message = alreadyCancelled ? 'Order was already cancelled' : 'Order cancelled';

  return res.status(200).json(
    new APIResponse(200, message, {
      order_id: order.orderId,
      status: order.status,
      cancelled_at: order.cancelled_at,
      already_cancelled: alreadyCancelled,
      coupon_slot_released: slotReleased,
      coupon_code: couponCode,
    })
  );
});
