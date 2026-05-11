import 'dotenv/config';
import { ethers } from 'ethers';
import fs from 'node:fs';

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
  console.error('Missing RPC_URL — copy .env.example to .env and fill it in.');
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if (!args.from || !args.to) {
  console.error('Usage: node index.js --from YYYY-MM-DD --to YYYY-MM-DD [--out votes.csv]');
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);

const GOVERNOR_ABI = [
  'event VoteCast(address indexed voter, uint256 proposalId, uint8 support, uint256 weight, string reason)',
  'event VoteCastWithParams(address indexed voter, uint256 proposalId, uint8 support, uint256 weight, string reason, bytes params)',
  'event ProposalCreated(uint256 proposalId, address proposer, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 startBlock, uint256 endBlock, string description)',
];

const SUPPORT = { 0: 'Against', 1: 'For', 2: 'Abstain' };
const CHUNK = 9_500;
const PROPOSAL_LOOKBACK_BLOCKS = 1_800_000; // ~6 months

main().catch((e) => { console.error(e); process.exit(1); });

async function main() {
  const delegates = readList('delegates.txt');
  const governors = readGovernors('governors.txt');
  if (!delegates.length) throw new Error('delegates.txt has no addresses');
  if (!governors.length) throw new Error('governors.txt has no addresses');

  console.log(`Tracking ${delegates.length} delegate(s) across ${governors.length} governor(s)`);
  console.log(`Resolving block range for ${args.from} → ${args.to}…`);
  const [fromBlock, toBlock] = await Promise.all([
    dateToBlock(args.from, 'after'),
    dateToBlock(args.to, 'before'),
  ]);
  console.log(`Block range: ${fromBlock} → ${toBlock}`);

  console.log('\nResolving ENS names…');
  const ensCache = new Map();
  for (const a of delegates) {
    const name = await safeLookupAddress(a);
    ensCache.set(a.toLowerCase(), name || '');
    console.log(`  ${a}${name ? ' → ' + name : ''}`);
  }

  const blockCache = new Map();
  const rows = [];

  for (const { address, label } of governors) {
    console.log(`\nGovernor ${address}${label ? ' (' + label + ')' : ''}`);
    const contract = new ethers.Contract(address, GOVERNOR_ABI, provider);

    const proposalsFrom = Math.max(0, fromBlock - PROPOSAL_LOOKBACK_BLOCKS);
    console.log(`  Indexing proposals (block ${proposalsFrom} → ${toBlock})…`);
    const proposalMap = await loadProposals(contract, proposalsFrom, toBlock);
    console.log(`  Found ${proposalMap.size} proposal(s)`);

    console.log(`  Querying votes…`);
    const votes = await loadVotes(contract, delegates, fromBlock, toBlock);
    console.log(`  Found ${votes.length} vote(s) from tracked delegates`);

    for (const v of votes) {
      const ts = await getBlockTimestamp(v.blockNumber, blockCache);
      const id = v.args.proposalId.toString();
      rows.push({
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
    const [addr, ...labelParts] = line.split(',');
    return { address: addr.trim(), label: labelParts.join(',').trim() };
  });
}

async function dateToBlock(dateStr, mode) {
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

async function safeLookupAddress(addr) {
  try { return await provider.lookupAddress(addr); }
  catch { return null; }
}

async function getBlockTimestamp(n, cache) {
  if (cache.has(n)) return cache.get(n);
  const b = await provider.getBlock(n);
  cache.set(n, b.timestamp);
  return b.timestamp;
}

async function loadVotes(contract, voters, fromBlock, toBlock) {
  const out = [];
  // ethers passes an array as multiple values for the indexed topic (OR filter)
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
    'governor', 'governor_label', 'voter', 'voter_ens',
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
