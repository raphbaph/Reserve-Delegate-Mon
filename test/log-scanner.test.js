import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { scanLogs, CHUNK_SIZES } from '../log-scanner.js';

const iface = new ethers.Interface([
  'event VoteCast(address indexed voter, uint256 proposalId, uint8 support, uint256 weight, string reason)',
  'event VoteCastWithParams(address indexed voter, uint256 proposalId, uint8 support, uint256 weight, string reason, bytes params)',
  'event ProposalCreated(uint256 proposalId, address proposer, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 startBlock, uint256 endBlock, string description)',
]);
const addresses = ['0x' + '11'.repeat(20), '0x' + '22'.repeat(20)];
const voter = '0x' + '33'.repeat(20);
const other = '0x' + '44'.repeat(20);
function log(name, args, address, blockNumber, index = 0) {
  return { ...iface.encodeEventLog(iface.getEvent(name), args), address, blockNumber, index };
}
const fixtures = [
  log('ProposalCreated', [1, voter, [], [], [], [], 1, 9, 'First proposal'], addresses[0], 0),
  log('ProposalCreated', [1, voter, [], [], [], [], 1, 9, 'Other governor'], addresses[1], 1),
  log('VoteCast', [voter, 1, 1, 100, 'yes'], addresses[0], 4),
  log('VoteCastWithParams', [voter, 1, 2, 200, 'abstain', '0x1234'], addresses[1], 5),
  log('VoteCast', [other, 1, 0, 300, 'untracked'], addresses[0], 6),
  log('VoteCast', [voter, 1, 0, 400, 'last'], addresses[0], 9),
  log('VoteCast', [voter, 1, 0, 400, 'outside'], addresses[0], 10),
];
const options = { iface, addresses, voters: [voter], fromBlock: 0, toBlock: 9, chunkSize: 5, concurrency: 3 };
function matching(filter) {
  return fixtures.filter((l) => filter.address.includes(l.address) && l.blockNumber >= filter.fromBlock && l.blockNumber <= filter.toBlock && filter.topics.every((t, i) => (Array.isArray(t) ? t : [t]).includes(l.topics[i])));
}

test('combined filters preserve both vote types, governor identity and inclusive boundaries', async () => {
  let active = 0, peak = 0, calls = 0;
  const provider = { async getLogs(filter) {
    calls++; peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
    return matching(filter);
  } };
  const events = await scanLogs({ ...options, provider });
  assert.equal(calls, 4); // two queries per chunk, regardless of governor count
  assert.equal(peak, 3);
  assert.deepEqual(events.map((e) => e.blockNumber), [0, 1, 4, 5, 9]);
  assert.equal(events[3].eventName, 'VoteCastWithParams');
  assert.equal(events[3].args.params, '0x1234');
  assert.deepEqual(events.slice(0, 2).map((e) => e.args.description), ['First proposal', 'Other governor']);
});

test('range errors split without gaps, duplicates or sleeping; learned limit is reused', async () => {
  let rejected = 0;
  const provider = { async getLogs(filter) {
    if (filter.toBlock - filter.fromBlock + 1 > 2) {
      rejected++;
      throw { error: { code: -32602, message: 'exceed maximum block range 2' } };
    }
    return matching(filter);
  } };
  const events = await scanLogs({ ...options, provider, concurrency: 1, sleep: () => assert.fail('range errors must not back off') });
  assert.equal(rejected, 2);
  assert.deepEqual(events.map((e) => e.blockNumber), [0, 1, 4, 5, 9]);
});

test('BSC default respects 5000-block maximum', () => assert.equal(CHUNK_SIZES.bsc, 5000));

test('transient failures retry, permanent failures fail immediately', async () => {
  let calls = 0, sleeps = 0;
  const provider = { async getLogs() { if (++calls === 1) throw { error: { code: 429, message: 'rate limit' } }; return []; } };
  await scanLogs({ ...options, provider, concurrency: 1, sleep: async () => { sleeps++; } });
  assert.equal(sleeps, 1);
  assert.equal(calls, 5);
  calls = 0;
  await assert.rejects(scanLogs({ ...options, concurrency: 1, provider: { async getLogs() { calls++; throw new Error('invalid API key'); } } }), /invalid API key/);
  assert.equal(calls, 1);
});

test('retry exhaustion and unsplittable errors never return partial results', async () => {
  let calls = 0;
  await assert.rejects(scanLogs({ ...options, concurrency: 1, sleep: async () => {}, provider: { async getLogs() { calls++; throw new Error('503 unavailable'); } } }), /503/);
  assert.equal(calls, 6);
  await assert.rejects(scanLogs({ ...options, fromBlock: 0, toBlock: 0, provider: { async getLogs() { throw new Error('too many results'); } } }), /too many results/);
});
