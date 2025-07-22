// web/routes/files-upload.js

import express from "express";
import multer from "multer";
import shopify from "../shopify.js";

const router = express.Router();

// In-memory storage for files (max 50MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
});

/**
 * POST /api/files/upload?shop=…
 * Accepts a multipart form with the field name “file”
 */
router.post(
  "/api/files/upload",
  shopify.validateAuthenticatedSession(),
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      // 1) Log file metadata
      console.log(
        "[Files Upload] incoming:",
        "name=", req.file.originalname,
        "size=", req.file.size,
        "type=", req.file.mimetype
      );

      // 2) Get Shopify session
      const session = res.locals.shopify.session;
      const client = new shopify.api.clients.Rest({ session });

      // 3) Upload file to Shopify
      const response = await client.post({
        path: "files",
        data: {
          file: {
            attachment: req.file.buffer.toString("base64"),
            filename: req.file.originalname,
            content_type: req.file.mimetype,
          },
        },
        type: "application/json",
      });

      // 4) Return public file URL
      const publicUrl = response.body.file?.public_url;
      console.log("[Files Upload] created:", publicUrl);
      return res.status(200).json({ public_url: publicUrl });
    } catch (err) {
      // 5) Error logging
      const shopifyError = err.response?.body || err.message || err;
      console.error("[Files Upload] failed:", shopifyError);
      return res.status(500).json({ error: shopifyError });
    }
  }
);

export default router;
