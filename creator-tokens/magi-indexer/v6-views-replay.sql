CREATE TABLE lumen_ct_registered_events (creator text, actor text, block numeric, face text, cap text, fee_paid text, indexer_contract_id text, indexer_block_height numeric, indexer_tx_hash text, indexer_ts timestamptz default now(), indexer_id serial primary key, indexer_log_hash text, indexer_output_hash text);
CREATE TABLE lumen_ct_face_changed_events (creator text, actor text, block numeric, old_face text, new_face text, indexer_contract_id text, indexer_block_height numeric, indexer_tx_hash text, indexer_ts timestamptz default now(), indexer_id serial primary key, indexer_log_hash text, indexer_output_hash text);
CREATE TABLE lumen_ct_cap_changed_events (creator text, actor text, block numeric, old_cap text, new_cap text, indexer_contract_id text, indexer_block_height numeric, indexer_tx_hash text, indexer_ts timestamptz default now(), indexer_id serial primary key, indexer_log_hash text, indexer_output_hash text);
CREATE TABLE lumen_ct_retired_events (creator text, actor text, block numeric, indexer_contract_id text, indexer_block_height numeric, indexer_tx_hash text, indexer_ts timestamptz default now(), indexer_id serial primary key, indexer_log_hash text, indexer_output_hash text);
CREATE TABLE lumen_ct_closed_events (creator text, actor text, block numeric, indexer_contract_id text, indexer_block_height numeric, indexer_tx_hash text, indexer_ts timestamptz default now(), indexer_id serial primary key, indexer_log_hash text, indexer_output_hash text);
CREATE TABLE lumen_ct_bought_events (creator text, actor text, block numeric, minted text, cost text, fee text, total_due text, indexer_contract_id text, indexer_block_height numeric, indexer_tx_hash text, indexer_ts timestamptz default now(), indexer_id serial primary key, indexer_log_hash text, indexer_output_hash text);
CREATE TABLE lumen_ct_sold_events (creator text, actor text, block numeric, sold text, gross text, tax text, fee text, net text, tax_bps numeric, held_blocks numeric, taxable_gross text, indexer_contract_id text, indexer_block_height numeric, indexer_tx_hash text, indexer_ts timestamptz default now(), indexer_id serial primary key, indexer_log_hash text, indexer_output_hash text);
CREATE TABLE lumen_ct_transferred_events (creator text, actor text, recipient text, block numeric, amount text, indexer_contract_id text, indexer_block_height numeric, indexer_tx_hash text, indexer_ts timestamptz default now(), indexer_id serial primary key, indexer_log_hash text, indexer_output_hash text);
CREATE TABLE lumen_ct_matured_moved_events (creator text, actor text, sender text, recipient text, block numeric, amount text, indexer_contract_id text, indexer_block_height numeric, indexer_tx_hash text, indexer_ts timestamptz default now(), indexer_id serial primary key, indexer_log_hash text, indexer_output_hash text);
CREATE TABLE lumen_ct_refunded_events (creator text, actor text, block numeric, credits text, payout text, indexer_contract_id text, indexer_block_height numeric, indexer_tx_hash text, indexer_ts timestamptz default now(), indexer_id serial primary key, indexer_log_hash text, indexer_output_hash text);
CREATE TABLE lumen_ct_refund_pushed_events (creator text, actor text, holder text, block numeric, credits_burned text, payout text, indexer_contract_id text, indexer_block_height numeric, indexer_tx_hash text, indexer_ts timestamptz default now(), indexer_id serial primary key, indexer_log_hash text, indexer_output_hash text);
CREATE TABLE lumen_ct_asked_events (creator text, actor text, block numeric, seq numeric, credits_spent text, commission_credits text, rate text, deadline_blocks numeric, content_hash text, offering_id numeric, indexer_contract_id text, indexer_block_height numeric, indexer_tx_hash text, indexer_ts timestamptz default now(), indexer_id serial primary key, indexer_log_hash text, indexer_output_hash text);
CREATE TABLE lumen_ct_answered_events (creator text, actor text, block numeric, seq numeric, credits_to_creator text, commission_credits text, commission_to text, answer_hash text, indexer_contract_id text, indexer_block_height numeric, indexer_tx_hash text, indexer_ts timestamptz default now(), indexer_id serial primary key, indexer_log_hash text, indexer_output_hash text);
CREATE TABLE lumen_ct_reclaimed_events (creator text, actor text, asker text, block numeric, seq numeric, credits text, commission_retained_credits text, retained_to text, indexer_contract_id text, indexer_block_height numeric, indexer_tx_hash text, indexer_ts timestamptz default now(), indexer_id serial primary key, indexer_log_hash text, indexer_output_hash text);
CREATE TABLE lumen_ct_declined_events (creator text, actor text, asker text, block numeric, seq numeric, credits text, indexer_contract_id text, indexer_block_height numeric, indexer_tx_hash text, indexer_ts timestamptz default now(), indexer_id serial primary key, indexer_log_hash text, indexer_output_hash text);
CREATE TABLE lumen_ct_rated_events (creator text, actor text, block numeric, seq numeric, score numeric, indexer_contract_id text, indexer_block_height numeric, indexer_tx_hash text, indexer_ts timestamptz default now(), indexer_id serial primary key, indexer_log_hash text, indexer_output_hash text);
CREATE TABLE lumen_ct_offering_created_events (creator text, actor text, block numeric, offering_id numeric, title text, price text, indexer_contract_id text, indexer_block_height numeric, indexer_tx_hash text, indexer_ts timestamptz default now(), indexer_id serial primary key, indexer_log_hash text, indexer_output_hash text);
CREATE TABLE lumen_ct_offering_updated_events (creator text, actor text, block numeric, offering_id numeric, title text, old_price text, new_price text, indexer_contract_id text, indexer_block_height numeric, indexer_tx_hash text, indexer_ts timestamptz default now(), indexer_id serial primary key, indexer_log_hash text, indexer_output_hash text);
CREATE TABLE lumen_ct_offering_deleted_events (creator text, actor text, block numeric, offering_id numeric, indexer_contract_id text, indexer_block_height numeric, indexer_tx_hash text, indexer_ts timestamptz default now(), indexer_id serial primary key, indexer_log_hash text, indexer_output_hash text);
CREATE TABLE lumen_ct_treasury_withdrawn_events (actor text, block numeric, amount text, indexer_contract_id text, indexer_block_height numeric, indexer_tx_hash text, indexer_ts timestamptz default now(), indexer_id serial primary key, indexer_log_hash text, indexer_output_hash text);
CREATE TABLE lumen_ct_trade_fees_claimed_events (actor text, block numeric, amount text, indexer_contract_id text, indexer_block_height numeric, indexer_tx_hash text, indexer_ts timestamptz default now(), indexer_id serial primary key, indexer_log_hash text, indexer_output_hash text);
CREATE OR REPLACE VIEW lumen_ct_balances AS
WITH moves AS (
  -- minted to the buyer
  SELECT creator, actor AS holder, minted::numeric AS delta FROM lumen_ct_bought_events
  UNION ALL
  -- burned from the seller
  SELECT creator, actor AS holder, -(sold::numeric) FROM lumen_ct_sold_events
  UNION ALL
  -- transfers move between two holders
  SELECT creator, actor AS holder, -(amount::numeric) FROM lumen_ct_transferred_events
  UNION ALL
  SELECT creator, recipient AS holder, amount::numeric FROM lumen_ct_transferred_events
  UNION ALL
  -- Matured-bucket movement (2026-07-30). A sale on magi-market settles
  -- through safeTransferFrom, which emits ONLY these — no bought/sold row
  -- exists for it. Without these two branches a holder who acquired
  -- tokens on the marketplace is invisible here, and this view is what the
  -- wind-down keeper reads to find holders: it would never sweep them,
  -- supply would never reach zero, and the market could never close.
  --
  -- Bucket moves are netted, not counted: a graduation (sender = '') and a
  -- matured burn on a curve sale (recipient = '') are already reflected by
  -- the bought/sold rows, so both are excluded here and only genuine
  -- holder-to-holder movement is folded in.
  SELECT creator, sender AS holder, -(amount::numeric) FROM lumen_ct_matured_moved_events
    WHERE sender <> '' AND recipient <> ''
  UNION ALL
  SELECT creator, recipient AS holder, amount::numeric FROM lumen_ct_matured_moved_events
    WHERE sender <> '' AND recipient <> ''
  UNION ALL
  -- an ask escrows the asker's tokens out of their balance
  SELECT creator, actor AS holder, -(credits_spent::numeric) FROM lumen_ct_asked_events
  UNION ALL
  -- answered pays the CREATOR, not the asker
  SELECT creator, creator AS holder, credits_to_creator::numeric FROM lumen_ct_answered_events
  UNION ALL
  -- reclaim and decline return the escrow to the ASKER (never `actor`:
  -- reclaim is permissionless, so actor may be a keeper or a stranger)
  SELECT creator, asker AS holder, credits::numeric FROM lumen_ct_reclaimed_events
  UNION ALL
  SELECT creator, asker AS holder, credits::numeric FROM lumen_ct_declined_events
  UNION ALL
  -- wind-down exits burn the holder's tokens
  SELECT creator, actor AS holder, -(credits::numeric) FROM lumen_ct_refunded_events
  UNION ALL
  SELECT creator, holder, -(credits_burned::numeric) FROM lumen_ct_refund_pushed_events
)
SELECT creator, holder, SUM(delta) AS tokens
FROM moves
GROUP BY creator, holder
HAVING SUM(delta) > 0;

