/** Application error carrying a stable machine-readable code. */
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new ApiError(400, 'BAD_REQUEST', message, details);
export const invalidInput = (details) => new ApiError(422, 'INVALID_INPUT', 'Request payload failed validation', details);
export const unauthorized = (message = 'Authentication required') => new ApiError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'Not permitted') => new ApiError(403, 'FORBIDDEN', message);
export const notFound = (what = 'Resource') => new ApiError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (message, details) => new ApiError(409, 'CONFLICT', message, details);
export const tooManyRequests = (retryAfterSeconds) =>
  new ApiError(429, 'RATE_LIMITED', 'Too many requests', { retryAfterSeconds });
export const internal = (message = 'Internal error') => new ApiError(500, 'INTERNAL', message);
