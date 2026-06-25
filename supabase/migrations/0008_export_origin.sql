-- 0008: distinguish Net-New exports from Discovered exports, and let Net-New
-- leads "clear" once exported.
--   • exports.origin  — 'discovered' (default) | 'net_new'. Existing rows default
--     to 'discovered' (retroactive tagging — they all came from Discovered/Imported).
--   • lead_pool.exported_at — set when a Net-New lead is exported, so it drops out
--     of the Net-New tab and moves into Export History.

alter table exports add column if not exists origin text not null default 'discovered';
alter table lead_pool add column if not exists exported_at timestamptz;
