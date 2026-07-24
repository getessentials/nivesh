-- Seed: NSE trading holidays 2026 (docs/10 §1; re-seed annually — owner task).
-- Source: NSE holidays 2026 fetched 2026-07-23 from https://www.nseindia.com/api/holiday-master?type=trading (CM segment; cookie-primed request). 2026-11-08 ''Diwali Laxmi Pujan*'' carries NSE''s asterisk (Muhurat trading session typically announced separately). Some listed dates fall on weekends (2026-02-15 Sun, 2026-03-21 Sat, 2026-08-15 Sat, 2026-11-08 Sun) — NSE publishes them regardless; harmless for the Mon-Fri trading-day check. FLAG for owner Jan re-verification (docs/10 §1): 2026-01-15 "Municipal Corporation Election - Maharashtra" is an atypical entry (NSE/BSE closures are usually tied to state Assembly/Lok Sabha polls, not municipal-tier elections) — re-confirm against the live NSE holiday-master endpoint before go-live.
insert into nse_holidays (d, label) values
  ('2026-01-15', 'Municipal Corporation Election - Maharashtra'),
  ('2026-01-26', 'Republic Day'),
  ('2026-02-15', 'Mahashivratri'),
  ('2026-03-03', 'Holi'),
  ('2026-03-21', 'Id-Ul-Fitr (Ramadan Eid)'),
  ('2026-03-26', 'Shri Ram Navami'),
  ('2026-03-31', 'Shri Mahavir Jayanti'),
  ('2026-04-03', 'Good Friday'),
  ('2026-04-14', 'Dr. Baba Saheb Ambedkar Jayanti'),
  ('2026-05-01', 'Maharashtra Day'),
  ('2026-05-28', 'Bakri Id'),
  ('2026-06-26', 'Muharram'),
  ('2026-08-15', 'Independence Day'),
  ('2026-09-14', 'Ganesh Chaturthi'),
  ('2026-10-02', 'Mahatma Gandhi Jayanti'),
  ('2026-10-20', 'Dussehra'),
  ('2026-11-08', 'Diwali Laxmi Pujan*'),
  ('2026-11-10', 'Diwali-Balipratipada'),
  ('2026-11-24', 'Prakash Gurpurb Sri Guru Nanak Dev'),
  ('2026-12-25', 'Christmas');
