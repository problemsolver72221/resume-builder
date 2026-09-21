import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { getGeneratedFilePath } from './utils/generatedPath';
import { installProcessGuards } from './processGuards';
import { listenOnFreePort } from './utils/listenOnFreePort';

import profileRoutes from './routes/profiles';
import templateRoutes from './routes/templates';
import resumeRoutes from './routes/resume';
import adminRoutes from './routes/admin';
import groupRoutes from './routes/groups';
import importRoutes from './routes/import';
import promptRoutes from './routes/prompts';

dotenv.config({ path: path.join(__dirname, '../../.env'), override: true });
installProcessGuards();

const app = express();
// The first port to try, not the port that will be used: another copy of this project may
// already hold it, and listenOnFreePort walks upwards until one binds.
const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || '0.0.0.0';
const configuredFrontendOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedOrigins = new Set<string>(configuredFrontendOrigins);

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Any port on this machine. The frontend's port is decided when it starts — a second copy
 * of the project runs on 3002, a third on 3004 — so an allowlist of fixed ports would
 * block every copy but the first.
 */
function isLoopbackOrigin(origin: string): boolean {
  try {
    const { protocol, hostname } = new URL(origin);
    return (protocol === 'http:' || protocol === 'https:') && LOOPBACK_HOSTNAMES.has(hostname);
  } catch {
    return false;
  }
}

// Middleware
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin) || isLoopbackOrigin(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
// No urlencoded parser on purpose. Nothing in this app posts a form — the client sends
// JSON and multer handles the multipart uploads — and parsing form bodies is what would
// let a plain <form> on any page the user happens to have open reach these routes: a
// form POST is a "simple" request, so it is sent without the preflight that the CORS
// check above relies on, and the routes themselves do not authenticate (see
// middleware/auth). Without a parser for that content type those bodies arrive empty.

// Explicit param type: @types/express infers "filename(*)" from the path string, but Express 4 exposes it as "filename".
app.get('/api/generated/:filename(*)', async (req: express.Request<{ filename: string }>, res: express.Response) => {
  try {
    const filename = typeof req.params.filename === 'string' ? req.params.filename : '';
    const filepath = await getGeneratedFilePath(filename);
    if (!filepath) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    res.download(filepath, path.basename(filepath));
  } catch {
    res.status(500).json({ error: 'Failed to download file' });
  }
});

// Routes
app.use('/api/profiles', profileRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/resume', resumeRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/import', importRoutes);
app.use('/api/prompts', promptRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

listenOnFreePort(app, { host: HOST, port: PORT })
  .then(({ port }) => {
    console.log(`Server running on http://${HOST}:${port}`);
    if (port !== PORT) {
      console.log(`(port ${PORT} was taken by another copy of this project)`);
    }
    // Read by scripts/dev.js, which cannot know the port in advance: it has to point the
    // frontend at whichever one this process ended up binding.
    console.log(`BACKEND_PORT=${port}`);
  })
  .catch((error: NodeJS.ErrnoException) => {
    console.error(`Could not bind a port at or above ${PORT}: ${error.message}`);
    process.exit(1);
  });

export default app;
