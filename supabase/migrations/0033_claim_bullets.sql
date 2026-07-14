-- 0033: curated claiming bullets for the Target Account List.
-- When set, exports use these VERBATIM as the "Claiming Comments" cell (1-4 terse
-- bullets, one reason each) instead of deriving bullets from the digest — written
-- by the TAL deep-pass so the AE's claimed ~250-300 carry hand-tightened, specific
-- reasons ("ZoomInfo intent: Billing/Invoicing 6/2026", not "ERP signal").
alter table companies add column if not exists claim_bullets text[];
