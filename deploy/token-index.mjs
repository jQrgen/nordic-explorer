// Indexes Nexa token (group) activity from our own nexad and writes the token list ranked by transaction count.
// Usage: node token-index.mjs <state.json> <out.json>
// Env: NEXA_DATADIR (cookie location), NEXA_RPC (http://127.0.0.1:7227), ROSTRUM (127.0.0.1:20001)
import { readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { connect } from "node:net";

const [statePath = "nexa-token-state.json", out = "nexa-tokens.json"] = process.argv.slice(2);
const datadir = process.env.NEXA_DATADIR ?? "/mnt/HC_Volume_107087011/nexa";
const rpcUrl = process.env.NEXA_RPC ?? "http://127.0.0.1:7227";
const [rHost, rPort] = (process.env.ROSTRUM ?? "127.0.0.1:20001").split(":");
const CONFIRMATIONS = 6;
const auth = "Basic " + Buffer.from(readFileSync(`${datadir}/.cookie`, "utf8").trim()).toString("base64");

async function rpc(calls) {
  const res = await fetch(rpcUrl, { method: "POST", headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify(calls.map(([method, params], id) => ({ jsonrpc: "1.0", id, method, params }))) });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  return (await res.json()).sort((a, b) => a.id - b.id).map((r) => { if (r.error) throw new Error(r.error.message); return r.result; });
}

// state: height indexed, per-token counts, live token UTXOs (outpoint -> [group, address, quantity])
const s = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { height: -1, tokens: {}, utxos: {}, meta: {} };
const save = () => { writeFileSync(`${statePath}.tmp`, JSON.stringify(s)); renameSync(`${statePath}.tmp`, statePath); };
const isAuthority = (q) => typeof q === "number" && q < 0; // authority outputs carry negative groupQuantity

const [tip] = await rpc([["getblockcount", []]]);
const target = tip - CONFIRMATIONS;
const BATCH = 50;
let lastSave = Date.now();
for (let h = s.height + 1; h <= target; h += BATCH) {
  const heights = []; for (let i = h; i <= Math.min(target, h + BATCH - 1); i++) heights.push(i);
  const hashes = await rpc(heights.map((i) => ["getblockhash", [i]]));
  const blocks = await rpc(hashes.map((x) => ["getblock", [x, 2]]));
  for (const b of blocks) {
    for (const tx of b.tx) {
      const touched = new Set();
      for (const vin of tx.vin) {
        const u = vin.outpoint && s.utxos[vin.outpoint];
        if (u) { touched.add(u[0]); delete s.utxos[vin.outpoint]; }
      }
      for (const v of tx.vout) {
        const g = v.scriptPubKey?.group;
        if (!g) continue;
        touched.add(g);
        s.utxos[v.outpoint] = [g, v.scriptPubKey.addresses?.[0] ?? null, v.scriptPubKey.groupQuantity];
        if (!s.tokens[g]) s.tokens[g] = { txs: 0, height: b.height };
      }
      for (const g of touched) if (s.tokens[g]) s.tokens[g].txs++;
    }
    s.height = b.height;
  }
  if (Date.now() - lastSave > 60_000) { save(); lastSave = Date.now(); console.log(`height ${s.height}/${target}`); }
}
save();

// Names and tickers from rostrum's token.genesis.info. Failed lookups are not cached and entries
// without a name or ticker are retried each run (rostrum times out on busy tokens until warm).
function electrum(method, params) {
  return new Promise((resolve, reject) => {
    const c = connect(Number(rPort), rHost, () => c.write(JSON.stringify({ id: 1, method, params }) + "\n"));
    let buf = ""; c.setTimeout(15_000, () => { c.destroy(); reject(new Error("timeout")); });
    c.on("data", (d) => { buf += d; if (buf.includes("\n")) { c.end(); const r = JSON.parse(buf); if (r.error) reject(new Error(r.error.message)); else resolve(r.result); } });
    c.on("error", reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
for (const g of Object.keys(s.tokens)) {
  if (s.meta[g]?.name || s.meta[g]?.ticker || g.length > 66) continue; // skip subgroups (NFTs); parent groups are 66 chars
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { const i = await electrum("token.genesis.info", [g]); s.meta[g] = { name: i.name ?? null, ticker: i.ticker ?? null }; break; }
    catch { if (attempt < 3) await sleep(2_000 * attempt); else failed++; } // leave uncached so the next run retries
  }
}
if (failed) console.log(`${failed} token name lookups failed, will retry next run`);
save();

const holders = {};
for (const [g, addr, q] of Object.values(s.utxos)) if (addr && !isAuthority(q)) (holders[g] ??= new Set()).add(addr);
const list = Object.entries(s.tokens).filter(([g]) => g.length <= 66)
  .map(([id, t]) => ({ id, name: s.meta[id]?.name ?? null, ticker: s.meta[id]?.ticker ?? null, txs: t.txs, holders: holders[id]?.size ?? 0 }))
  .sort((a, b) => b.txs - a.txs);
writeFileSync(`${out}.tmp`, JSON.stringify({ source: "nexad", fetchedAt: new Date().toISOString(), lastBlock: s.height, tokens: list }));
renameSync(`${out}.tmp`, out);
console.log(`${list.length} tokens, block ${s.height}`);
