// Central error handler.
//  - Client mistakes (bad JSON, bad IDs, validation) answer with a clear 4xx and are NOT logged as
//    errors, so production logs only show real problems.
//  - Unexpected 5xx errors are logged in full but, in production, the browser only ever sees a generic
//    message (internal details such as file paths or database names must not leak).
function errorHandler(err, req, res, next) {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'The request body is not valid JSON' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'The request is too large' });
  }
  if (err.name === 'ValidationError') {
    return res.status(400).json({ error: 'Validation failed', details: err.message });
  }
  if (err.code === 11000) {
    return res.status(409).json({ error: 'Duplicate value', details: err.keyValue });
  }
  if (err.name === 'CastError') {
    return res.status(400).json({ error: 'Invalid ID format' });
  }

  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  const hide = status >= 500 && process.env.NODE_ENV === 'production';
  res.status(status).json({ error: hide ? 'Something went wrong on our side. Please try again.' : err.message || 'Server error' });
}

module.exports = errorHandler;
