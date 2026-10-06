import mongoose from 'mongoose';

// Any query run inside runInTransaction() automatically joins the transaction's
// session, even if `.session(session)` was forgotten.
mongoose.set('transactionAsyncLocalStorage', true);

async function connectDB() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error('MONGO_URI is not defined in .env');
  }

  await mongoose.connect(uri);

  // Redemptions rely on multi-document transactions, which need a replica set
  // (or sharded cluster). Fail fast instead of erroring on the first redeem.
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid') {
    throw new Error(
      'MongoDB is running standalone. Transactions require a replica set: ' +
        'start mongod with --replSet rs0, run rs.initiate() once, and add ?replicaSet=rs0 to MONGO_URI'
    );
  }

  // Build declared indexes (unique constraints are what enforce one-time redemption).
  await mongoose.syncIndexes();
  console.log('MongoDB connected');
}

export default connectDB;
