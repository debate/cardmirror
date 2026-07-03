// Wire-contract suite for the relay (20 checks): mailbox CRUD, gzip and
// malformed bodies, ordering, recipient isolation, SSE hello/push/heartbeat,
// dormant auth endpoints. Old-client compatibility gate: run before AND
// after any relay change — the results must be identical (see the relay
// hardening, 2026-07-04).
//
// Usage:  BASE=http://127.0.0.1:8411/relay TOKEN=<token> [HB=1] node dev/relay-contract.mjs
// (HB=1 adds the 25s heartbeat check; omit for fast runs.)
const BASE = process.env.BASE || 'http://127.0.0.1:8300/relay';
const TOK = process.env.TOKEN || 'dev-pairing-token';
const AUTH = { Authorization: `Bearer ${TOK}` };
let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} ${extra}`); }
}

// 1. health, no auth
{
  const r = await fetch(`${BASE}/health`);
  check('health 200', r.status === 200);
}
// 2. auth required
{
  const r1 = await fetch(`${BASE}/messages?recipient=x`);
  const r2 = await fetch(`${BASE}/stream?recipient=x`);
  const r3 = await fetch(`${BASE}/messages`, { method: 'POST', body: '{}' });
  check('GET unauthenticated 401', r1.status === 401);
  check('stream unauthenticated 401', r2.status === 401, String(r2.status));
  check('POST unauthenticated 401', r3.status === 401);
}
// 3-5. SSE: open stream, POST, receive push; store retains until DELETE
const R = 'contract-recipient-1';
{
  const frames = [];
  let hello = false;
  const ctl = new AbortController();
  const streamDone = (async () => {
    const res = await fetch(`${BASE}/stream?recipient=${R}`, { headers: AUTH, signal: ctl.signal });
    check('stream 200 + event-stream', res.status === 200 && (res.headers.get('content-type') || '').includes('text/event-stream'), String(res.status));
    let buf = '';
    const dec = new TextDecoder();
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          if (frame.includes('event: hello')) hello = true;
          else if (frame.startsWith('data:')) frames.push(JSON.parse(frame.slice(5).trim()));
        }
      }
    } catch { /* aborted */ }
  })();
  await new Promise((r2) => setTimeout(r2, 400));
  check('hello frame received', hello);

  const body = { recipientCode: R, epk: 'E', iv: 'I', ct: 'C', tag: 'T', v: 1 };
  const post = await fetch(`${BASE}/messages`, {
    method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  check('POST 202', post.status === 202);
  const { msgId } = await post.json();
  await new Promise((r2) => setTimeout(r2, 500));
  check('pushed over SSE', frames.length === 1 && frames[0].msgId === msgId && frames[0].ct === 'C', JSON.stringify(frames));

  const g1 = await (await fetch(`${BASE}/messages?recipient=${R}`, { headers: AUTH })).json();
  check('store retains after push (catch-up sees it)', g1.messages?.length === 1 && g1.messages[0].msgId === msgId);
  const del = await fetch(`${BASE}/messages/${msgId}`, { method: 'DELETE', headers: AUTH });
  check('DELETE 204', del.status === 204);
  const g2 = await (await fetch(`${BASE}/messages?recipient=${R}`, { headers: AUTH })).json();
  check('gone after DELETE', g2.messages?.length === 0);
  ctl.abort();
  await streamDone;
}
// 5b. gzip body, malformed bodies, ordering, isolation (hardening suite adds)
{
  const { gzipSync } = await import('node:zlib');
  const R2 = `contract-recipient-2-${Date.now()}`;
  const p1 = await fetch(`${BASE}/messages`, {
    method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipientCode: R2, ct: 'first', v: 1 }),
  });
  const gzBody = gzipSync(Buffer.from(JSON.stringify({ recipientCode: R2, ct: 'second', v: 1 })));
  const p2 = await fetch(`${BASE}/messages`, {
    method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: gzBody,
  });
  check('POST gzip 202', p2.status === 202, String(p2.status));
  const badGz = await fetch(`${BASE}/messages`, {
    method: 'POST', headers: { ...AUTH, 'Content-Encoding': 'gzip' }, body: 'not-gzip',
  });
  check('POST invalid gzip 400', badGz.status === 400, String(badGz.status));
  const badJson = await fetch(`${BASE}/messages`, { method: 'POST', headers: AUTH, body: '{nope' });
  check('POST invalid json 400', badJson.status === 400, String(badJson.status));
  const noRc = await fetch(`${BASE}/messages`, {
    method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 1 }),
  });
  check('POST missing recipientCode 400', noRc.status === 400, String(noRc.status));
  const id1 = (await p1.json()).msgId, id2 = (await p2.json()).msgId;
  const g = await (await fetch(`${BASE}/messages?recipient=${R2}`, { headers: AUTH })).json();
  check('GET oldest-first, gzip payload intact',
    g.messages?.length === 2 && g.messages[0].msgId === id1 && g.messages[1].msgId === id2 && g.messages[1].ct === 'second',
    JSON.stringify(g.messages?.map((m) => m.ct)));
  const iso = await (await fetch(`${BASE}/messages?recipient=nobody-${Date.now()}`, { headers: AUTH })).json();
  check('recipient isolation (empty for stranger)', iso.messages?.length === 0);
  for (const id of [id1, id2]) await fetch(`${BASE}/messages/${id}`, { method: 'DELETE', headers: AUTH });
}
// 5c. heartbeat (slow: opt in with HB=1)
if (process.env.HB === '1') {
  const ctl = new AbortController();
  const res = await fetch(`${BASE}/stream?recipient=hb-${Date.now()}`, { headers: AUTH, signal: ctl.signal });
  let sawHb = false;
  const t0 = Date.now();
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    if (dec.decode(chunk, { stream: true }).includes(': hb')) { sawHb = true; break; }
    if (Date.now() - t0 > 30000) break;
  }
  check('SSE heartbeat within 30s', sawHb);
  ctl.abort();
}
// 6. dormant auth endpoints 404 while Ghost unconfigured
{
  const c = await fetch(`${BASE}/connect`, {
    method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ connectCode: 'AAAA-AAAA', routingCode: 'r', confirmEvict: false }),
  });
  check('connect rejected while dormant (4xx, not 5xx/2xx)', c.status >= 400 && c.status < 500, String(c.status));
  const w = await fetch(`${BASE}/ghost-webhook`, { method: 'POST', body: '{}' });
  check('webhook 404 while dormant', w.status === 404, String(w.status));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
