import mongoose from 'mongoose';

const COUPON_TYPES = Object.freeze({
  STANDARD: 'STANDARD', // once per user
  STACKABLE: 'STACKABLE', // many times per user, still capped by max_redemptions
});

const couponSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },
    // Total number of times this coupon can ever be redeemed, across all users.
    max_redemptions: {
      type: Number,
      required: true,
      min: 1,
      validate: { validator: Number.isInteger, message: 'max_redemptions must be an integer' },
    },
    // Live usage counter. Incremented atomically on redemption, decremented on order cancel.
    // Never update this with save(); use conditional $inc so concurrent requests can't overshoot.
    redemption_count: {
      type: Number,
      default: 0,
      min: 0,
    },
    discount_percent: {
      type: Number,
      required: true,
      min: 1,
      max: 100,
    },
    expires_at: {
      type: Date,
      required: true,
    },
    type: {
      type: String,
      enum: Object.values(COUPON_TYPES),
      default: COUPON_TYPES.STANDARD,
    },
    // Who redeemed this coupon. Server-owned: an entry is pushed in the same atomic
    // update that increments redemption_count, and pulled when that order is cancelled,
    // so used_by.length always equals redemption_count.
    used_by: {
      type: [
        new mongoose.Schema(
          {
            customer_id: { type: String, required: true },
            order_id: { type: String, required: true },
            used_at: { type: Date, required: true },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    // Id of the authenticated user who created the coupon. Server-owned: set from
    // req.user by the controller, never from the request body. Null until auth exists.
    created_by: {
      type: String,
      default: null,
      index: true,
    },
  },
  { timestamps: true }
);

couponSchema.path('redemption_count').validate(function (value) {
  if (this.max_redemptions == null) return true; // max_redemptions' own `required` reports this
  return value <= this.max_redemptions;
}, 'redemption_count cannot exceed max_redemptions');

couponSchema.methods.isExpired = function (now = new Date()) {
  return this.expires_at.getTime() <= now.getTime();
};

couponSchema.methods.isExhausted = function () {
  return this.redemption_count >= this.max_redemptions;
};

const Coupon = mongoose.model('Coupon', couponSchema);

export default Coupon;
export { COUPON_TYPES };
