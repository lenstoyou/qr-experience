// web/routes/files-upload.js

import express from "express";
import multer from "multer";
import shopify from "../shopify.js";

// In‑memory storage with a 50 MB limit
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50 MB max
});

const router = express.Router();

// POST /api/files/upload?shop=…  
// Expects a multipart form with field “file”
router.post(
  "/api/files/upload",
  shopify.validateAuthenticatedSession(),
  upload.single("file"),
  async (req, res) => {
    try {
      // Log incoming file details
      console.log(
        "[Files Upload] incoming:",
        "name=", req.file.originalname,
        "size=", req.file.size,
        "type=", req.file.mimetype
      );

      // Use Shopify REST client to create a new File
      const session = res.locals.shopify.session;
      const client = new shopify.api.clients.Rest({ session });

      const response = await client.post({
        path: "files",
        data: {
          file: {
            attachment: req.file.buffer.toString("base64"),
            filename:   req.file.originalname,
            content_type: req.file.mimetype
          }
        }
      });

      const publicUrl = response.body.file.public_url;
      console.log("[Files Upload] created:", publicUrl);
      res.json({ public_url: publicUrl });

    } catch (err) {
      // If Shopify returns a JSON error body, log it; otherwise log the message
      const shopifyError = err.response?.body || err.message;
      console.error("[Files Upload] failed:", shopifyError);
      res.status(500).json({ error: shopifyError });
    }
  }
);

export default router;
