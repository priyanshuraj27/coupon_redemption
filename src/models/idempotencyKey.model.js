import mongoose from 'mongoose';

const IDEMPOTENCY_STATUS = Object.freeze({
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
});

// How long a stored response can be replayed before the key is forgotten.
const KEY_TTL_SECONDS = 24 * 60 * 60;

const idempotencyKeySchema = new mongoose.Schema(
  {
    // Value of the Idempotency-Key request header
    key: {
      type: String,
      required: true,
      unique: true,
    },
    // Endpoint the key was used on, so one key can't be replayed against another route
    endpoint: {
      type: String,
      required: true,
    },
    // SHA-256 of the normalized request body; a replay with a different body is rejected
    request_hash: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: Object.values(IDEMPOTENCY_STATUS),
      default: IDEMPOTENCY_STATUS.IN_PROGRESS,
    },
    // Random token of the attempt currently holding the key; only that attempt may complete it
    lock_id: {
      type: String,
      required: true,
    },
    // When the current attempt claimed the key; used to recover keys left IN_PROGRESS by a crash
    locked_at: {
      type: Date,
      default: Date.now,
    },
    response_status: {
      type: Number,
      default: null,
    },
    response_body: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  { timestamps: true }
);

// MongoDB removes keys automatically once they are older than the TTL
idempotencyKeySchema.index({ createdAt: 1 }, { expireAfterSeconds: KEY_TTL_SECONDS });

const IdempotencyKey = mongoose.model('IdempotencyKey', idempotencyKeySchema);

export default IdempotencyKey;
export { IDEMPOTENCY_STATUS };
