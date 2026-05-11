import 'dotenv/config';
import { ethers } from 'ethers';
import fs from 'node:fs';

const args = parseArgs(process.argv.slice(2));
if (!args.from || !args.to) {
  console.error('Usage: node index.js --from YYYY-MM-DD --to YYYY-MM-DD [--out votes.csv]');
  process.exit(1);
}

const GOVERNOR_ABI = [
  'event VoteCast(address indexed voter, uint256 proposalId, uint8 support, uint256 weight, string reason)',
  'event VoteCastWithParams(address indexed voter, uint256 proposalId, uint8 support, uint256 weight, string reason, bytes params)',
  'event ProposalCreated(uint256 proposalId, address proposer, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 startBlock, uint256 endBlock, string description)',
];

const SUPPORT = { 0: 'Against', 1: 'For', 2: 'Abstain' };
const CHUNK = 9_500;
const PROPOSAL_LOOKBACK_MONTHS = 6;

const CHAIN_ALIASES = { ethereum: 'mainnet', eth: 'mainnet' };
const CHAIN_ENV = {
  mainnet: 'RPC_URL',
  base: 'RPC_URL_BASE',
};

const providers = {};
function getProvider(chain) {
  if (providers[chain]) return providers[chain];
  const envVar = CHAIN_ENV[chain];
  if (!envVar) throw new Error(`Unsupported chain "${chain}". Supported: ${Object.keys(CHAIN_ENV).join(', ')}`);
  const url = process.env[envVar];
  if (!url) throw new Error(`Missing ${envVar} in .env (needed for chain "${chain}")`);
  providers[chain] = new ethers.JsonRpcProvider(url);
  return providers[chain];
}

main().catch((e) => { console.error(e); process.exit(1); });

async function main() {
  const delegates = readList('delegates.txt');
  const governors = readGovernors('governors.txt');
  if (!delegates.length) throw new Error('delegates.txt has no addresses');
  if (!governors.length) throw new Error('governors.txt has no addresses');

  const chains = [...new Set(governors.map((g) => g.chain))];
  console.log(`Tracking ${delegates.length} delegate(s) across ${governors.length} governor(s) on ${chains.length} chain(s): ${chains.join(', ')}`);

  // ENS resolution always uses mainnet (ENS lives on L1).
  // Skip gracefully if mainnet RPC isn't configured (e.g. base-only setup).
  let ensProvider = null;
  try { ensProvider = getProvider('mainnet'); }
  catch { console.warn('Skipping ENS resolution: RPC_URL (mainnet) not set'); }

  console.log('\nResolving ENS names…');
  const ensCache = new Map();
  for (const a of delegates) {
    const name = ensProvider ? await safeLookupAddress(ensProvider, a) : null;
    ensCache.set(a.toLowerCase(), name || '');
    console.log(`  ${a}${name ? ' → ' + name : ''}`);
  }

  // Per-chain block ranges (same date → different blocks on each chain).
  const proposalsFromDate = subtractMonths(args.from, PROPOSAL_LOOKBACK_MONTHS);
  const ranges = new Map();
  async function rangeFor(chain) {
    if (ranges.has(chain)) return ranges.get(chain);
    const p = getProvider(chain);
    console.log(`\nResolving ${chain} block range for ${args.from} → ${args.to}…`);
    const [fromBlock, toBlock, proposalsFromBlock] = await Promise.all([
      dateToBlock(p, args.from, 'after'),
      dateToBlock(p, args.to, 'before'),
      dateToBlock(p, proposalsFromDate, 'after'),
    ]);
    console.log(`  ${chain}: votes ${fromBlock} → ${toBlock}; proposals from ${proposalsFromBlock}`);
    const r = { fromBlock, toBlock, proposalsFromBlock };
    ranges.set(chain, r);
    return r;
  }

  const blockCache = new Map(); // key: `${chain}:${blockNumber}`
  const rows = [];

  for (const { address, label, chain } of governors) {
    const provider = getProvider(chain);
    const { fromBlock, toBlock, proposalsFromBlock } = await rangeFor(chain);

    console.log(`\nGovernor ${address} (${chain})${label ? ' — ' + label : ''}`);
    const contract = new ethers.Contract(address, GOVERNOR_ABI, provider);

    console.log(`  Indexing proposals (block ${proposalsFromBlock} → ${toBlock})…`);
    const proposalMap = await loadProposals(contract, proposalsFromBlock, toBlock);
    console.log(`  Found ${proposalMap.size} proposal(s)`);

    console.log(`  Querying votes…`);
    const votes = await loadVotes(contract, delegates, fromBlock, toBlock);
    console.log(`  Found ${votes.length} vote(s) from tracked delegates`);

    for (const v of votes) {
      const ts = await getBlockTimestamp(provider, chain, v.blockNumber, blockCache);
      const id = v.args.proposalId.toString();
      rows.push({
        chain,
        governor: address,
        governor_label: label || '',
        voter: v.args.voter,
        voter_ens: ensCache.get(v.args.voter.toLowerCase()) || '',
        proposal_id: id,
        proposal_title: proposalMap.get(id) || '',
        support: SUPPORT[Number(v.args.support)] ?? String(v.args.support),
        weight_raw: v.args.weight.toString(),
        weight: ethers.formatUnits(v.args.weight, 18),
        reason: (v.args.reason || '').replace(/\r?\n/g, ' ').trim(),
        block_number: v.blockNumber,
        timestamp: new Date(ts * 1000).toISOString(),
        tx_hash: v.transactionHash,
      });
    }
  }

  rows.sort((a, b) =>
    a.chain.localeCompare(b.chain) ||
    a.governor.localeCompare(b.governor) ||
    a.block_number - b.block_number,
  );

  const outPath = args.out || 'votes.csv';
  writeCsv(outPath, rows);
  console.log(`\nWrote ${rows.length} row(s) to ${outPath}`);
}

