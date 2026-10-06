const mongoose = require('mongoose');

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
  },
  { timestamps: true }
);

couponSchema.path('redemption_count').validate(function (value) {
  return value <= this.max_redemptions;
}, 'redemption_count cannot exceed max_redemptions');

couponSchema.methods.isExpired = function (now = new Date()) {
  return this.expires_at.getTime() <= now.getTime();
};

couponSchema.methods.isExhausted = function () {
  return this.redemption_count >= this.max_redemptions;
};

const Coupon = mongoose.model('Coupon', couponSchema);

module.exports = Coupon;
module.exports.COUPON_TYPES = COUPON_TYPES;
