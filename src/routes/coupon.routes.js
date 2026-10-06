import { Router } from 'express';
import { addCoupons, getCouponStats } from '../controllers/coupon.controller.js';

const router = Router();

router.post('/', addCoupons);
router.get('/:code', getCouponStats);

export default router;
