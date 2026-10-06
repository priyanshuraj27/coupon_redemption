import mongoose from 'mongoose';

/**
 * Transaction settings used for every coupon redemption / order change.
 *
 * - readConcern 'snapshot'  -> Isolation: every read in the transaction sees one
 *   consistent point-in-time view; concurrent writes to the same document cause a
 *   write conflict, and the losing transaction is retried from the start.
 * - writeConcern majority + journal -> Durability: commit is acknowledged only once
 *   a majority of replica set members have the changes on disk.
 * - readPreference 'primary' -> transactions must read from the primary.
 */
export const TRANSACTION_OPTIONS = Object.freeze({
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority', j: true },
  readPreference: 'primary',
});

/**
 * Runs fn(session) as one ACID transaction (Atomicity: all writes commit or none do).
 * Retries the whole callback on transient errors (write conflicts, failovers), and
 * retries the commit if its outcome is unknown. Every query inside fn must use
 * `session`; transactionAsyncLocalStorage (see connect.js) attaches it automatically
 * as a safety net.
 */
export function runInTransaction(fn) {
  return mongoose.connection.transaction(fn, TRANSACTION_OPTIONS);
}