// ---------- helpers ----------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) out[k.slice(2)] = argv[++i];
  }
  return out;
}

function readList(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.split('#')[0].trim())
    .filter(Boolean);
}

function readGovernors(file) {
  return readList(file).map((line) => {
    const parts = line.split(',').map((s) => s.trim());
    const addr = parts[0];
    const label = parts[1] || '';
    const rawChain = (parts[2] || 'mainnet').toLowerCase();
    const chain = CHAIN_ALIASES[rawChain] || rawChain;
    return { address: addr, label, chain };
  });
}

function subtractMonths(dateStr, months) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

async function dateToBlock(provider, dateStr, mode) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(`Invalid date "${dateStr}" — use YYYY-MM-DD`);
  }
  const target = Math.floor(new Date(dateStr + 'T00:00:00Z').getTime() / 1000);
  const latest = await provider.getBlockNumber();
  let lo = 0;
  let hi = latest;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const b = await provider.getBlock(mid);
    if (b.timestamp < target) lo = mid + 1;
    else hi = mid;
  }
  return mode === 'after' ? lo : Math.max(0, lo - 1);
}

async function safeLookupAddress(provider, addr) {
  try { return await provider.lookupAddress(addr); }
  catch { return null; }
}

async function getBlockTimestamp(provider, chain, n, cache) {
  const key = `${chain}:${n}`;
  if (cache.has(key)) return cache.get(key);
  const b = await provider.getBlock(n);
  cache.set(key, b.timestamp);
  return b.timestamp;
}

async function loadVotes(contract, voters, fromBlock, toBlock) {
  const out = [];
  const f1 = contract.filters.VoteCast(voters);
  const f2 = contract.filters.VoteCastWithParams(voters);
  for (let from = fromBlock; from <= toBlock; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, toBlock);
    const [a, b] = await Promise.all([
      queryWithRetry(contract, f1, from, to),
      queryWithRetry(contract, f2, from, to),
    ]);
    out.push(...a, ...b);
  }
  return out.sort((x, y) => x.blockNumber - y.blockNumber);
}

async function loadProposals(contract, fromBlock, toBlock) {
  const map = new Map();
  const f = contract.filters.ProposalCreated();
  for (let from = fromBlock; from <= toBlock; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, toBlock);
    const events = await queryWithRetry(contract, f, from, to);
    for (const e of events) {
      const id = e.args.proposalId.toString();
      const desc = e.args.description || '';
      map.set(id, desc.split('\n')[0].slice(0, 200));
    }
  }
  return map;
}

async function queryWithRetry(contract, filter, from, to, attempt = 0) {
  try { return await contract.queryFilter(filter, from, to); }
  catch (e) {
    if (attempt >= 5) throw e;
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    return queryWithRetry(contract, filter, from, to, attempt + 1);
  }
}

function writeCsv(file, rows) {
  const cols = [
    'chain', 'governor', 'governor_label', 'voter', 'voter_ens',
    'proposal_id', 'proposal_title', 'support',
    'weight_raw', 'weight', 'reason',
    'block_number', 'timestamp', 'tx_hash',
  ];
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map((c) => esc(r[c])).join(','));
  fs.writeFileSync(file, lines.join('\n') + '\n');
}
