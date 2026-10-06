const mongoose = require('mongoose');
const { COUPON_TYPES } = require('./coupon.model');

const ORDER_STATUS = Object.freeze({
  PLACED: 'PLACED',
  CANCELLED: 'CANCELLED',
});

const orderSchema = new mongoose.Schema(
  {
    // Business id, supplied by the client. Doubles as the idempotency key:
    // retrying a request with the same orderId hits the unique index instead
    // of creating a second order / redeeming the coupon twice.
    orderId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    // FK -> Customer.userId
    userId: {
      type: String,
      required: true,
      index: true,
    },
    // FK -> Coupon._id (optional: an order may have no coupon)
    couponId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Coupon',
      default: null,
    },
    // Snapshot of the coupon type at redemption time; needed by the partial
    // unique index below (index filters can't look into another collection).
    coupon_type: {
      type: String,
      enum: [...Object.values(COUPON_TYPES), null],
      default: null,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    discount_amount: {
      type: Number,
      default: 0,
      min: 0,
    },
    final_amount: {
      type: Number,
      required: true,
      min: 0,
    },
    status: {
      type: String,
      enum: Object.values(ORDER_STATUS),
      default: ORDER_STATUS.PLACED,
    },
    cancelled_at: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

// DB-level guarantee: a user can hold at most one active (PLACED) order per
// STANDARD coupon. Cancelling the order frees the slot so the user may use it again.
orderSchema.index(
  { userId: 1, couponId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      coupon_type: COUPON_TYPES.STANDARD,
      status: ORDER_STATUS.PLACED,
    },
  }
);

orderSchema.virtual('customer', {
  ref: 'Customer',
  localField: 'userId',
  foreignField: 'userId',
  justOne: true,
});

const Order = mongoose.model('Order', orderSchema);

module.exports = Order;
module.exports.ORDER_STATUS = ORDER_STATUS;
