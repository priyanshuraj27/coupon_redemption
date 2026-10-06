// Seeds sample coupons covering every state GET /api/coupons/:code can report.
// Re-runnable: existing seed coupons and the orders made with them are removed first.
// Usage: npm run seed
import 'dotenv/config';
import mongoose from 'mongoose';
import Coupon, { COUPON_TYPES } from '../src/models/coupon.model.js';
import Order from '../src/models/order.model.js';
import Customer from '../src/models/customer.model.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const inDays = (n) => new Date(Date.now() + n * DAY_MS);

const SEED_COUPONS = [
  // fresh, nothing redeemed
  { code: 'WELCOME10', max_redemptions: 100, discount_percent: 10, expires_at: inDays(30), type: COUPON_TYPES.STANDARD },
  // partially redeemed
  { code: 'SUMMER25', max_redemptions: 50, redemption_count: 20, discount_percent: 25, expires_at: inDays(60), type: COUPON_TYPES.STACKABLE },
  // one redemption left
  { code: 'LASTONE', max_redemptions: 5, redemption_count: 4, discount_percent: 15, expires_at: inDays(7), type: COUPON_TYPES.STANDARD },
  // fully redeemed
  { code: 'SOLDOUT', max_redemptions: 3, redemption_count: 3, discount_percent: 50, expires_at: inDays(14), type: COUPON_TYPES.STANDARD },
  // expired with redemptions left
  { code: 'EXPIRED20', max_redemptions: 10, redemption_count: 2, discount_percent: 20, expires_at: inDays(-1), type: COUPON_TYPES.STANDARD },
  // small cap, for concurrent redemption tests
  { code: 'FLASH5', max_redemptions: 5, discount_percent: 30, expires_at: inDays(1), type: COUPON_TYPES.STACKABLE },
];

async function seed() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not defined in .env');
  await mongoose.connect(process.env.MONGO_URI);

  const codes = SEED_COUPONS.map((c) => c.code);
  const old = await Coupon.find({ code: { $in: codes } }, { _id: 1 }).lean();
  if (old.length) {
    const oldOrders = await Order.find({ couponId: { $in: old.map((c) => c._id) } }, { orderId: 1 }).lean();
    const orderIds = oldOrders.map((o) => o.orderId);
    await Customer.updateMany({ orderIds: { $in: orderIds } }, { $pull: { orderIds: { $in: orderIds } } });
    await Order.deleteMany({ orderId: { $in: orderIds } });
    await Coupon.deleteMany({ _id: { $in: old.map((c) => c._id) } });
    console.log(`Removed ${old.length} old seed coupon(s) and ${orderIds.length} order(s)`);
  }

  const created = await Coupon.insertMany(SEED_COUPONS);
  for (const c of created) {
    console.log(`  ${c.code.padEnd(10)} ${c.redemption_count}/${c.max_redemptions}  expires ${c.expires_at.toISOString()}`);
  }
  console.log(`Seeded ${created.length} coupon(s)`);
}

seed()
  .catch((err) => {
    console.error('Seeding failed:', err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
