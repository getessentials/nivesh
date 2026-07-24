-- Seed: canonical index registry + themes (docs/03 §6).
-- nav_proxy indices and the themes benchmarked on them (gold, silver, ai_global_tech,
-- debt_liquid) are seeded in the ETF-universe migration — a nav_proxy row requires its
-- proxy ETF to exist first (indices_proxy_chk).

-- Underlying (price) index rows — no TRI series expected ('none')
insert into indices (name, tri_source, notes) values
  ('NIFTY 50',                  'none', 'underlying only'),
  ('NIFTY NEXT 50',             'none', 'underlying only'),
  ('BSE SENSEX',                'none', 'underlying only'),
  ('NIFTY INDIA DEFENCE',       'none', 'underlying only'),
  ('NIFTY INDIA MANUFACTURING', 'none', 'underlying only'),
  ('NIFTY INFRASTRUCTURE',      'none', 'underlying only'),
  ('BSE INDIA INFRASTRUCTURE',  'none', 'underlying only (Motilal BSE infra ETF)'),
  ('NIFTY CPSE',                'none', 'underlying only'),
  ('BSE BHARAT 22',             'none', 'underlying only'),
  ('NIFTY PSU BANK',            'none', 'underlying only'),
  ('NIFTY IT',                  'none', 'underlying only'),
  ('NIFTY INDIA CONSUMPTION',   'none', 'underlying only'),
  ('NIFTY METAL',               'none', 'underlying only'),
  ('NIFTY ENERGY',              'none', 'underlying only'),
  ('NASDAQ 100',                'none', 'underlying only (intl)'),
  ('DOMESTIC GOLD',             'none', 'underlying only (commodity)'),
  ('DOMESTIC SILVER',           'none', 'underlying only (commodity)'),
  ('NIFTY 1D RATE',             'none', 'underlying only (liquid/overnight)');

-- TRI benchmark rows — ingested from niftyindices (manual CSV path is first-class, docs/02 §3)
insert into indices (name, tri_source, notes) values
  ('NIFTY 50 TRI',                  'niftyindices', null),
  ('NIFTY INDIA DEFENCE TRI',       'niftyindices', null),
  ('NIFTY INDIA MANUFACTURING TRI', 'niftyindices', null),
  ('NIFTY INFRASTRUCTURE TRI',      'niftyindices', null),
  ('NIFTY CPSE TRI',                'niftyindices', 'canonical benchmark for psu_value theme'),
  ('NIFTY IT TRI',                  'niftyindices', null),
  ('NIFTY INDIA CONSUMPTION TRI',   'niftyindices', null),
  ('NIFTY METAL TRI',               'niftyindices', null),
  ('NIFTY ENERGY TRI',              'niftyindices', null);

-- Themes with niftyindices TRI benchmarks (docs/03 §6)
insert into themes (key, name, investable, proxy_note, benchmark_index) values
  ('broad_core',        'Broad market core',        true,  null, 'NIFTY 50 TRI'),
  ('defence',           'Defence',                  true,  null, 'NIFTY INDIA DEFENCE TRI'),
  ('manufacturing',     'Manufacturing',            true,  null, 'NIFTY INDIA MANUFACTURING TRI'),
  ('infrastructure',    'Infrastructure',           true,  null, 'NIFTY INFRASTRUCTURE TRI'),
  ('psu_value',         'PSU value',                true,  null, 'NIFTY CPSE TRI'),
  ('it_digital',        'IT & digital',             true,  null, 'NIFTY IT TRI'),
  ('consumption',       'India consumption',        true,  null, 'NIFTY INDIA CONSUMPTION TRI'),
  ('metals_commodities','Metals & commodities',     true,  null, 'NIFTY METAL TRI'),
  ('energy',            'Energy',                   true,  null, 'NIFTY ENERGY TRI');

-- Researched-but-not-investable themes (shown honestly in the UI, cannot rank)
insert into themes (key, name, investable, proxy_note, benchmark_index) values
  ('water',      'Water',       false,
   'No Indian ETF — closest exposure is infra/utilities proxies', null),
  ('rare_earth', 'Rare earth',  false,
   'No Indian ETF — metals/mining is a partial proxy; global thematic not cleanly accessible (re-verified Jul-2026)', null);
