// web/index.js

// --- DEBUG SECTION: VERY TOP ---
import { existsSync } from "fs";
import { cwd } from "process";
console.log("INDEX.JS STARTED");
console.log("CWD:", cwd());
console.log("shopify.web.toml?", existsSync("./web/shopify.web.toml"));
console.log("shopify.web.toml @ root?", existsSync("./shopify.web.toml"));
import "dotenv/config";
console.log("SHOPIFY_API_KEY:", process.env.SHOPIFY_API_KEY);
console.log("SHOPIFY_API_SECRET_KEY:", process.env.SHOPIFY_API_SECRET_KEY);
console.log("HOST:", process.env.HOST);
console.log("MEDIA_BASE_URL:", process.env.MEDIA_BASE_URL);
console.log("SCOPES:", process.env.SCOPES);
console.log("SHOP:", process.env.SHOP);
// --- END DEBUG SECTION ---

import { join } from "path";
import { readFileSync } from "fs";
import express from "express";
import serveStatic from "serve-static";
import QRCode from "qrcode";
import shopify from "./shopify.js";
import PrivacyWebhookHandlers from "./privacy.js";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import filesUploadRouter from "./routes/files-upload.js";

// Initialize SQLite and ensure orders table exists
const dbPromise = open({
  filename: "./orders.sqlite",
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

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST;
const MEDIA_BASE_URL = process.env.MEDIA_BASE_URL;
const STATIC_PATH = join(process.cwd(), "web/frontend/dist");

const app = express();
app.use(express.json());

// Log incoming requests
app.use((req, res, next) => {
  console.log("Incoming:", req.method, req.originalUrl, req.query);
  next();
});

// Shopify auth & webhooks
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

// Protect API routes
app.use("/api/*", shopify.validateAuthenticatedSession());

// Mount file‑upload endpoint
app.use(filesUploadRouter);

// Save video_url for an order
app.post(
  "/api/orders/:orderId/video",
  shopify.validateAuthenticatedSession(),
  async (req, res) => {
    console.log("[Save Video] hit", req.params.orderId, req.body);
    try {
      const { orderId } = req.params;
      const { videoUrl } = req.body;
      if (!videoUrl) {
        return res.status(400).json({ error: "Missing videoUrl" });
      }
      const db = await dbPromise;
      await db.run(
        `INSERT INTO orders (id, video_url) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET video_url=excluded.video_url;`,
        [orderId, videoUrl]
      );
      res.json({ success: true });
    } catch (err) {
      console.error("[Save Video] Error:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

// Orders list for dashboard
app.get("/api/orders", async (req, res) => {
  const shop = req.query.shop;
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
    res.status(500).json({ error: err.message });
  }
});

// Webhook: generate QR for new orders
app.post("/webhook/orders/create", async (req, res) => {
  try {
    const order = req.body;
    const orderId = order.id.toString();
    const phone =
      (order.customer?.phone || "unknown").replace(/[^\d]/g, "") || "unknown";
    const total = parseFloat(order.total_price);
    const file =
      total < 50 ? "small.mp4" : total < 200 ? "medium.mp4" : "large.mp4";

    const videoUrl = `${MEDIA_BASE_URL}/${file}`;
    const db = await dbPromise;
    await db.run(
      `INSERT INTO orders (id, video_url) VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET video_url=excluded.video_url;`,
      [orderId, videoUrl]
    );

    const link = `${HOST}/qr/${orderId}-${phone}`;
    const qrDataUrl = await QRCode.toDataURL(link);
    res.json({ qrDataUrl });
  } catch (err) {
    console.error("[Webhook QR] Error:", err);
    res.status(500).send("Error generating QR");
  }
});

// Redirect scanned QR to player
app.get("/qr/:orderMobile", async (req, res) => {
  const [orderId] = req.params.orderMobile.split("-");
  const db = await dbPromise;
  const row = await db.get("SELECT video_url FROM orders WHERE id = ?", orderId);
  if (!row) return res.status(404).send("Order not found");
  const target = `${HOST}/video-player.html?video=${encodeURIComponent(
    row.video_url
  )}`;
  res.redirect(302, target);
});

// Serve static build
app.use(serveStatic(STATIC_PATH, { index: false }));

// Catch‑all for the React app
app.use("/*", shopify.ensureInstalledOnShop(), (req, res) => {
  const host = req.query.host;
  if (!host) return res.status(400).send("No host provided");
  const html = readFileSync(join(STATIC_PATH, "index.html"), "utf8");
  res
    .status(200)
    .set("Content-Type", "text/html")
    .send(html.replace("%VITE_SHOPIFY_API_KEY%", process.env.SHOPIFY_API_KEY));
});

// Start on all interfaces so ngrok can connect
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});