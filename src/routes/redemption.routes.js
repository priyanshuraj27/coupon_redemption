import { Router } from 'express';
import { redeemCoupon } from '../controllers/redemption.controller.js';

const router = Router();

router.post('/', redeemCoupon);

export default router;
