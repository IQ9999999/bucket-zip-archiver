/**
 * Minimal structured logger. Passing a single object to console.* lets the
 * Lambda runtime emit it as a nested JSON "message" when the function uses
 * the JSON log format, so fields are queryable in CloudWatch Logs Insights.
 * Level filtering is handled by the function's ApplicationLogLevel setting.
 */
export const logger = {
  debug: (message, fields = {}) => console.debug({ message, ...fields }),
  info: (message, fields = {}) => console.info({ message, ...fields }),
  warn: (message, fields = {}) => console.warn({ message, ...fields }),
  error: (message, fields = {}) => console.error({ message, ...fields }),
};
