// Verify the migration applied. Run: node --env-file=.env.local scripts/verify-db.mjs
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const db = createClient(url, key, { auth: { persistSession: false } });

const checks = {};
const tc = await db.from("territory_config").select("states, subindustries").single();
checks.territory_config = tc.error
  ? `ERROR: ${tc.error.message}`
  : { states: tc.data.states.length, subindustries: tc.data.subindustries.length };

const sw = await db.from("scoring_weights").select("*", { count: "exact", head: true });
checks.scoring_weights_rows = sw.error ? `ERROR: ${sw.error.message}` : sw.count;

const ac = await db.from("app_config").select("model_bulk, model_chat, chunk_size, ns_sales_rep").single();
checks.app_config = ac.error ? `ERROR: ${ac.error.message}` : ac.data;

const co = await db.from("companies").select("*", { count: "exact", head: true });
checks.companies_rows = co.error ? `ERROR: ${co.error.message}` : co.count;

const sg = await db.from("signals").select("*", { count: "exact", head: true });
checks.signals_rows = sg.error ? `ERROR: ${sg.error.message}` : sg.count;

console.log(JSON.stringify(checks, null, 2));