CREATE OR REPLACE VIEW lumen_ct_price_history AS
WITH trades AS (
  SELECT creator, indexer_block_height AS block, indexer_ts AS ts,
         minted::numeric AS delta, 'buy' AS side
  FROM lumen_ct_bought_events
  UNION ALL
  SELECT creator, indexer_block_height, indexer_ts,
         -(sold::numeric), 'sell'
  FROM lumen_ct_sold_events
)
SELECT creator, block, ts, side, delta,
       SUM(delta) OVER (PARTITION BY creator ORDER BY block, ts) AS supply_after
FROM trades;

CREATE OR REPLACE VIEW lumen_ct_delivery_record AS
WITH answered AS (
  SELECT an.creator, COUNT(*) AS n
  FROM lumen_ct_answered_events an
  JOIN lumen_ct_asked_events a ON a.creator = an.creator AND a.seq = an.seq
  WHERE a.actor <> an.creator
  GROUP BY an.creator
),
missed AS (
  SELECT r.creator, COUNT(*) AS n
  FROM lumen_ct_reclaimed_events r
  WHERE r.asker <> r.creator
  GROUP BY r.creator
),
declined AS (
  SELECT d.creator, COUNT(*) AS n
  FROM lumen_ct_declined_events d
  WHERE d.asker <> d.creator
  GROUP BY d.creator
),
-- Response time, in BLOCKS, per delivered job. Median rather than mean is
-- computed by the reader; this exposes the raw pairs' aggregate.
response AS (
  SELECT an.creator,
         percentile_cont(0.5) WITHIN GROUP (
           ORDER BY (an.indexer_block_height - a.indexer_block_height)
         ) AS median_response_blocks
  FROM lumen_ct_answered_events an
  JOIN lumen_ct_asked_events a ON a.creator = an.creator AND a.seq = an.seq
  WHERE a.actor <> an.creator
  GROUP BY an.creator
),
rated AS (
  SELECT creator, AVG(score)::numeric(4,2) AS avg_rating, COUNT(*) AS rating_count
  FROM lumen_ct_rated_events
  GROUP BY creator
),
-- The LATEST registration per creator, not the first: a market that
-- closed and was re-registered is a NEW incarnation with a fresh delivery
-- record, and dating it from the dead one would show a brand-new market as
-- years old.
creators AS (
  SELECT creator, MAX(indexer_block_height) AS registered_block, MAX(indexer_ts) AS registered_ts
  FROM lumen_ct_registered_events GROUP BY creator
)
SELECT c.creator,
       c.registered_block,
       c.registered_ts,
       COALESCE(a.n, 0) AS answered_count,
       COALESCE(m.n, 0) AS missed_count,
       COALESCE(d.n, 0) AS declined_count,
       resp.median_response_blocks,
       r.avg_rating,
       COALESCE(r.rating_count, 0) AS rating_count,
       -- NULL, not 0, when nothing has resolved yet: a creator who has
       -- never been asked has no completion rate, and showing 0% would
       -- read as "fails everything".
       CASE WHEN COALESCE(a.n,0) + COALESCE(m.n,0) = 0 THEN NULL
            ELSE ROUND(100.0 * a.n / (a.n + m.n), 0)
       END AS completion_pct
