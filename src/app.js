import express from 'express';
import { pool, withTenant } from './db.js';

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  /**
   * Resolve the tenant for the request.
   *
   * Placeholder for real authentication: today it trusts a header so the
   * skeleton is exercisable. Whatever replaces it must set req.tenantId and
   * nothing downstream should change.
   */
  app.use('/api', (req, res, next) => {
    const tenantId = req.get('x-tenant-id');
    if (!tenantId) return res.status(401).json({ error: 'tenant context required' });
    req.tenantId = tenantId;
    next();
  });

  app.get('/api/sites', async (req, res, next) => {
    try {
      const rows = await withTenant(req.tenantId, async (client) => {
        // Scoped in the query AND by RLS. Belt and braces, on purpose:
        // this WHERE clause is the control the database does not depend on.
        const { rows } = await client.query(
          'SELECT id, tenant_id, name, created_at FROM parking_sites WHERE tenant_id = $1 ORDER BY created_at',
          [req.tenantId],
        );
        return rows;
      });
      res.json({ sites: rows });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/sites', async (req, res, next) => {
    const { name } = req.body ?? {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    try {
      const site = await withTenant(req.tenantId, async (client) => {
        const { rows } = await client.query(
          'INSERT INTO parking_sites (tenant_id, name) VALUES ($1, $2) RETURNING id, tenant_id, name, created_at',
          [req.tenantId, name],
        );
        return rows[0];
      });
      res.status(201).json({ site });
    } catch (err) {
      next(err);
    }
  });

  app.use((err, _req, res, _next) => {
    console.error('[api]', err);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}

export { pool };
