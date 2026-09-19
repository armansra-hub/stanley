-- Free RSS endpoints selected from current TAM concentration: CA 2,266; TX 1,462.
-- Feed + linked HTML retrieval verified 2026-09-19 UTC. This adds announcement
-- coverage, not a statewide procurement ledger or a claim of exhaustive history.
begin;

alter table public.intelligence_shared_sources
  add column if not exists coverage_description text;
comment on column public.intelligence_shared_sources.coverage_description is
  'Human-readable source scope and omissions. A successful feed poll is not complete market coverage.';

update public.intelligence_shared_sources set coverage_description = case id
  when 'wa_commerce' then 'Washington Department of Commerce announcements, including business investment, grants and economic development. Limited to agency-published news; not a statewide contract-award database.'
  when 'gsa_news' then 'GSA headquarters news releases, including agency procurement and workplace announcements. Does not enumerate all federal awards; USAspending and SAM have separate coverage.'
  when 'pr_newswire' then 'Recent company-authored announcements distributed through PR Newswire. Limited to the publisher RSS window and participating issuers; releases are company claims, not independent verification.'
  else coverage_description end
where id in ('wa_commerce','gsa_news','pr_newswire');

insert into public.intelligence_shared_sources
  (id,name,url,enabled,format,scope,states,verification_url,verified_at,poll_minutes,coverage_description)
values
  ('ca_gobiz','California GO-Biz business announcements','https://business.ca.gov/feed/',true,'rss','state_local','{CA}',
   'https://business.ca.gov/','2026-09-19T01:45:00Z',60,
   'California GO-Biz announcements on business investment, expansion, incentives, workforce and film/media projects. Agency-selected announcements only; not all state/local contracts or all incentive recipients.'),
  ('ca_governor','California Governor announcements','https://www.gov.ca.gov/feed/',true,'rss','state_local','{CA}',
   'https://www.gov.ca.gov/','2026-09-19T01:45:00Z',15,
   'California Governor office announcements, including named-company investments and public projects. The feed also contains policy and appointment news; only matched account evidence enters company research. Not a procurement ledger.'),
  ('tx_governor','Texas Governor announcements','https://gov.texas.gov/news/rss',true,'rss','state_local','{TX}',
   'https://gov.texas.gov/news/P4864','2026-09-19T01:45:00Z',15,
   'Texas Governor office announcements, including enterprise investment, expansion and economic-development projects. Agency-selected news also contains policy and appointments; not all Texas procurement or contract awards.'),
  ('tx_comptroller','Texas Comptroller news releases','https://public.govdelivery.com/topics/TXCOMPT_1/feed.rss',true,'rss','state_local','{TX}',
   'https://comptroller.texas.gov/about/media-center/rss/','2026-09-19T01:45:00Z',60,
   'Official Texas Comptroller English-language releases distributed through GovDelivery, covering business, fiscal and agency developments. This is a news feed, not the Electronic State Business Daily solicitation or award database.'),
  ('freightwaves','FreightWaves logistics reporting','https://www.freightwaves.com/feed',true,'rss','industry','{}',
   'https://www.freightwaves.com/','2026-09-19T01:45:00Z',15,
   'FreightWaves published reporting about carriers, freight, logistics, facilities and supply-chain businesses. Publisher reporting is labeled as its source; coverage is limited to public articles in the feed, not every logistics company or event.'),
  ('pr_newswire_general_business','PR Newswire business and services announcements',
   'https://www.prnewswire.com/rss/general-business-latest-news/general-business-latest-news-list.rss',true,'rss','industry','{}',
   'https://www.prnewswire.com/rss/','2026-09-19T01:45:00Z',15,
   'Company-authored general-business releases, including expansion, leadership, outsourcing, workforce and business services. Category feed extends the rolling all-news window; overlapping articles share canonical observation identity. Issuer claims are not independent verification.'),
  ('pr_newswire_media','PR Newswire media and agency announcements',
   'https://www.prnewswire.com/rss/entertainment-media-latest-news/entertainment-media-latest-news-list.rss',true,'rss','industry','{}',
   'https://www.prnewswire.com/rss/','2026-09-19T01:45:00Z',15,
   'Company-authored entertainment, media, publishing and advertising announcements relevant to agency and media accounts. Category feed extends the rolling all-news window; limited to participating issuers and their published claims.')
on conflict (id) do update set
  name=excluded.name,url=excluded.url,format=excluded.format,scope=excluded.scope,
  states=excluded.states,verification_url=excluded.verification_url,
  verified_at=excluded.verified_at,poll_minutes=excluded.poll_minutes,
  coverage_description=excluded.coverage_description;
-- Preserve existing enabled/disabled choices when this migration is reapplied.

notify pgrst,'reload schema';
commit;
