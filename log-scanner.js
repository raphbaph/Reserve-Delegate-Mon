// A worker owns at most one RPC request at a time, including retries/splits.
export const CHUNK_SIZES = { mainnet: 9500, base: 9500, bsc: 5000 };

export async function scanLogs({ provider, iface, addresses, voters, fromBlock, toBlock,
  chunkSize, concurrency = 4, onProgress = () => {}, onRetry = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error('Concurrency must be an integer between 1 and 32');
  }
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new Error('Invalid chunk size');
  const address = [...new Set(addresses.map((a) => a.toLowerCase()))];
  const filters = [
    { address, topics: [iface.getEvent('ProposalCreated').topicHash] },
    { address, topics: [
      [iface.getEvent('VoteCast').topicHash, iface.getEvent('VoteCastWithParams').topicHash],
      [...new Set(voters.map((v) => v.toLowerCase().replace(/^0x/, '0x' + '0'.repeat(24))))],
    ] },
  ];
  let maxRange = chunkSize;
  let next = 0;
  let completed = 0;
  let stopped = false;
  const total = Math.ceil((toBlock - fromBlock + 1) / chunkSize) * filters.length;
  const results = [];
  const started = Date.now();

  async function query(filter, from, to, attempt = 0) {
    if (stopped) return [];
    if (to - from + 1 > maxRange) {
      const mid = Math.min(from + maxRange - 1, to - 1);
      return [...await query(filter, from, mid), ...await query(filter, mid + 1, to)];
    }
    try {
      return await provider.getLogs({ ...filter, fromBlock: from, toBlock: to });
    } catch (error) {
      const message = [error.message, error.error?.message, error.info?.error?.message].filter(Boolean).join(' ');
      const rangeError = /(?:maximum|max|exceed|limit|too (?:large|wide)).*block range|block range.*(?:maximum|max|exceed|limit|too)|too many (?:results|logs)|query returned more than|response size.*(?:exceed|large)|log response size exceeded/i.test(message);
      if (rangeError && from < to) {
        // Remember a smaller size so subsequent jobs do not repeat rejected requests.
        maxRange = Math.min(maxRange, Math.ceil((to - from + 1) / 2));
        onRetry({ from, to, reason: 'range limit; splitting', attempt });
        return query(filter, from, to);
      }
      const code = error.error?.code ?? error.info?.error?.code ?? error.code;
      const transient = code === 429 || /429|rate limit|too many requests|throughput|timeout|timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|502|503|504|temporarily unavailable/i.test(message) || error.code === 'TIMEOUT' || error.code === 'NETWORK_ERROR';
      if (!transient || attempt >= 5) throw error;
      onRetry({ from, to, reason: 'temporary RPC failure', attempt: attempt + 1 });
      await sleep(500 * 2 ** attempt + Math.floor(Math.random() * 250));
      return query(filter, from, to, attempt + 1);
    }
  }

  async function worker() {
    while (!stopped && next < total) {
      const job = next++;
      const from = fromBlock + Math.floor(job / filters.length) * chunkSize;
      const to = Math.min(from + chunkSize - 1, toBlock);
      try {
        const logs = await query(filters[job % filters.length], from, to);
        for (const log of logs) results.push(log);
        onProgress({ completed: ++completed, total, elapsedMs: Date.now() - started });
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  }
  // Drain active workers before reporting failure; never return partial results.
  const workers = await Promise.allSettled(Array.from({ length: Math.min(concurrency, total) }, worker));
  const failed = workers.find((w) => w.status === 'rejected');
  if (failed) throw failed.reason;
  return results.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index)
    .map((log) => {
      const event = iface.parseLog(log);
      if (!event) throw new Error(`Unexpected event from ${log.address}`);
      return { ...log, args: event.args, eventName: event.name };
    });
}
