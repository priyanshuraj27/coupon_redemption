Remaining tasks - 
Deletion of order,
<!-- Get Coupon code(need to implement ACID , transactions properties in here) -->
<!-- We have to take the expiry of the coupon in account , -->
<!-- , Each coupon redeemption has to be a transaction otherwise bulk redeemption can cause problem,  -->

A coupon cannot be redeemed more than max_redemptions times — even under a burst of simultaneous checkouts on a flash-sale coupon. done 
A STANDARD coupon can only be redeemed once per customer_id, ever. done 
A STACKABLE coupon (e.g. referral codes) has no per-customer limit, but still respects max_redemptions globally. done 
A coupon redeemed after expires_at must be rejected — but a redemption in flight at the exact expiry instant must resolve consistently, not by luck of thread scheduling.
Orders can be cancelled. Cancelling an order that used a coupon must give the redemption slot back (redeemed_count decrements) — but only once per order, even if the cancellation endpoint is called twice.
Retrying the same redemption request (network client retries after a timeout, doesn't know if the first one landed) must not double-redeem. Callers send an Idempotency-Key header on POST /redeem.
