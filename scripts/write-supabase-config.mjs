import { writeFileSync } from "node:fs";

const config = {
  url: process.env.SUPABASE_URL || "",
  publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY || "",
};

writeFileSync(
  "outputs/supabase-config.js",
  `window.DALFI_SUPABASE_CONFIG = ${JSON.stringify(config, null, 2)};\n`,
);
