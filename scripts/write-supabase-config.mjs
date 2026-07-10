import { writeFileSync } from "node:fs";

const config = {
  url: process.env.SUPABASE_URL || "https://lcqxbhlkqtjlwsedarej.supabase.co",
  publishableKey:
    process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_By4TvJ5mz1bLHZ9nXVat5Q_hHLRGezI",
};

writeFileSync(
  "outputs/supabase-config.js",
  `window.DALFI_SUPABASE_CONFIG = ${JSON.stringify(config, null, 2)};\n`,
);
