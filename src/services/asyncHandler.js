// Wraps an async route handler so rejected promises / thrown errors are
// forwarded to Express's error middleware instead of crashing the process.
// e.g. router.post('/', asyncHandler(async (req, res) => { ... }));
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export default asyncHandler;
