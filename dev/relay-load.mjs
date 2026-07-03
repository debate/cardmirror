// Load client for relay capacity testing (used for the 2026-07 capacity
// study and the overload-hardening acceptance runs).
//
// Usage:  RELAY=http://127.0.0.1:8411/relay TOKEN=<token> node dev/relay-load.mjs <mode>
// Raise the fd limit first for large stream counts: ulimit -n 10240
// Modes:
//   streams  — open SSE connections in waves, hold them, report receipt latency
//   blast <rate> <seconds> <numTargets> <payloadBytes> — POST at a fixed rate
const RELAY = process.env.RELAY ?? 'http://127.0.0.1:8411/relay';
const TOKEN = process.env.TOKEN ?? 'loadtest-token';
const mode = process.argv[2];

const HEADERS = { authorization: `Bearer ${TOKEN}` };

function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

if (mode === 'streams') {
  const waves = (process.env.WAVES ?? '100,250,500,1000,1500').split(',').map(Number); // cumulative totals
  let open = 0;
  let helloed = 0;
  const latencies = [];
  let recv = 0;

  async function openStream(i) {
    const rc = `rc-${i}`;
    try {
      const res = await fetch(`${RELAY}/stream?recipient=${rc}`, { headers: HEADERS });
      if (!res.ok) { console.log(`ERR stream ${i} status=${res.status}`); return; }
      open++;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (frame.startsWith('event: hello')) helloed++;
          else if (frame.startsWith('data: ')) {
            recv++;
            try {
              const msg = JSON.parse(frame.slice(6));
              if (typeof msg.sentAt === 'number') latencies.push(Date.now() - msg.sentAt);
            } catch { /* ignore */ }
          }
        }
      }
    } catch (e) {
      console.log(`ERR stream ${i}: ${String(e).slice(0, 80)}`);
    }
    open--;
  }

  (async () => {
    let opened = 0;
    for (const target of waves) {
      while (opened < target) {
        openStream(opened++);
        if (opened % 25 === 0) await new Promise((r) => setTimeout(r, 1000)); // ~25 conns/s pacing
      }
      await new Promise((r) => setTimeout(r, 8000));
      console.log(`WAVE ${target} open=${open} helloed=${helloed} t=${Date.now()}`);
    }
    console.log('HOLDING');
    setInterval(() => {
      const sorted = latencies.slice(-5000).sort((a, b) => a - b);
      console.log(`STATS recv=${recv} open=${open} p50=${pct(sorted, 50)}ms p95=${pct(sorted, 95)}ms max=${sorted[sorted.length - 1] ?? 0}ms`);
      latencies.length = 0;
    }, 5000);
  })();
} else if (mode === 'blast') {
  const rate = Number(process.argv[3] ?? 50);
  const seconds = Number(process.argv[4] ?? 10);
  const numTargets = Number(process.argv[5] ?? 60);
  const payloadBytes = Number(process.argv[6] ?? 1500);
  const ct = Buffer.alloc(Math.max(16, payloadBytes - 200)).toString('base64').slice(0, payloadBytes - 200);
  let sent = 0, errors = 0;
  const acks = [];
  let target = 0;

  const tickMs = 50;
  const perTick = Math.max(1, Math.round(rate * tickMs / 1000));
  const t0 = Date.now();
  const iv = setInterval(async () => {
    if (Date.now() - t0 > seconds * 1000) {
      clearInterval(iv);
      // allow in-flight acks to land
      setTimeout(() => {
        const sorted = acks.sort((a, b) => a - b);
        console.log(`BLAST rate=${rate} bytes=${payloadBytes} sent=${sent} errors=${errors} ack_p50=${pct(sorted, 50)}ms ack_p95=${pct(sorted, 95)}ms ack_max=${sorted[sorted.length - 1] ?? 0}ms`);
        process.exit(0);
      }, 2000);
      return;
    }
    for (let i = 0; i < perTick; i++) {
      const body = JSON.stringify({
        v: 1, recipientCode: `rc-${target++ % numTargets}`, sentAt: Date.now(),
        epk: 'x'.repeat(43), iv: 'y'.repeat(16), tag: 'z'.repeat(22), ct,
      });
      const t = Date.now();
      fetch(`${RELAY}/messages`, { method: 'POST', headers: { ...HEADERS, 'content-type': 'application/json' }, body })
        .then((r) => { if (r.status !== 202) errors++; else { sent++; acks.push(Date.now() - t); } r.arrayBuffer(); })
        .catch(() => errors++);
    }
  }, tickMs);
} else if (mode === 'blast2') {
  // Bounded in-flight (32), keep-alive reuse: measures SERVER capacity
  // rather than client socket storms. Reports achieved rate + ack latency.
  const rate = Number(process.argv[3] ?? 100);
  const seconds = Number(process.argv[4] ?? 10);
  const numTargets = Number(process.argv[5] ?? 60);
  const payloadBytes = Number(process.argv[6] ?? 1500);
  const ct = Buffer.alloc(Math.max(16, payloadBytes - 200)).toString('base64').slice(0, payloadBytes - 200);
  const MAX_INFLIGHT = 32;
  let inflight = 0, sent = 0, errors = 0, shed = 0, target = 0;
  const acks = [];
  const t0 = Date.now();
  const iv = setInterval(() => {
    if (Date.now() - t0 > seconds * 1000) {
      clearInterval(iv);
      setTimeout(() => {
        const sorted = acks.sort((a, b) => a - b);
        const dur = (Date.now() - t0 - 2000) / 1000;
        console.log(`BLAST2 rate=${rate} bytes=${payloadBytes} sent=${sent} achieved=${(sent / dur).toFixed(0)}/s errors=${errors} shed=${shed} ack_p50=${pct(sorted, 50)}ms ack_p95=${pct(sorted, 95)}ms ack_max=${sorted[sorted.length - 1] ?? 0}ms`);
        process.exit(0);
      }, 2000);
      return;
    }
    const want = Math.max(1, Math.round(rate / 20));
    for (let i = 0; i < want; i++) {
      if (inflight >= MAX_INFLIGHT) { shed++; continue; }
      inflight++;
      const body = JSON.stringify({
        v: 1, recipientCode: `rc-${target++ % numTargets}`, sentAt: Date.now(),
        epk: 'x'.repeat(43), iv: 'y'.repeat(16), tag: 'z'.repeat(22), ct,
      });
      const t = Date.now();
      fetch(`${RELAY}/messages`, { method: 'POST', headers: { ...HEADERS, 'content-type': 'application/json' }, body })
        .then(async (r) => { await r.arrayBuffer(); if (r.status !== 202) errors++; else { sent++; acks.push(Date.now() - t); } })
        .catch(() => errors++)
        .finally(() => { inflight--; });
    }
  }, 50);
} else {
  console.log('usage: streams | blast <rate> <seconds> <numTargets> <payloadBytes> | blast2 ...');
  process.exit(1);
}
