import { existsSync } from "fs";
import { cwd } from "process";
console.log("SHOPIFY.JS STARTED");
console.log("Current working directory (shopify.js):", cwd());
console.log("Does TOML exist at ./web/shopify.web.toml?", existsSync("./web/shopify.web.toml"));
console.log("Does TOML exist at ./shopify.web.toml?", existsSync("./shopify.web.toml"));

import 'dotenv/config';
console.log("SHOPIFY_API_KEY (shopify.js):", process.env.SHOPIFY_API_KEY);
console.log("SHOPIFY_API_SECRET_KEY (shopify.js):", process.env.SHOPIFY_API_SECRET_KEY);

import { BillingInterval, LATEST_API_VERSION } from "@shopify/shopify-api";
import { shopifyApp } from "@shopify/shopify-app-express";
import { SQLiteSessionStorage } from "@shopify/shopify-app-session-storage-sqlite";
import { restResources } from "@shopify/shopify-api/rest/admin/2024-10";

const DB_PATH = `${process.cwd()}/database.sqlite`;

// The transactions with Shopify will always be marked as test transactions, unless NODE_ENV is production.
// See the ensureBilling helper to learn more about billing in this template.
const billingConfig = {
  "My Shopify One-Time Charge": {
    // This is an example configuration that would do a one-time charge for $5 (only USD is currently supported)
    amount: 5.0,
    currencyCode: "USD",
    interval: BillingInterval.OneTime,
  },
};

const shopify = shopifyApp({
  api: {
    apiVersion: LATEST_API_VERSION,
    restResources,
    future: {
      customerAddressDefaultFix: true,
      lineItemBilling: true,
      unstable_managedPricingSupport: true,
    },
    billing: undefined, // or replace with billingConfig above to enable example billing
  },
  auth: {
    path: "/api/auth",
    callbackPath: "/api/auth/callback",
  },
  webhooks: {
    path: "/api/webhooks",
  },
  // This should be replaced with your preferred storage strategy
  sessionStorage: new SQLiteSessionStorage(DB_PATH),
});

export default shopify;
console.log("Shopify keys:", Object.keys(shopify));
