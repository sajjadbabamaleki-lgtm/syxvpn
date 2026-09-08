const stamp = () => new Date().toISOString();

export const log = {
  info: (msg, fields) => process.stdout.write(`${JSON.stringify({ ts: stamp(), level: 'info', msg, ...fields })}\n`),
  warn: (msg, fields) => process.stderr.write(`${JSON.stringify({ ts: stamp(), level: 'warn', msg, ...fields })}\n`),
  error: (msg, fields) => process.stderr.write(`${JSON.stringify({ ts: stamp(), level: 'error', msg, ...fields })}\n`),
};
