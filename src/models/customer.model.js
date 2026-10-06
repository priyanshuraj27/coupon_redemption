const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    // FKs -> Order.orderId. A customer can have many orders.
    orderIds: {
      type: [String],
      default: [],
    },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

// customer.populate('orders') resolves orderIds to full Order documents.
customerSchema.virtual('orders', {
  ref: 'Order',
  localField: 'orderIds',
  foreignField: 'orderId',
});

const Customer = mongoose.model('Customer', customerSchema);

module.exports = Customer;
