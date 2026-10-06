import mongoose from 'mongoose';
import APIError from '../services/APIErrors.js';
import { ERROR_CODES } from '../services/errorCodes.js';

// Converts anything thrown in a route into the APIError JSON shape.
// Must be registered after all routers.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let error = err;

  if (!(error instanceof APIError)) {
    if (error.code === 11000) {
      // Unique index violation (duplicate orderId, coupon code, or STANDARD coupon reuse)
      const fields = Object.keys(error.keyValue || {}).join(', ');
      error = new APIError(409, `Duplicate value for: ${fields}`, [error.keyValue], ERROR_CODES.DUPLICATE_KEY);
    } else if (error instanceof mongoose.Error.ValidationError) {
      const details = Object.values(error.errors).map((e) => ({ field: e.path, message: e.message }));
      error = new APIError(400, 'Validation failed', details, ERROR_CODES.VALIDATION_ERROR);
    } else if (error instanceof mongoose.Error.CastError) {
      error = new APIError(400, `Invalid value for ${error.path}`, [], ERROR_CODES.VALIDATION_ERROR);
    } else if (error.type === 'entity.parse.failed') {
      error = new APIError(400, 'Malformed JSON body', [], ERROR_CODES.VALIDATION_ERROR);
    } else {
      console.error(error);
      error = new APIError(500, 'Internal server error', [], ERROR_CODES.INTERNAL_ERROR);
    }
  }

  return res.status(error.statusCode).json(error.toJSON());
}

export default errorHandler;
