// ── Top‑level crash handlers ─────────────────────────────────────────────────
process.on('unhandledRejection', r => console.error('[UNHANDLED REJECTION]', r));
process.on('uncaughtException', err => console.error('[UNCAUGHT EXCEPTION]', err));

const express       = require('express');
const path          = require('path');
const fs            = require('fs');
const serveStatic   = require('serve-static');
const QRCode        = require('qrcode');
const sqlite3       = require('sqlite3');
const { open }      = require('sqlite');
const shopify       = require('@shopify/shopify-app-express');
const PrivacyHandlers = require('./privacy.js');       // adjust path
const filesUploadRouter = require('./routes/files-upload.js'); // adjust path
const os            = require('os');

const isVercel = !!process.env.VERCEL;
const DB_PATH  = isVercel
  ? path.join(os.tmpdir(), 'orders.sqlite')
  : path.join(process.cwd(), 'orders.sqlite');

const dbPromise = open({
  filename: DB_PATH,
  driver: sqlite3.Database
}).then(async db => {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      video_url TEXT NOT NULL
    );
  `);
  return db;
});

const HOST           = process.env.HOST;
const MEDIA_BASE_URL = process.env.MEDIA_BASE_URL;
const STATIC_PATH    = path.join(process.cwd(), 'web/frontend/dist');

const app = express();
app.use(express.json());
app.use((req, res, next) => { console.log(req.method, req.originalUrl, req.query); next(); });

// ── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// ── SHOPIFY SETUP ────────────────────────────────────────────────────────────
app.get(shopify.config.auth.path, shopify.auth.begin());
app.get(shopify.config.auth.callbackPath, shopify.auth.callback(), shopify.redirectToShopifyOrAppRoot());
app.post(shopify.config.webhooks.path, shopify.processWebhooks({ webhookHandlers: PrivacyHandlers }));

// ── PROTECT ROUTES ────────────────────────────────────────────────────────────
app.use('/api/*', shopify.validateAuthenticatedSession());

// ── FILE UPLOADS ──────────────────────────────────────────────────────────────
app.use(filesUploadRouter);

// ── SAVE / UPDATE VIDEO URL ───────────────────────────────────────────────────
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
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── FETCH SINGLE ORDER ────────────────────────────────────────────────────────
app.get('/api/orders/:orderId', async (req, res) => {
  try {
    const db = await dbPromise;
    const row = await db.get(
      'SELECT video_url FROM orders WHERE id = ?', 
      req.params.orderId
    );
    if (!row) return res.status(404).json({ error: 'Order not found' });
    res.json({ video_url: row.video_url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── LIST RECENT ORDERS ─────────────────────────────────────────────────────────
app.get('/api/orders', async (req, res) => {
  if (!req.query.shop) return res.status(400).json({ error: 'Missing shop' });
  try {
    const offlineId = shopify.api.session.getOfflineId(req.query.shop);
    const session   = await shopify.config.sessionStorage.loadSession(offlineId);
    if (!session) return res.status(403).json({ error: 'No session' });

    const client = new shopify.api.clients.Rest({ session });
    const { body } = await client.get({ path: 'orders', query: { status: 'any', limit: 10 }});

    const db = await dbPromise;
    const enriched = await Promise.all(
      body.orders.map(async o => {
        const row = await db.get(
          'SELECT video_url FROM orders WHERE id = ?', 
          o.id.toString()
        );
        return { ...o, video_url: row ? row.video_url : '' };
      })
    );
    res.json(enriched);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── DASHBOARD QR GENERATOR ────────────────────────────────────────────────────
app.get('/api/qr', async (req, res) => {
  if (!req.query.data) return res.status(400).send('Missing data');
  try {
    const qrDataUrl = await QRCode.toDataURL(req.query.data);
    res.json({ qrDataUrl });
  } catch (err) {
    console.error(err);
    res.status(500).send('QR Generation Error');
  }
});

// ── WEBHOOK: NEW ORDER ─────────────────────────────────────────────────────────
app.post('/webhook/orders/create', async (req, res) => {
  try {
    const order   = req.body;
    const orderId = String(order.id);
    const phone   = (order.customer?.phone || '').replace(/\D/g,'').slice(-10);
    const total   = parseFloat(order.total_price);
    const file    = total < 50 ? 'small.mp4' : total < 200 ? 'medium.mp4' : 'large.mp4';
    const videoUrl= `${MEDIA_BASE_URL}/${file}`;

    const db = await dbPromise;
    await db.run(
      `INSERT INTO orders (id, video_url)
         VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET video_url=excluded.video_url;`,
      [orderId, videoUrl]
    );

    const link      = `${HOST}/qr/${orderId}-${phone||'unknown'}`;
    const qrDataUrl = await QRCode.toDataURL(link);
    res.json({ qrDataUrl });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error generating QR');
  }
});

// ── QR REDIRECT ────────────────────────────────────────────────────────────────
app.get('/qr/:orderMobile', async (req, res) => {
  try {
    const [orderId] = req.params.orderMobile.split('-');
    const db = await dbPromise;
    const row = await db.get('SELECT video_url FROM orders WHERE id = ?', orderId);
    if (!row) return res.status(404).send('Order not found');
    const target = `${HOST}/video-player.html?video=${encodeURIComponent(row.video_url)}`;
    return res.redirect(302, target);
  } catch (err) {
    console.error(err);
    res.status(500).send('Redirect Error');
  }
});

// ── CLIENT ASSETS & SPA FALLBACK ──────────────────────────────────────────────
app.use(serveStatic(STATIC_PATH, { index: false }));
app.use('/*', shopify.ensureInstalledOnShop(), (_req, res) => {
  const html = fs.readFileSync(
    path.join(STATIC_PATH, 'index.html'), 'utf8'
  );
  res
    .status(200)
    .type('text/html')
    .send(html.replace('%VITE_SHOPIFY_API_KEY%', process.env.SHOPIFY_API_KEY));
});

// ── Export without app.listen() ───────────────────────────────────────────────
module.exports = app;
