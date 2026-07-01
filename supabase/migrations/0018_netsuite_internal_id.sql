-- 0018: store the NetSuite INTERNAL ID on a company (from the NetSuite TAM export) so
-- the AE can jump straight to the record in NetSuite. Populated on the next NetSuite
-- re-import (weekly refresh). Only NetSuite-sourced rows carry it.
alter table companies add column if not exists netsuite_internal_id text;