FROM creators c
LEFT JOIN answered a ON a.creator = c.creator
LEFT JOIN missed   m ON m.creator = c.creator
LEFT JOIN declined d ON d.creator = c.creator
LEFT JOIN response resp ON resp.creator = c.creator
LEFT JOIN rated    r ON r.creator = c.creator;

CREATE OR REPLACE VIEW lumen_ct_my_asks AS
SELECT a.creator,
       a.actor AS asker,
       a.seq,
       a.credits_spent,
       a.commission_credits,
       a.offering_id,
       a.deadline_blocks,
       a.indexer_block_height AS asked_block,
       a.indexer_ts AS asked_ts,
       CASE
         WHEN an.seq IS NOT NULL THEN 'answered'
         WHEN d.seq  IS NOT NULL THEN 'declined'
         WHEN r.seq  IS NOT NULL THEN 'reclaimed'
         ELSE 'pending'
       END AS status,
       rt.score AS rating
FROM lumen_ct_asked_events a
LEFT JOIN lumen_ct_answered_events  an ON an.creator = a.creator AND an.seq = a.seq
LEFT JOIN lumen_ct_declined_events  d  ON d.creator  = a.creator AND d.seq  = a.seq
LEFT JOIN lumen_ct_reclaimed_events r  ON r.creator  = a.creator AND r.seq  = a.seq
LEFT JOIN lumen_ct_rated_events     rt ON rt.creator = a.creator AND rt.seq = a.seq;

