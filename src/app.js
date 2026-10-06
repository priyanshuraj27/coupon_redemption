import express from 'express';
import cors from 'cors';
import APIError from './services/APIErrors.js';
import errorHandler from './middlewares/errorHandler.js';
import couponRouter from './routes/coupon.routes.js';
import redemptionRouter from './routes/redemption.routes.js';
import orderRouter from './routes/order.routes.js';
import { ERROR_CODES } from './services/errorCodes.js';

const app = express();

// CORS
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true,
  })
);

// Request body size limits
app.use(express.json({ limit: '16kb' }));
app.use(express.urlencoded({ extended: true, limit: '16kb' }));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Routers
// app.use('/api/customers', customerRouter);  // import customerRouter from './routes/customer.routes.js';
app.use('/api/coupons', couponRouter);
app.use('/redeem', redemptionRouter);
app.use('/orders', orderRouter);

// 404 for unmatched routes, then the central error handler (must stay last)
app.use((req, res, next) => next(new APIError(404, `Route not found: ${req.method} ${req.originalUrl}`, [], ERROR_CODES.ROUTE_NOT_FOUND)));
app.use(errorHandler);

export default app;
