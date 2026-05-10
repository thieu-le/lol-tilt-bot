// Tiny timestamped console logger. Avoids pulling in a logger library for a bot
// of this size — `console.*` is fine, we just want a uniform prefix.

function ts() {
  return new Date().toISOString();
}

function format(level, args) {
  return [`[${ts()}] [${level}]`, ...args];
}

export const logger = {
  info: (...args) => console.log(...format('INFO', args)),
  warn: (...args) => console.warn(...format('WARN', args)),
  error: (...args) => console.error(...format('ERROR', args)),
  debug: (...args) => {
    if (process.env.DEBUG) console.log(...format('DEBUG', args));
  },
};
