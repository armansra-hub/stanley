-- 0029: parent-company detection. If a lead is a subsidiary (owned by a bigger
-- parent), it's usually not a standalone NetSuite buyer (the parent owns the ERP
-- decision). We detect it from the company's own site ("subsidiary of X", "a division
-- of X", "acquired by X") + M&A-target news, flag it, and — for HIGH-confidence
-- detections only — auto-dismiss it (toggle: app_config.parent_autodismiss).
alter table companies add column if not exists has_parent boolean not null default false;
alter table companies add column if not exists parent_name text;
alter table companies add column if not exists parent_confidence text; -- 'high' | 'low'
alter table app_config add column if not exists parent_autodismiss boolean not null default true;
