function serialize(details) {
  if (!details || Object.keys(details).length === 0) return '';
  return ` ${JSON.stringify(details, (_key, value) => {
    if (value instanceof Error) {
      return { name: value.name, message: value.message, code: value.code };
    }
    return value;
  })}`;
}

function write(method, message, details = {}) {
  console[method](`[${new Date().toISOString()}] [IdleRPG] ${message}${serialize(details)}`);
}

export const logger = {
  info: (message, details) => write('log', message, details),
  warn: (message, details) => write('warn', message, details),
  error: (message, details) => write('error', message, details),
};
