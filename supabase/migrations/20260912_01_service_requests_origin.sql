-- Adds just enough to let the customer-portal home screen distinguish a
-- customer-submitted request from a technician-flagged issue (states D2/D3
-- in the home-screen redesign), without depending on the separate
-- service-report "issue flag" field change (still pending, tracked
-- elsewhere). Until that field exists, admin can set origin manually when
-- creating a follow-up request off a completed visit; once the report-form
-- change ships, it can set this automatically instead.
--
-- Nothing here changes existing behavior: origin defaults to 'customer' so
-- every request created through the existing customer-facing form (srCreate)
-- keeps working exactly as before with no code change required there.

alter table public.service_requests
  add column if not exists origin text not null default 'customer'
    check (origin in ('customer','technician_flag'));

alter table public.service_requests
  add column if not exists flagged_issue_summary text;

comment on column public.service_requests.origin is
  'customer = submitted via the customer portal request form. technician_flag = created off an issue a technician noted on a completed visit (home-screen "needs attention" D2/D3 states) — see flagged_issue_summary for what the issue was.';
