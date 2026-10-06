// Stable error identifiers returned as `errorCode` in error responses.
export const ERROR_CODES = Object.freeze({
  // generic
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  DUPLICATE_KEY: 'DUPLICATE_KEY',
  ROUTE_NOT_FOUND: 'ROUTE_NOT_FOUND',
  INTERNAL_ERROR: 'INTERNAL_ERROR',

  // coupon creation
  COUPON_CODE_CONFLICT: 'COUPON_CODE_CONFLICT', // a coupon with this code already exists

  // redemption
  COUPON_NOT_FOUND: 'COUPON_NOT_FOUND', // unknown code
  COUPON_EXPIRED: 'COUPON_EXPIRED',
  COUPON_EXHAUSTED: 'COUPON_EXHAUSTED', // no redemptions left
  COUPON_ALREADY_USED: 'COUPON_ALREADY_USED', // STANDARD coupon already used by this customer
  ORDER_ALREADY_EXISTS: 'ORDER_ALREADY_EXISTS',

  // orders
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',

  // idempotency
  IDEMPOTENCY_KEY_MISSING: 'IDEMPOTENCY_KEY_MISSING',
  COUPON_ALREADY_REDEEMED: 'COUPON_ALREADY_REDEEMED', // replay of a request that already redeemed successfully
  IDEMPOTENCY_KEY_REUSED:'IDEMPOTENCY_KEY_REUSED', // same key, different payload
  IDEMPOTENCY_REQUEST_IN_PROGRESS: 'IDEMPOTENCY_REQUEST_IN_PROGRESS',
});
