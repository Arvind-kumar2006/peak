// Express 4 does not forward a rejected promise from an async handler to the
// error middleware — the request just hangs until the client gives up. Since the
// dashboard polls every 2s, one unhandled throw in any route turns into a frozen
// UI on stage with nothing in the log.
//
// So every async handler is wrapped. Same one-liner P1 uses in demo-app, so the
// two services behave identically.

export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