CREATE OR REPLACE VIEW lumen_ct_creator_earnings AS
SELECT c.creator,
       COALESCE(svc.tokens_earned, 0) AS service_tokens_earned,
       COALESCE(svc.jobs, 0)          AS jobs_delivered,
       COALESCE(fees.hbd_claimed, 0)  AS trade_fees_claimed_hbd
FROM (SELECT DISTINCT creator FROM lumen_ct_registered_events) c
LEFT JOIN (
  SELECT creator, SUM(credits_to_creator::numeric) AS tokens_earned, COUNT(*) AS jobs
  FROM lumen_ct_answered_events GROUP BY creator
) svc ON svc.creator = c.creator
LEFT JOIN (
  SELECT actor AS creator, SUM(amount::numeric) AS hbd_claimed
  FROM lumen_ct_trade_fees_claimed_events GROUP BY actor
) fees ON fees.creator = c.creator;

CREATE OR REPLACE VIEW lumen_ct_discovery AS
SELECT d.*
FROM lumen_ct_delivery_record d
WHERE d.creator NOT IN (SELECT creator FROM lumen_ct_retired_events)
  AND d.creator NOT IN (SELECT creator FROM lumen_ct_closed_events)
ORDER BY
  (d.completion_pct IS NOT NULL) DESC,
  d.completion_pct DESC NULLS LAST,
  d.avg_rating DESC NULLS LAST,
  d.median_response_blocks ASC NULLS LAST;

