import { existsSync } from "fs";
import { cwd } from "process";
console.log("DEBUGTEST.JS STARTED");
console.log("Current working directory:", cwd());
console.log("Does TOML exist at ./web/shopify.web.toml?", existsSync("./web/shopify.web.toml"));
console.log("Does TOML exist at ./shopify.web.toml?", existsSync("./shopify.web.toml"));