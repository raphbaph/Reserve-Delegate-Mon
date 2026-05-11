Here's what to do to run it:

  cp .env.example .env        # then paste your Alchemy URL into RPC_URL
  node index.js --from 2024-01-01 --to 2025-05-11

  What it does

  - Reads delegates.txt and governors.txt (commented templates already in place).
  - Binary-searches block timestamps to convert your --from / --to dates into block numbers.
  - Per governor: pulls ProposalCreated events from ~6 months before the start date (so vote rows can be enriched with the proposal's title), then pulls VoteCast + VoteCastWithParams
  filtered on the delegate set in one OR'd query per chunk.
  - Resolves ENS once per delegate (with forward-confirmation via lookupAddress).
  - Writes votes.csv with: governor, governor_label, voter, voter_ens, proposal_id, proposal_title, support, weight_raw, weight, reason, block_number, timestamp, tx_hash. Rows are sorted
   by governor then block, so each contract's votes are contiguous.

  Things to know

  - support is decoded to For / Against / Abstain.
  - weight assumes 18 decimals (true for Reserve's stRSR/ERC20Votes). weight_raw keeps the on-chain integer if you need exactness.
  - proposal_title stays blank if a proposal was created more than ~6 months before your start date. Bump PROPOSAL_LOOKBACK_BLOCKS in index.js if you need a deeper history.
  - Block chunk size is 9,500 — well inside Alchemy's eth_getLogs ceiling. Retries with exponential backoff on transient failure
