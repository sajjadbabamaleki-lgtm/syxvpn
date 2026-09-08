/** Every successful response is `{ data, meta? }`; every failure is `{ error }`. */
export function ok(res, data, meta) {
  const body = meta ? { data, meta } : { data };
  return res.json(body);
}

export function created(res, data) {
  return res.status(201).json({ data });
}

export function fail(res, status, code, message, details) {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  return res.status(status).json({ error });
}
