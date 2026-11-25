class FFError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FFError';
    this.code = code;
  }
}

const badArg = (message) => new FFError('EINVAL', message);
const badData = (message) => new FFError('EFORMAT', message);
const noSupport = (message) => new FFError('EUNSUPPORTED', message);

function wrap(error) {
  if (error instanceof FFError) return error;
  if (error && typeof error.code === 'string' && error.syscall) return error;
  const wrapped = new FFError('EFORMAT', 'invalid or corrupt data: ' + (error && error.message ? error.message : String(error)));
  wrapped.cause = error;
  return wrapped;
}

export {
  FFError,
  badArg,
  badData,
  noSupport,
  wrap,
};
