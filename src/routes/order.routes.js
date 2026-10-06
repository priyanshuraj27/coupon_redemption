import { Router } from 'express';
import { cancelOrder } from '../controllers/order.controller.js';

const router = Router();

router.post('/:order_id/cancel', cancelOrder);

export default router;
