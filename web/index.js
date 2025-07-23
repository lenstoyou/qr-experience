// web/index.js

// ——————————————————————————————————————————————————————————————————————————————————————
// Top‑level crash logging
process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED REJECTION]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]", err);
});

// ——————————————————————————————————————————————————————————————————————————————————————
// Imports
import express from "express";
import { join } from "path";
import { readFileSync } from "fs";
import serveStatic from "serve-static";
import QRCode from "qrcode";
import shopify from "./shopify.js";
import PrivacyWebhookHandlers from "./privacy.js";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import filesUploadRouter from "./routes/files-upload.js";
import { tmpdir } from "os";

// ——————————————————————————————————————————————————————————————————————————————————————
// Database (writable on Vercel in /tmp, local otherwise)
const isVercel = Boolean(process.env.VERCEL);
const DB_PATH = isVercel
  ? join(tmpdir(), "orders.sqlite")
  : join(process.cwd(), "orders.sqlite");

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

// ——————————————————————————————————————————————————————————————————————————————————————
// Env & paths
const HOST = process.env.HOST!;               // e.g. https://qr-experience.vercel.app
const MEDIA_BASE_URL = process.env.MEDIA_BASE_URL!;
const STATIC_PATH = join(process.cwd(), "web/frontend/dist");

// ——————————————————————————————————————————————————————————————————————————————————————
// Express app
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  console.log(`${req.method} ${req.originalUrl}`, req.query);
  next();
});

// Health‑check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// — Shopify OAuth & Webhooks —
// 1. Begin OAuth
app.get(shopify.config.auth.path, shopify.auth.begin());
// 2. OAuth callback
app.get(
  shopify.config.auth.callbackPath,
  shopify.auth.callback(),
  shopify.redirectToShopifyOrAppRoot()
);
// 3. Inbound webhooks
app.post(
  shopify.config.webhooks.path,
  shopify.processWebhooks({ webhookHandlers: PrivacyWebhookHandlers })
);

// Protect all /api/* routes
app.use("/api/*", shopify.validateAuthenticatedSession());

// File‑upload endpoints
app.use(filesUploadRouter);

// — Manual video‑URL save/update —
app.post("/api/orders/:orderId/video", async (req, res) => {
  try {
    const { orderId } = req.params;
    const { videoUrl } = req.body;
    if (!videoUrl) throw new Error("Missing videoUrl");

    const db = await dbPromise;
    await db.run(
      `INSERT INTO orders (id, video_url)
       VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET video_url=excluded.video_url;`,
      [orderId, videoUrl]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("[Save Video] Error:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// — Fetch single order URL —
app.get("/api/orders/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;
    const db = await dbPromise;
    const row = await db.get("SELECT video_url FROM orders WHERE id = ?", orderId);
    if (!row) return res.status(404).json({ error: "Order not found" });
    res.json({ video_url: row.video_url });
  } catch (err) {
    console.error("[Get Order] Error:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// — Fetch recent orders + saved URLs via Admin API —
app.get("/api/orders", async (req, res) => {
  const shop = req.query.shop as string;
  if (!shop) return res.status(400).json({ error: "Missing shop" });

  try {
    const offlineId = shopify.api.session.getOfflineId(shop);
    const session = await shopify.config.sessionStorage.loadSession(offlineId);
    if (!session) return res.status(403).json({ error: "No session" });

    const client = new shopify.api.clients.Rest({ session });
    const { body } = await client.get({
      path: "orders",
      query: { status: "any", limit: 10 },
    });

    const db = await dbPromise;
    const enriched = await Promise.all(
      body.orders.map(async (o) => {
        const row = await db.get(
          "SELECT video_url FROM orders WHERE id = ?",
          o.id.toString()
        );
        return { ...o, video_url: row?.video_url || "" };
      })
    );
    res.json(enriched);
  } catch (err) {
    console.error("[Orders API] Error:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// — Dashboard QR generator —
app.get("/api/qr", async (req, res) => {
  try {
    const data = req.query.data as string;
    if (!data) return res.status(400).send("Missing data");
    const qrDataUrl = await QRCode.toDataURL(data);
    res.json({ qrDataUrl });
  } catch (err) {
    console.error("[QR API] Error:", err);
    res.status(500).send("QR Generation Error");
  }
});

// — Webhook: ORDERS_CREATE → save & return QR —
app.post("/webhook/orders/create", async (req, res) => {
  try {
    const order = req.body as any;
    const orderId = order.id.toString();
    const phone = (order.customer?.phone || "")
      .replace(/[^\d]/g, "")
      .slice(-10);
    const total = parseFloat(order.total_price);
    const file =
      total < 50 ? "small.mp4" : total < 200 ? "medium.mp4" : "large.mp4";
    const videoUrl = `${MEDIA_BASE_URL}/${file}`;

    const db = await dbPromise;
    await db.run(
      `INSERT INTO orders (id, video_url)
       VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET video_url=excluded.video_url;`,
      [orderId, videoUrl]
    );

    const link = `${HOST}/qr/${orderId}-${phone || "unknown"}`;
    const qrDataUrl = await QRCode.toDataURL(link);
    res.json({ qrDataUrl });
  } catch (err) {
    console.error("[Webhook QR] Error:", err);
    res.status(500).send("Error generating QR");
  }
});

// — QR redirect to video player —
app.get("/qr/:orderMobile", async (req, res) => {
  try {
    const [orderId] = (req.params.orderMobile as string).split("-");
    const db = await dbPromise;
    const row = await db.get(
      "SELECT video_url FROM orders WHERE id = ?",
      orderId
    );
    if (!row) return res.status(404).send("Order not found");
    const target = `${HOST}/video-player.html?video=${encodeURIComponent(
      row.video_url
    )}`;
    res.redirect(302, target);
  } catch (err) {
    console.error("[QR Redirect] Error:", err);
    res.status(500).send("Redirect Error");
  }
});

// — Serve your Vite build —
app.use(serveStatic(STATIC_PATH, { index: false }));

// — SPA fallback for embedded app routes —
app.use("/*", shopify.ensureInstalledOnShop(), (_req, res) => {
  const html = readFileSync(join(STATIC_PATH, "index.html"), "utf8");
  res
    .status(200)
    .set("Content-Type", "text/html")
    .send(html.replace("%VITE_SHOPIFY_API_KEY%", process.env.SHOPIFY_API_KEY!));
});

// ——————————————————————————————————————————————————————————————————————————————————————
// Export only the app (no app.listen()), so Vercel can mount it as a Serverless Function
export default app;