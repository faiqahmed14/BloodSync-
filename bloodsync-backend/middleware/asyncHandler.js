// Wraps an async route handler so thrown errors are forwarded to next(),
// instead of needing try/catch in every controller function.
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