INSERT INTO lumen_ct_registered_events (creator, actor, block, face, cap, fee_paid, indexer_block_height) VALUES ('hive:hbd-temp', 'hive:hbd-temp', 109626197, '1000', '1000000000', '0', 109626197);
INSERT INTO lumen_ct_bought_events (creator, actor, block, minted, cost, fee, total_due, indexer_block_height) VALUES ('hive:hbd-temp', 'hive:hbd-temp', 109636949, '1', '1007', '50', '1057', 109636949);
INSERT INTO lumen_ct_bought_events (creator, actor, block, minted, cost, fee, total_due, indexer_block_height) VALUES ('hive:hbd-temp', 'hive:lordbutterfly', 110111621, '1', '1016', '50', '1066', 110111621);
INSERT INTO lumen_ct_asked_events (creator, actor, block, seq, credits_spent, commission_credits, rate, deadline_blocks, content_hash, offering_id, indexer_block_height) VALUES ('hive:hbd-temp', 'hive:lordbutterfly', 110112084, 0, '1', '0', '1015', 28800, 'ask-14woy0', 1, 110112084);
INSERT INTO lumen_ct_answered_events (creator, actor, block, seq, credits_to_creator, commission_credits, commission_to, answer_hash, indexer_block_height) VALUES ('hive:hbd-temp', 'hive:hbd-temp', 110113000, 0, '1', '0', 'hive:lumencontracts', 'TESTING TEST', 110113000);
INSERT INTO lumen_ct_rated_events (creator, actor, block, seq, score, indexer_block_height) VALUES ('hive:hbd-temp', 'hive:lordbutterfly', 110113500, 0, 5, 110113500);
INSERT INTO lumen_ct_bought_events (creator, actor, block, minted, cost, fee, total_due, indexer_block_height) VALUES ('hive:hbd-temp', 'hive:lordbutterfly', 110200000, '1.50', '1560', '78', '1638', 110200000);
INSERT INTO lumen_ct_transferred_events (creator, actor, recipient, block, amount, indexer_block_height) VALUES ('hive:hbd-temp', 'hive:lordbutterfly', 'hive:third', 110200010, '0.25', 110200010);
INSERT INTO lumen_ct_sold_events (creator, actor, block, sold, gross, tax, fee, net, tax_bps, held_blocks, taxable_gross, indexer_block_height) VALUES ('hive:hbd-temp', 'hive:third', 110200020, '0.10', '104', '16', '5', '83', 1500, 10, '104', 110200020);
INSERT INTO lumen_ct_asked_events (creator, actor, block, seq, credits_spent, commission_credits, rate, deadline_blocks, content_hash, offering_id, indexer_block_height) VALUES ('hive:hbd-temp', 'hive:lordbutterfly', 110200030, 1, '0.99', '0.11', '1016', 28800, 'ask-v6a', 1, 110200030);
INSERT INTO lumen_ct_answered_events (creator, actor, block, seq, credits_to_creator, commission_credits, commission_to, answer_hash, indexer_block_height) VALUES ('hive:hbd-temp', 'hive:hbd-temp', 110200040, 1, '0.88', '0.11', 'hive:lumencontracts', 'ans-v6a', 110200040);
INSERT INTO lumen_ct_asked_events (creator, actor, block, seq, credits_spent, commission_credits, rate, deadline_blocks, content_hash, offering_id, indexer_block_height) VALUES ('hive:hbd-temp', 'hive:lordbutterfly', 110200050, 2, '0.49', '0.05', '1016', 28800, 'ask-v6b', 0, 110200050);
INSERT INTO lumen_ct_declined_events (creator, actor, asker, block, seq, credits, indexer_block_height) VALUES ('hive:hbd-temp', 'hive:hbd-temp', 'hive:lordbutterfly', 110200060, 2, '0.49', 110200060);
INSERT INTO lumen_ct_asked_events (creator, actor, block, seq, credits_spent, commission_credits, rate, deadline_blocks, content_hash, offering_id, indexer_block_height) VALUES ('hive:hbd-temp', 'hive:lordbutterfly', 110200070, 3, '0.20', '0.02', '1016', 28800, 'ask-v6c', 0, 110200070);
INSERT INTO lumen_ct_reclaimed_events (creator, actor, asker, block, seq, credits, commission_retained_credits, retained_to, indexer_block_height) VALUES ('hive:hbd-temp', 'hive:anyone', 'hive:lordbutterfly', 110230000, 3, '0.00', '0.20', 'hive:lumencontracts', 110230000);
INSERT INTO lumen_ct_matured_moved_events (creator, actor, sender, recipient, block, amount, indexer_block_height) VALUES ('hive:hbd-temp', 'hive:hbd-temp', 'hive:hbd-temp', 'hive:third', 110240000, '0.40', 110240000);
\echo === balances
SELECT creator, holder, tokens FROM lumen_ct_balances ORDER BY holder;
\echo === price_history
SELECT block, side, delta, supply_after FROM lumen_ct_price_history ORDER BY block;
\echo === earnings
SELECT * FROM lumen_ct_creator_earnings;
\echo === my_asks
SELECT seq, status, credits_spent FROM lumen_ct_my_asks ORDER BY seq;
\echo === delivery
SELECT * FROM lumen_ct_delivery_record;
\echo === discovery
SELECT * FROM lumen_ct_discovery;
