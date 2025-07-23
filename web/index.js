// Top‑level error handlers so import‐time errors show up in Vercel logs:
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
});

import express from 'express';
import { join } from 'path';
import { readFileSync } from 'fs';
import serveStatic from 'serve-static';
import QRCode from 'qrcode';
import shopify from './shopify.js';
import PrivacyWebhookHandlers from './privacy.js';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import filesUploadRouter from './routes/files-upload.js';
import { tmpdir } from 'os';

// Use a writable folder on Vercel; otherwise local project dir
const isVercel = process.env.VERCEL === '1';
const DB_PATH = isVercel
  ? join(tmpdir(), 'orders.sqlite')
  : join(process.cwd(), 'orders.sqlite');

// Initialize SQLite and ensure orders table
const dbPromise = open({
  filename: DB_PATH,
  driver: sqlite3.Database,
}).then(async (db) => {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      video_url TEXT NOT NULL
    );
  `);
  return db;
});

// required env vars
const { HOST, MEDIA_BASE_URL, SHOPIFY_API_KEY } = process.env;
if (!HOST) throw new Error('Missing HOST env var');
if (!MEDIA_BASE_URL) throw new Error('Missing MEDIA_BASE_URL env var');
if (!SHOPIFY_API_KEY) throw new Error('Missing SHOPIFY_API_KEY env var');

const STATIC_PATH = join(process.cwd(), 'web/frontend/dist');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  console.log(`${req.method} ${req.originalUrl}`, req.query);
  next();
});

// 1) Health‑check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// 2) Shopify auth & webhook registration
app.get(shopify.config.auth.path, shopify.auth.begin());
app.get(
  shopify.config.auth.callbackPath,
  shopify.auth.callback(),
  shopify.redirectToShopifyOrAppRoot()
);
app.post(
  shopify.config.webhooks.path,
  shopify.processWebhooks({ webhookHandlers: PrivacyWebhookHandlers })
);

// 3) Protect all /api routes
app.use('/api/*', shopify.validateAuthenticatedSession());

// 4) File uploads
app.use(filesUploadRouter);

// 5) Manual save/update video URL
app.post('/api/orders/:orderId/video', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { videoUrl } = req.body;
    if (!videoUrl) return res.status(400).json({ error: 'Missing videoUrl' });

    const db = await dbPromise;
    await db.run(
      `INSERT INTO orders (id, video_url)
       VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET video_url=excluded.video_url;`,
      [orderId, videoUrl]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[Save Video] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 6) Fetch single order’s video
app.get('/api/orders/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const db = await dbPromise;
    const row = await db.get('SELECT video_url FROM orders WHERE id = ?', orderId);
    if (!row) return res.status(404).json({ error: 'Order not found' });
    res.json({ video_url: row.video_url });
  } catch (err) {
    console.error('[Get Order] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 7) Fetch recent orders + enriched video URLs
app.get('/api/orders', async (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).json({ error: 'Missing shop' });

  try {
    const offlineId = shopify.api.session.getOfflineId(shop);
    const session = await shopify.config.sessionStorage.loadSession(offlineId);
    if (!session) return res.status(403).json({ error: 'No session' });

    const client = new shopify.api.clients.Rest({ session });
    const { body } = await client.get({
      path: 'orders',
      query: { status: 'any', limit: 10 },
    });

    const db = await dbPromise;
    const enriched = await Promise.all(
      body.orders.map(async (o) => {
        const row = await db.get(
          'SELECT video_url FROM orders WHERE id = ?',
          o.id.toString()
        );
        return { ...o, video_url: row?.video_url || '' };
      })
    );
    res.json(enriched);
  } catch (err) {
    console.error('[Orders API] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 8) QR generation for dashboard
app.get('/api/qr', async (req, res) => {
  try {
    const data = req.query.data as string;
    if (!data) return res.status(400).send('Missing data');
    const qrDataUrl = await QRCode.toDataURL(data);
    res.json({ qrDataUrl });
  } catch (err) {
    console.error('[QR API] Error:', err);
    res.status(500).send('QR Generation Error');
  }
});

// 9) Webhook handler for ORDERS_CREATE
app.post('/webhook/orders/create', async (req, res) => {
  try {
    const order = req.body as any;
    const orderId = order.id.toString();
    const phone = (order.customer?.phone || '').replace(/[^\d]/g, '').slice(-10);
    const total = parseFloat(order.total_price);
    const file =
      total < 50 ? 'small.mp4' : total < 200 ? 'medium.mp4' : 'large.mp4';
    const videoUrl = `${MEDIA_BASE_URL}/${file}`;

    const db = await dbPromise;
    await db.run(
      `INSERT INTO orders (id, video_url)
       VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET video_url=excluded.video_url;`,
      [orderId, videoUrl]
    );

    const link = `${HOST}/qr/${orderId}-${phone || 'unknown'}`;
    const qrDataUrl = await QRCode.toDataURL(link);
    res.json({ qrDataUrl });
  } catch (err) {
    console.error('[Webhook QR] Error:', err);
    res.status(500).send('Error generating QR');
  }
});

// 10) QR → redirect to your video player
app.get('/qr/:orderMobile', async (req, res) => {
  try {
    const [orderId] = req.params.orderMobile.split('-');
    const db = await dbPromise;
    const row = await db.get(
      'SELECT video_url FROM orders WHERE id = ?',
      orderId
    );
    if (!row) return res.status(404).send('Order not found');

    const target = `${HOST}/video-player.html?video=${encodeURIComponent(
      row.video_url
    )}`;
    res.redirect(302, target);
  } catch (err) {
    console.error('[QR Redirect] Error:', err);
    res.status(500).send('Redirect Error');
  }
});

// 11) Static asset server
app.use(serveStatic(STATIC_PATH, { index: false }));

// 12) SPA fallback for embedded app
app.use('/*', shopify.ensureInstalledOnShop(), (_req, res) => {
  const html = readFileSync(join(STATIC_PATH, 'index.html'), 'utf8');
  res
    .status(200)
    .set('Content-Type', 'text/html')
    .send(html.replace('%VITE_SHOPIFY_API_KEY%', SHOPIFY_API_KEY));
});

// Export the Express app for Vercel (no app.listen())
export default app;