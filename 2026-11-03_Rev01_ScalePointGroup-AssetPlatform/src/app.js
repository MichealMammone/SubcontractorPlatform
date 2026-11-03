// Express application: security headers, static front end, API routes and error handling.
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { query } from './db.js';
import { HttpError } from './lib/http.js';
import { loadSession, requireAuth, csrf } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import registerRoutes from './routes/registers.js';
import assetRoutes from './routes/assets.js';
import inspectionRoutes from './routes/inspections.js';
import reportRoutes from './routes/reports.js';
import adminRoutes from './routes/admin.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const nm = (p) => path.join(root, 'node_modules', p);

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Render terminates TLS in front of the app

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:'],
        'font-src': ["'self'", 'data:'],
        'connect-src': ["'self'"],
        'worker-src': ["'self'", 'blob:'],
        'object-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'form-action': ["'self'"],
        'upgrade-insecure-requests': config.isProd ? [] : null
      }
    },
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: config.isProd ? { maxAge: 31536000, includeSubDomains: true } : false
  }));
  app.use(compression());

  app.get('/healthz', async (req, res) => {
    try { await query('SELECT 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
  });

  // Front end and browser libraries (served locally: no CDN dependency, works on locked-down networks).
  const longCache = { maxAge: '7d', immutable: false };
  app.use('/vendor/pdfjs', express.static(nm('pdfjs-dist/build'), longCache));
  app.use('/vendor/xlsx', express.static(nm('xlsx/dist'), longCache));
  app.use('/vendor/chart', express.static(nm('chart.js/dist'), longCache));
  app.use('/shared', express.static(path.join(root, 'shared'), { maxAge: '1h' }));
  app.use(express.static(path.join(root, 'public'), { maxAge: '1h', index: 'index.html' }));

  // API
  const api = express.Router();
  api.use(express.json({ limit: '25mb' }));
  api.use(loadSession);
  api.use(csrf);
  api.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  api.use('/auth', authRoutes);
  api.use(requireAuth);
  api.use('/users', userRoutes);
  api.use('/registers', registerRoutes);
  api.use('/assets', assetRoutes);
  api.use('/inspections', inspectionRoutes);
  api.use('/reports', reportRoutes);
  api.use('/', adminRoutes);
  api.use((req, res, next) => next(new HttpError(404, 'Not found.')));
  app.use('/api', api);

  // Errors: JSON for the API, never leaking internals in production.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = err.status || err.statusCode || 500;
    let message = err.message;
    if (err.type === 'entity.too.large' || err.code === 'LIMIT_FILE_SIZE') { status = 413; message = 'That file or request is too large.'; }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') { status = 400; message = 'Unexpected file field.'; }
    if (status >= 500) {
      console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}:`, err.stack || err);
      if (config.isProd) message = 'Something went wrong on the server. The error has been logged.';
    }
    res.status(status).json({ error: message, ...(err.details ? { details: err.details } : {}) });
  });
  return app;
}
