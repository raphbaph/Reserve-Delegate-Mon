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

Base support is in. Three things to do on your side:

  1. Add RPC_URL_BASE to your .env (Alchemy → Base Mainnet → API key). The .env.example shows the format.
  2. governors.txt now takes an optional third column for chain. I added the Base governor and left your three existing entries unchanged (they default to mainnet).
  3. Run as before — node index.js --from 2024-01-01 --to 2025-05-11. CSV now has a chain column as the first field, and rows are sorted by chain, then governor, then block.

  What changed under the hood

  - Per-chain provider with lazy init (getProvider('base') only fires if a base governor is present, so you won't crash if you forget RPC_URL_BASE and only run mainnet).
  - Per-chain block-range cache: --from 2024-01-01 is a different block number on mainnet (~18.9M) vs Base (~8M), so each chain binary-searches its own range once and reuses it.
  - Proposal lookback is now date-based (6 months before --from), not a hardcoded block count. This was needed because Base's ~2s blocks would have made the old 1.8M-block constant only
  cover ~6 weeks.
  - ENS stays on the mainnet provider regardless of where a vote happened — addresses voting from Base still get their L1 ENS name resolved. If you ever drop mainnet from .env, ENS
  resolution is skipped with a warning rather than crashing.
  - Block-timestamp cache is now keyed by chain:blockNumber so a Base block 12345 and a mainnet block 12345 don't collide.
