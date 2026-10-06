const express = require('express');

const app = express();

app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Routers will be mounted here, e.g.:
// app.use('/api/customers', require('./routes/customer.routes'));
// app.use('/api/coupons', require('./routes/coupon.routes'));
// app.use('/api/orders', require('./routes/order.routes'));

module.exports = app;
