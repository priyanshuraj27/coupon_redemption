// Uniform success payload.
// e.g. res.status(201).json(new APIResponse(201, 'Order placed', order));
class APIResponse {
  constructor(statusCode = 200, message = 'Success', data = null) {
    this.success = statusCode < 400;
    this.statusCode = statusCode;
    this.message = message;
    if (data !== null && data !== undefined) this.data = data;
  }
}

export default APIResponse;
