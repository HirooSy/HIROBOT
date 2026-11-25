let enabled = process.env.FFNODE_DEBUG === '1' || process.env.FFNODE_DEBUG === 'true';

function setDebug(value) {
  enabled = Boolean(value);
}

function isDebug() {
  return enabled;
}

function debug(scope, message, data) {
  if (!enabled) return;
  let line = '[ffnode:' + scope + '] ' + message;
  if (data !== undefined) {
    line += ' ' + JSON.stringify(data, (key, value) => (typeof value === 'bigint' ? value.toString() : value));
  }
  process.stderr.write(line + '\n');
}

export {
  setDebug,
  isDebug,
  debug,
};
