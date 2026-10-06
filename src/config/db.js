import mongoose from 'mongoose';

async function connectDB(uri) {
  await mongoose.connect(uri);
  // Build declared indexes (unique constraints are what enforce one-time redemption).
  await mongoose.syncIndexes();
  console.log('MongoDB connected');
}

export default connectDB;
