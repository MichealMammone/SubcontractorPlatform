// Entry point: starts the HTTP server and housekeeping, and shuts down cleanly on SIGTERM (Render deploys).
import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';
import { loadRoles } from './services/rbac.js';
import { purgeExpiredSessions } from './middleware/auth.js';

await loadRoles();
const app = createApp();
const server = app.listen(config.port, () => console.log(`Scale Point Group platform listening on port ${config.port} (${config.env})`));
server.keepAliveTimeout = 65000; // longer than Render's load balancer idle timeout
server.requestTimeout = 10 * 60 * 1000; // large registers and reports

const housekeeping = setInterval(() => purgeExpiredSessions().catch((e) => console.error('housekeeping:', e.message)), 60 * 60 * 1000);
housekeeping.unref();

function shutdown(signal) {
  console.log(`${signal} received, closing`);
  server.close(() => pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 15000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
