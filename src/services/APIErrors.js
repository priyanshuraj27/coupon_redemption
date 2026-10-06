// Throw this from any controller/service to send a controlled error response.
// e.g. throw new APIError(404, 'Coupon not found', [], 'COUPON_NOT_FOUND');
// errorCode is a stable, machine-readable identifier so clients can tell apart
// failures that share an HTTP status (e.g. two different 409s).
class APIError extends Error {
  constructor(statusCode = 500, message = 'Something went wrong', errors = [], errorCode = null) {
    super(message);
    this.name = 'APIError';
    this.statusCode = statusCode;
    this.message = message;
    this.errors = errors; // optional extra detail, e.g. validation failures
    this.errorCode = errorCode;
    this.success = false;
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      success: this.success,
      statusCode: this.statusCode,
      ...(this.errorCode && { errorCode: this.errorCode }),
      message: this.message,
      ...(this.errors.length && { errors: this.errors }),
    };
  }
}

export default APIError;
