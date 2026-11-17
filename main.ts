// github-core-clone-01: a GitHub-compatible git forge in one process.
// Serves git smart HTTP (upload-pack v2, receive-pack v0), REST v3,
// GraphQL v4 and MCP from an in-memory store. Stdlib only, no git binary,
// no clock in state: every timestamp the store emits is a fixed constant,
// so two runs over the same request order leave identical state.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const ZERO_OID = '0000000000000000000000000000000000000000';
const AGENT = 'github-core-clone/1.0.0';
const VIEWER_LOGIN = 'adaiversen';
const VIEWER_ID = 1000;
const IDENTITY = 'Conformance <conformance@make.fun>';
// Fixed timestamps: the store never reads a wall clock.
const FIXED_EPOCH = 1739175597;
const FIXED_ISO = '2025-02-16T00:00:00Z';
const VERSION = '1.0.0';

// ------------------------------------------------------------------ store

interface Obj { type: string; data: Buffer }
interface Comment { id: number; body: string }
interface Issue {
  number: number; title: string; body: string; state: 'open' | 'closed';
  labels: string[]; comments: Comment[]; seq: number;
}
interface Pull {
  number: number; title: string; body: string; state: 'open' | 'closed';
  headRef: string; baseRef: string; headSha: string; baseSha: string;
  merged: boolean; mergedAt: string; mergeCommitSha: string | null; seq: number;
}
interface Label { name: string; color: string }
interface Repo {
  id: number; owner: string; name: string; description: string;
  private: boolean; defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number; nextComment: number; seq: number;
}

const objects = new Map<string, Obj>();
const repos = new Map<string, Repo>();
// Built fetch responses, keyed by the fetch parameters. Sound because a
// complete plan is a pure function of those parameters over immutable objects.
const fetchCache = new Map<string, Buffer>();
let nextRepoId = 1;
let nextReqId = 1;

function repoKey(owner: string, name: string): string { return `${owner}/${name}`; }
function findRepo(owner: string, name: string): Repo | undefined { return repos.get(repoKey(owner, name)); }
function createRepoRecord(owner: string, name: string, description: string, isPrivate: boolean): Repo {
  const repo: Repo = {
    id: nextRepoId++, owner, name, description, private: isPrivate,
    defaultBranch: 'main', refs: new Map(), labels: new Map(),
    issues: new Map(), pulls: new Map(), nextNumber: 1, nextComment: 1, seq: 0,
  };
  repos.set(repoKey(owner, name), repo);
  return repo;
}

// ------------------------------------------------------------------ objects

function sha1hex(data: Buffer): string { return createHash('sha1').update(data).digest('hex'); }
function objectId(type: string, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1hex(Buffer.concat([head, data]));
}
function storeObject(type: string, data: Buffer): string {
  const oid = objectId(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}
function getObject(oid: string): Obj | undefined { return objects.get(oid); }

interface CommitView { tree: string; parents: string[]; message: string; author: string; committer: string }
// Parsed commits are cached: objects are immutable, so a parse never goes stale.
const commitCache = new Map<string, CommitView>();
function commitViewOf(oid: string): CommitView | null {
  const hit = commitCache.get(oid);
  if (hit) return hit;
  const obj = getObject(oid);
  if (!obj || obj.type !== 'commit') return null;
  const view = parseCommit(obj.data);
  commitCache.set(oid, view);
  return view;
}
function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = ''; const parents: string[] = []; let author = ''; let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, message, author, committer };
}
function makeCommit(tree: string, parents: string[], message: string): string {
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${IDENTITY} ${FIXED_EPOCH} +0000`);
  lines.push(`committer ${IDENTITY} ${FIXED_EPOCH} +0000`);
  lines.push('', message.endsWith('\n') ? message : message + '\n');
  return storeObject('commit', Buffer.from(lines.join('\n'), 'utf8'));
}

interface TreeEntry { mode: string; name: string; oid: string }
function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const mode = data.subarray(i, sp).toString('ascii');
    const nul = data.indexOf(0, sp + 1);
    if (nul < 0) break;
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid });
    i = nul + 21;
  }
  return out;
}
function treeSortKey(e: TreeEntry): string { return e.mode === '40000' ? `${e.name}/` : e.name; }
function buildTree(entries: TreeEntry[]): string {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a); const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return storeObject('tree', Buffer.concat(parts));
}
function emptyTreeOid(): string { return storeObject('tree', Buffer.alloc(0)); }

function lookupPath(treeOid: string, path: string): { oid: string; mode: string } | null {
  if (path === '') return { oid: treeOid, mode: '40000' };
  const parts = path.split('/').filter((p) => p !== '');
  let cur = treeOid;
  for (let i = 0; i < parts.length; i++) {
    const obj = getObject(cur);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === parts[i]);
    if (!entry) return null;
    if (i === parts.length - 1) return { oid: entry.oid, mode: entry.mode };
    if (entry.mode !== '40000') return null;
    cur = entry.oid;
  }
  return null;
}
// Replace (or insert) one path in a tree, rebuilding parents bottom-up.
function treeWithPath(treeOid: string, path: string, blobOid: string | null): string {
  const parts = path.split('/').filter((p) => p !== '');
  if (parts.length === 0) return treeOid;
  const rec = (oid: string, depth: number): string => {
    const obj = getObject(oid);
    const entries: TreeEntry[] = obj && obj.type === 'tree' ? parseTree(obj.data) : [];
    const name = parts[depth];
    const last = depth === parts.length - 1;
    const idx = entries.findIndex((e) => e.name === name);
    if (last) {
      if (blobOid === null) {
        if (idx >= 0) entries.splice(idx, 1);
      } else if (idx >= 0) {
        entries[idx] = { mode: '100644', name, oid: blobOid };
      } else {
        entries.push({ mode: '100644', name, oid: blobOid });
      }
    } else {
      const child = idx >= 0 && entries[idx].mode === '40000' ? entries[idx].oid : emptyTreeOid();
      const next = rec(child, depth + 1);
      const childObj = getObject(next);
      const childEmpty = childObj !== undefined && childObj.type === 'tree' && childObj.data.length === 0;
      if (childEmpty) {
        if (idx >= 0) entries.splice(idx, 1);
      } else if (idx >= 0) {
        entries[idx] = { mode: '40000', name, oid: next };
      } else {
        entries.push({ mode: '40000', name, oid: next });
      }
    }
    return buildTree(entries);
  };
  return rec(treeOid, 0);
}
// Flat map of every blob (and gitlink) path under a tree.
function flattenTree(treeOid: string, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
  const obj = getObject(treeOid);
  if (!obj || obj.type !== 'tree') return;
  for (const e of parseTree(obj.data)) {
    const p = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') flattenTree(e.oid, p, out);
    else out.set(p, { oid: e.oid, mode: e.mode });
  }
}
function treeOfCommit(commitOid: string): string {
  return commitViewOf(commitOid)?.tree ?? emptyTreeOid();
}
function commitParents(commitOid: string): string[] {
  return commitViewOf(commitOid)?.parents ?? [];
}
// Walk commits from tips (BFS by generation), honouring a depth cap.
function walkCommits(tips: string[], maxDepth: number): Map<string, number> {
  const depth = new Map<string, number>();
  const queue: Array<{ oid: string; d: number }> = [];
  for (const t of tips) {
    if (!depth.has(t) && getObject(t)?.type === 'commit') { depth.set(t, 0); queue.push({ oid: t, d: 0 }); }
  }
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.d + 1 >= maxDepth) continue;
    for (const p of commitParents(cur.oid)) {
      if (!depth.has(p)) { depth.set(p, cur.d + 1); queue.push({ oid: p, d: cur.d + 1 }); }
    }
  }
  return depth;
}
function isAncestor(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>([descendant]);
  const stack = [descendant];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const p of commitParents(cur)) {
      if (p === ancestor) return true;
      if (!seen.has(p)) { seen.add(p); stack.push(p); }
    }
  }
  return false;
}
// Commits reachable from a tip, newest first (DFS pre-order, first parent first).
function listCommits(tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (oid: string): void => {
    if (seen.has(oid)) return;
    const view = commitViewOf(oid);
    if (!view) return;
    seen.add(oid);
    out.push(oid);
    for (const p of view.parents) visit(p);
  };
  visit(tip);
  return out;
}

// ------------------------------------------------------------------ packfiles

const OBJ_TYPE_CODE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const OBJ_CODE_TYPE: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePack(oids: string[]): Buffer {
  const sorted = [...new Set(oids)].sort();
  const chunks: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(sorted.length, 8);
  chunks.push(head);
  for (const oid of sorted) {
    const obj = getObject(oid);
    if (!obj) continue;
    const typeCode = OBJ_TYPE_CODE[obj.type];
    if (typeCode === undefined) continue;
    // Varint header: low 4 bits of size, then 7 bits per byte, type in bits 4-6.
    const hb: number[] = [];
    let s = obj.data.length;
    let b = (s & 0x0f) | (typeCode << 4);
    s >>>= 4;
    while (s > 0) { hb.push(b | 0x80); b = s & 0x7f; s >>>= 7; }
    hb.push(b);
    chunks.push(Buffer.from(hb));
    chunks.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(chunks);
  return Buffer.concat([body, Buffer.from(sha1hex(body), 'hex')]);
}

interface PackEntry { oid: string; type: string; data: Buffer }
// Reads a version-2 pack of plain objects (the client never sends deltas).
// Throws on a bad magic, version, checksum, or any delta entry.
function readPack(buf: Buffer): { objects: Map<string, PackEntry>; deltaCount: number } {
  const objects = new Map<string, PackEntry>();
  if (buf.length < 32) throw new Error('pack too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack magic');
  if (buf.readUInt32BE(4) !== 2) throw new Error('bad pack version');
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20).toString('hex');
  if (sha1hex(buf.subarray(0, buf.length - 20)) !== trailer) throw new Error('pack checksum mismatch');
  let off = 12;
  const readVarint = (): { value: number; type: number } => {
    let b = buf[off++];
    const type = (b >> 4) & 7;
    let value = b & 0x0f;
    let shift = 4;
    while (b & 0x80) { b = buf[off++]; value |= (b & 0x7f) << shift; shift += 7; }
    return { value, type };
  };
  for (let i = 0; i < count; i++) {
    const { value: _size, type: typeCode } = readVarint();
    void _size;
    if (typeCode === 6 || typeCode === 7) throw new Error('delta entries are not accepted');
    const type = OBJ_CODE_TYPE[typeCode];
    if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
    // One inflate tells us the stream's length (bytesRead); fall back to a
    // binary search when the engine does not report a usable length.
    let data: Buffer;
    let consumed = -1;
    try {
      const inflated = inflateSync(buf.subarray(off), { info: true }) as unknown as { buffer: Buffer; engine: { bytesRead?: number } };
      data = inflated.buffer as Buffer;
      const br = inflated.engine?.bytesRead;
      if (typeof br === 'number' && Number.isFinite(br) && br > 0 && off + br <= buf.length - 20) consumed = br;
    } catch {
      consumed = -1;
    }
    if (consumed < 0) {
      data = inflateSync(buf.subarray(off));
      let lo = off + 1; let hi = buf.length - 20; let best = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        try { inflateSync(buf.subarray(off, mid)); best = mid; hi = mid - 1; }
        catch { lo = mid + 1; }
      }
      if (best < 0) throw new Error('corrupt zlib stream in pack');
      consumed = best - off;
    }
    const oid = objectId(type, data);
    objects.set(oid, { oid, type, data });
    off += consumed;
  }
  return { objects, deltaCount: 0 };
}

// ------------------------------------------------------------------ pkt-line

function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');
const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');
void PKT_RESPONSE_END;

interface Pkt { kind: 'data' | 'flush' | 'delim' | 'response-end'; payload: Buffer }
function decodePktLines(buf: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = parseInt(buf.subarray(off, off + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) { packets.push({ kind: 'flush', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 1) { packets.push({ kind: 'delim', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 2) { packets.push({ kind: 'response-end', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len < 4 || off + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, rest: buf.subarray(off) };
}
function sidebandPackets(data: Buffer, band = 1): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < data.length; i += 65515) {
    out.push(pktLine(Buffer.concat([Buffer.from([band]), data.subarray(i, i + 65515)])));
  }
  if (data.length === 0) out.push(pktLine(Buffer.from([band])));
  return out;
}

// ------------------------------------------------------------------ git fetch selection

interface FetchPlan { objects: string[]; shallow: string[]; unshallow: string[]; complete: boolean }
function planFetch(wants: string[], haves: string[], shallowArgs: string[], depth: number | null): FetchPlan {
  const held = new Set<string>();
  {
    // Closure of haves, truncated at shallow boundaries (their parents are not held).
    const shallowSet = new Set(shallowArgs);
    const queue = [...haves];
    for (const h of haves) held.add(h);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (shallowSet.has(cur)) continue;
      for (const p of commitParents(cur)) {
        if (!held.has(p)) { held.add(p); queue.push(p); }
      }
    }
  }
  // Resolve tag wants to their target commits; tags themselves travel too.
  const tagOids: string[] = [];
  const commitWants: string[] = [];
  let complete = true;
  for (const w of wants) {
    const obj = getObject(w);
    if (!obj) { complete = false; continue; }
    if (obj.type === 'tag') {
      tagOids.push(w);
      const text = obj.data.toString('utf8');
      const m = /^object ([0-9a-f]{40})$/m.exec(text);
      if (m) {
        if (getObject(m[1])) commitWants.push(m[1]);
        else complete = false;
      } else complete = false;
    } else if (obj.type === 'commit') commitWants.push(w);
  }
  const maxDepth = depth === null ? Number.POSITIVE_INFINITY : depth;
  const wanted = walkCommits(commitWants, maxDepth);
  const newCommits: string[] = [];
  for (const oid of wanted.keys()) if (!held.has(oid)) newCommits.push(oid);
  const newSet = new Set(newCommits);
  const shallow: string[] = [];
  for (const c of newCommits) {
    const parents = commitParents(c);
    if (parents.length === 0) continue;
    if (parents.some((p) => !newSet.has(p) && !held.has(p))) shallow.push(c);
  }
  const unshallow: string[] = [];
  for (const s of shallowArgs) {
    if (!held.has(s)) continue;
    const parents = commitParents(s);
    if (parents.length > 0 && parents.every((p) => newSet.has(p) || held.has(p))) unshallow.push(s);
  }
  const oids = new Set<string>([...tagOids, ...newCommits]);
  // Objects the client already holds: the trees and blobs of every held
  // commit (a shallow boundary still carries its own tree). Never re-send.
  const heldObjects = new Set<string>();
  for (const h of held) addTreeObjects(treeOfCommit(h), heldObjects);
  for (const c of newCommits) addTreeObjects(treeOfCommit(c), oids);
  for (const oid of [...oids]) if (heldObjects.has(oid)) oids.delete(oid);
  return { objects: [...oids].sort(), shallow: shallow.sort(), unshallow: unshallow.sort(), complete };
}
// Every tree and blob oid under a tree (the tree oids included).
function addTreeObjects(treeOid: string, out: Set<string>): void {
  const obj = getObject(treeOid);
  if (!obj || obj.type !== 'tree') return;
  out.add(treeOid);
  for (const e of parseTree(obj.data)) {
    if (e.mode === '40000') addTreeObjects(e.oid, out);
    else if (e.mode !== '160000') out.add(e.oid); // gitlink: never shipped
  }
}

// ------------------------------------------------------------------ http plumbing

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, ctx: Ctx) => Promise<void>;
interface Ctx { segments: string[]; query: URLSearchParams; body: Buffer; rawPath: string }

function tokenOk(req: http.IncomingMessage): boolean {
  const envToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  const presented = auth.slice('Bearer '.length);
  if (presented === '') return false;
  if (envToken === '') return true;
  return presented === envToken;
}
function nextRequestId(): string { return `req-${nextReqId++}`; }
function sendJson(res: http.ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void {
  const body = status === 204 ? '' : JSON.stringify(value);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-GitHub-Request-Id': nextRequestId(),
    ...extra,
  };
  if (status !== 204) headers['Content-Length'] = String(Buffer.byteLength(body));
  res.writeHead(status, headers);
  res.end(body);
}
function sendRaw(res: http.ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': String(body.length),
    'X-GitHub-Request-Id': nextRequestId(),
  });
  res.end(body);
}
function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}
function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function parseJsonBody(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (body.length === 0) return { ok: true, value: {} };
  try { return { ok: true, value: JSON.parse(body.toString('utf8')) }; }
  catch { return { ok: false }; }
}
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function dec(s: string): string { try { return decodeURIComponent(s); } catch { return s; } }

// ------------------------------------------------------------------ REST views

let nextDbId = 1;
function issueView(i: Issue): Record<string, unknown> {
  return {
    id: i.seq * 100000 + i.number, number: i.number, title: i.title,
    body: i.body, state: i.state, labels: i.labels.map((n) => ({ name: n })),
    comments: i.comments.length,
  };
}
function pullView(p: Pull): Record<string, unknown> {
  return {
    id: p.seq * 100000 + p.number, number: p.number, title: p.title, body: p.body,
    state: p.state === 'open' ? 'open' : 'closed',
    head: { ref: p.headRef, sha: p.headSha }, base: { ref: p.baseRef, sha: p.baseSha },
    merged: p.merged, merged_at: p.merged ? p.mergedAt : null,
    merge_commit_sha: p.mergeCommitSha,
  };
}
function repoView(r: Repo): Record<string, unknown> {
  return {
    id: r.id, name: r.name, full_name: `${r.owner}/${r.name}`,
    owner: { login: r.owner }, private: r.private, description: r.description,
    default_branch: r.defaultBranch, html_url: `https://example.invalid/${r.owner}/${r.name}`,
  };
}
function authorView(line: string): Record<string, unknown> {
  const m = /^(.*?) <([^>]*)> (\d+) ([+-]\d+)$/.exec(line);
  if (!m) return { name: '', email: '', date: FIXED_ISO };
  return { name: m[1], email: m[2], date: new Date(Number(m[3]) * 1000).toISOString() };
}
function commitView(oid: string): Record<string, unknown> {
  const obj = getObject(oid);
  if (!obj) return { sha: oid, commit: { message: '' } };
  const c = parseCommit(obj.data);
  return {
    sha: oid,
    commit: {
      message: c.message.replace(/\n$/, ''),
      author: authorView(c.author), committer: authorView(c.committer),
    },
    parents: c.parents.map((p) => ({ sha: p })),
  };
}

function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}
function resolveRef(repo: Repo, ref: string): string | null {
  if (repo.refs.has(ref)) return repo.refs.get(ref) ?? null;
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`) ?? null;
  if (repo.refs.has(`refs/tags/${ref}`)) return repo.refs.get(`refs/tags/${ref}`) ?? null;
  if (/^[0-9a-f]{40}$/.test(ref) && getObject(ref)) return ref;
  return null;
}
function diffFiles(baseTree: string, headTree: string): Array<Record<string, unknown>> {
  const a = new Map<string, { oid: string; mode: string }>();
  const b = new Map<string, { oid: string; mode: string }>();
  flattenTree(baseTree, '', a);
  flattenTree(headTree, '', b);
  const out: Array<Record<string, unknown>> = [];
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
  for (const p of paths) {
    const ea = a.get(p); const eb = b.get(p);
    if (ea && eb && ea.oid === eb.oid) continue;
    const countLines = (oid: string | undefined): string[] => {
      if (!oid) return [];
      const o = getObject(oid);
      if (!o || o.type !== 'blob') return [];
      const t = o.data.toString('utf8');
      return t === '' ? [] : t.split('\n').filter((_, i, arr) => !(i === arr.length - 1 && arr[i] === ''));
    };
    if (!ea && eb) {
      const lines = countLines(eb.oid);
      out.push({ filename: p, status: 'added', additions: lines.length, deletions: 0, changes: lines.length });
    } else if (ea && !eb) {
      const lines = countLines(ea.oid);
      out.push({ filename: p, status: 'removed', additions: 0, deletions: lines.length, changes: lines.length });
    } else if (ea && eb) {
      const la = countLines(ea.oid); const lb = countLines(eb.oid);
      const countMap = (xs: string[]): Map<string, number> => {
        const m = new Map<string, number>();
        for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
        return m;
      };
      const ma = countMap(la); const mb = countMap(lb);
      let additions = 0; let deletions = 0;
      for (const [line, n] of mb) additions += Math.max(0, n - (ma.get(line) ?? 0));
      for (const [line, n] of ma) deletions += Math.max(0, n - (mb.get(line) ?? 0));
      if (additions === 0 && deletions === 0) { additions = 1; deletions = 1; }
      out.push({ filename: p, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}
function prConflict(p: Pull, repo: Repo): boolean {
  if (p.state !== 'open') return true;
  const baseTip = branchTip(repo, p.baseRef);
  if (baseTip === null || baseTip === p.baseSha) return false;
  const baseFiles = diffFiles(treeOfCommit(p.baseSha), treeOfCommit(baseTip));
  const headFiles = diffFiles(treeOfCommit(p.baseSha), treeOfCommit(p.headSha));
  const changedByBase = new Map<string, string>();
  for (const f of baseFiles) changedByBase.set(String(f.filename), String(f.status));
  for (const f of headFiles) {
    const name = String(f.filename);
    if (!changedByBase.has(name)) continue;
    // Same path changed on both sides with different resulting content.
    const headFlat = new Map<string, { oid: string; mode: string }>();
    const baseFlat = new Map<string, { oid: string; mode: string }>();
    flattenTree(treeOfCommit(p.headSha), '', headFlat);
    flattenTree(treeOfCommit(baseTip), '', baseFlat);
    const h = headFlat.get(name)?.oid; const b = baseFlat.get(name)?.oid;
    if (h !== b) return true;
  }
  return false;
}

// ------------------------------------------------------------------ REST router

async function handleRest(req: http.IncomingMessage, res: http.ServerResponse, ctx: Ctx): Promise<void> {
  const method = req.method ?? 'GET';
  const seg = ctx.segments;
  if (!tokenOk(req)) { sendError(res, 401, 'Bad credentials'); return; }
  const needJson = ['POST', 'PUT', 'PATCH'].includes(method);
  let bodyValue: unknown = {};
  if (needJson) {
    const parsed = parseJsonBody(ctx.body);
    if (!parsed.ok) { sendError(res, 400, 'Invalid JSON body'); return; }
    bodyValue = parsed.value;
  }
  const body = isObj(bodyValue) ? bodyValue : {};

  // GET /api/v3/ and /api/v3/meta and /api/v3/user
  if (seg.length === 0) {
    if (method === 'GET') { sendJson(res, 200, {}, { 'X-OAuth-Scopes': 'repo, read:org' }); return; }
    sendError(res, 404, 'Not Found'); return;
  }
  if (seg.length === 1 && seg[0] === 'meta') {
    if (method === 'GET') { sendJson(res, 200, { installed_version: VERSION }); return; }
    sendError(res, 404, 'Not Found'); return;
  }
  if (seg.length === 1 && seg[0] === 'user') {
    if (method === 'GET') {
      sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, name: 'ada iversen', email: 'adaiversen@example.invalid', type: 'User' });
      return;
    }
    sendError(res, 404, 'Not Found'); return;
  }
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'GET') {
      const all = [...repos.values()].filter((r) => r.owner === VIEWER_LOGIN).sort((a, b) => a.seq - b.seq || a.id - b.id);
      const perPage = Math.max(1, Math.min(100, Number(ctx.query.get('per_page') ?? '30') || 30));
      const page = Math.max(1, Number(ctx.query.get('page') ?? '1') || 1);
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage);
      const links: string[] = [];
      const host = req.headers.host ?? '127.0.0.1';
      const base = `http://${host}/api/v3/user/repos?per_page=${perPage}`;
      if (start + perPage < all.length) links.push(`<${base}&page=${page + 1}>; rel="next"`);
      if (page > 1) links.push(`<${base}&page=${page - 1}>; rel="prev"`);
      links.push(`<${base}&page=1>; rel="first"`);
      const lastPage = Math.max(1, Math.ceil(all.length / perPage));
      links.push(`<${base}&page=${lastPage}>; rel="last"`);
      sendJson(res, 200, slice.map(repoView), { Link: links.join(', ') });
      return;
    }
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') { sendError(res, 422, 'name is required'); return; }
      if (findRepo(VIEWER_LOGIN, name)) { sendError(res, 422, 'Repository already exists'); return; }
      const repo = createRepoRecord(
        VIEWER_LOGIN, name,
        typeof body.description === 'string' ? body.description : '',
        body.private === true,
      );
      repo.seq = nextRepoId;
      sendJson(res, 201, repoView(repo));
      return;
    }
    sendError(res, 404, 'Not Found'); return;
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (seg.length >= 3 && seg[0] === 'repos') {
    const owner = seg[1]; const name = seg[2];
    const rest = seg.slice(3);
    const repo = findRepo(owner, name);
    if (owner !== VIEWER_LOGIN || !repo) { sendError(res, 404, 'Not Found'); return; }

    if (rest.length === 0) {
      if (method === 'GET') { sendJson(res, 200, repoView(repo)); return; }
      if (method === 'PATCH') {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        sendJson(res, 200, repoView(repo)); return;
      }
      if (method === 'DELETE') { repos.delete(repoKey(owner, name)); res.writeHead(204, { 'X-GitHub-Request-Id': nextRequestId() }); res.end(); return; }
      sendError(res, 404, 'Not Found'); return;
    }

    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha) || !getObject(sha)) {
          sendError(res, 422, 'Invalid ref or sha'); return;
        }
        if (repo.refs.has(ref)) { sendError(res, 422, 'Reference already exists'); return; }
        repo.refs.set(ref, sha);
        const obj = getObject(sha)!;
        sendJson(res, 201, { ref, object: { sha, type: obj.type } });
        return;
      }
      if (method === 'GET' && rest.length === 2) {
        const all = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([ref, sha]) => ({ ref, object: { sha, type: getObject(sha)?.type ?? 'commit' } }));
        sendJson(res, 200, all); return;
      }
      if (method === 'GET' && rest.length >= 3) {
        const ref = rest.slice(2).join('/');
        const sha = repo.refs.get(ref);
        if (!sha) { sendError(res, 404, 'Not Found'); return; }
        sendJson(res, 200, { ref, object: { sha, type: getObject(sha)?.type ?? 'commit' } });
        return;
      }
      sendError(res, 404, 'Not Found'); return;
    }

    if (rest[0] === 'branches') {
      if (method === 'GET' && rest.length === 1) {
        const out = [...repo.refs.entries()]
          .filter(([r]) => r.startsWith('refs/heads/'))
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([r, sha]) => ({ name: r.slice('refs/heads/'.length), commit: { sha }, protected: false }));
        sendJson(res, 200, out); return;
      }
      if (method === 'GET' && rest.length >= 2) {
        const branch = rest.slice(1).join('/');
        const sha = branchTip(repo, branch);
        if (!sha) { sendError(res, 404, 'Not Found'); return; }
        sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
        return;
      }
      sendError(res, 404, 'Not Found'); return;
    }

    if (rest[0] === 'commits') {
      if (method === 'GET') {
        const ref = ctx.query.get('sha') ?? repo.defaultBranch;
        const tip = resolveRef(repo, ref);
        if (!tip) { sendJson(res, 200, []); return; }
        sendJson(res, 200, listCommits(tip).map(commitView));
        return;
      }
      sendError(res, 404, 'Not Found'); return;
    }

    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      const branch = typeof body.branch === 'string' ? body.branch : (ctx.query.get('ref') ?? repo.defaultBranch);
      if (method === 'GET') {
        const tip = branchTip(repo, branch);
        if (!tip) { sendError(res, 404, 'Not Found'); return; }
        const tree = treeOfCommit(tip);
        const found = lookupPath(tree, path);
        if (!found) { sendError(res, 404, 'Not Found'); return; }
        if (found.mode === '40000') {
          const obj = getObject(found.oid);
          const entries = obj ? parseTree(obj.data).map((e) => ({
            type: e.mode === '40000' ? 'dir' : 'file',
            name: e.name, path: path === '' ? e.name : `${path}/${e.name}`, sha: e.oid,
          })) : [];
          sendJson(res, 200, entries); return;
        }
        const blob = getObject(found.oid);
        const data = blob ? blob.data : Buffer.alloc(0);
        sendJson(res, 200, {
          type: 'file', encoding: 'base64', size: data.length,
          name: path.split('/').pop() ?? '', path, sha: found.oid,
          content: data.toString('base64'),
        });
        return;
      }
      if (method === 'PUT') {
        const message = typeof body.message === 'string' ? body.message : 'update';
        const contentB64 = typeof body.content === 'string' ? body.content : '';
        let content: Buffer;
        try { content = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64'); }
        catch { sendError(res, 422, 'Invalid base64 content'); return; }
        let tip = branchTip(repo, branch);
        if (tip === null) {
          // Create the branch from the default branch tip (or unborn).
          const base = branchTip(repo, repo.defaultBranch);
          if (base !== null) { repo.refs.set(`refs/heads/${branch}`, base); tip = base; }
        }
        const tree = tip ? treeOfCommit(tip) : emptyTreeOid();
        const existing = lookupPath(tree, path);
        if (typeof body.sha === 'string') {
          if (!existing || existing.oid !== body.sha) { sendError(res, 409, 'sha does not match'); return; }
        } else if (existing) {
          sendError(res, 409, 'file already exists'); return;
        }
        const blobOid = storeObject('blob', content);
        const newTree = treeWithPath(tree, path, blobOid);
        const commit = makeCommit(newTree, tip ? [tip] : [], message);
        repo.refs.set(`refs/heads/${branch}`, commit);
        sendJson(res, existing ? 200 : 201, {
          content: { sha: blobOid, encoding: 'base64' }, commit: { sha: commit },
        });
        return;
      }
      if (method === 'DELETE') {
        const message = typeof body.message === 'string' ? body.message : 'delete';
        const tip = branchTip(repo, branch);
        if (!tip) { sendError(res, 404, 'Not Found'); return; }
        const tree = treeOfCommit(tip);
        const existing = lookupPath(tree, path);
        if (!existing || existing.mode === '40000') { sendError(res, 404, 'Not Found'); return; }
        if (typeof body.sha === 'string' && existing.oid !== body.sha) {
          sendError(res, 409, 'sha does not match'); return;
        }
        const newTree = treeWithPath(tree, path, null);
        const commit = makeCommit(newTree, [tip], message);
        repo.refs.set(`refs/heads/${branch}`, commit);
        sendJson(res, 200, { commit: { sha: commit } });
        return;
      }
      sendError(res, 404, 'Not Found'); return;
    }

    if (rest[0] === 'labels') {
      if (method === 'GET') { sendJson(res, 200, [...repo.labels.values()]); return; }
      if (method === 'POST') {
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '') { sendError(res, 422, 'name is required'); return; }
        if (repo.labels.has(name)) { sendError(res, 422, 'Label already exists'); return; }
        const label: Label = { name, color: typeof body.color === 'string' ? body.color : 'ededed' };
        repo.labels.set(name, label);
        sendJson(res, 201, label); return;
      }
      sendError(res, 404, 'Not Found'); return;
    }

    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          const sort = ctx.query.get('sort') ?? 'created';
          const direction = ctx.query.get('direction') ?? 'desc';
          void sort;
          let list = [...repo.issues.values()];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          list.sort((a, b) => direction === 'asc' ? a.number - b.number : b.number - a.number);
          sendJson(res, 200, list.map(issueView)); return;
        }
        if (method === 'POST') {
          const title = typeof body.title === 'string' ? body.title : '';
          if (title === '') { sendError(res, 422, 'title is required'); return; }
          const rawLabels = Array.isArray(body.labels) ? body.labels : [];
          const labels: string[] = [];
          for (const l of rawLabels) {
            const nm = typeof l === 'string' ? l : isObj(l) && typeof l.name === 'string' ? l.name : '';
            if (nm === '' || !repo.labels.has(nm)) { sendError(res, 422, `Label does not exist: ${nm}`); return; }
            labels.push(nm);
          }
          const number = repo.nextNumber++;
          const issue: Issue = {
            number, title, body: typeof body.body === 'string' ? body.body : '',
            state: 'open', labels, comments: [], seq: nextDbId++,
          };
          repo.issues.set(number, issue);
          sendJson(res, 201, issueView(issue)); return;
        }
        sendError(res, 404, 'Not Found'); return;
      }
      const num = Number(rest[1]);
      if (!Number.isInteger(num)) { sendError(res, 404, 'Not Found'); return; }
      const issue = repo.issues.get(num);
      if (rest.length === 2) {
        if (!issue) { sendError(res, 404, 'Not Found'); return; }
        if (method === 'GET') { sendJson(res, 200, issueView(issue)); return; }
        if (method === 'PATCH') {
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          sendJson(res, 200, issueView(issue)); return;
        }
        sendError(res, 404, 'Not Found'); return;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue) { sendError(res, 404, 'Not Found'); return; }
        if (method === 'GET') { sendJson(res, 200, issue.comments); return; }
        if (method === 'POST') {
          const text = typeof body.body === 'string' ? body.body : '';
          if (text === '') { sendError(res, 422, 'body is required'); return; }
          const comment: Comment = { id: nextDbId++, body: text };
          issue.comments.push(comment);
          sendJson(res, 201, comment); return;
        }
        sendError(res, 404, 'Not Found'); return;
      }
      sendError(res, 404, 'Not Found'); return;
    }

    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          let list = [...repo.pulls.values()];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, b) => b.number - a.number);
          sendJson(res, 200, list.map(pullView)); return;
        }
        if (method === 'POST') {
          const title = typeof body.title === 'string' ? body.title : '';
          const head = typeof body.head === 'string' ? body.head : '';
          const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
          if (title === '' || head === '') { sendError(res, 422, 'title and head are required'); return; }
          const headSha = branchTip(repo, head);
          const baseSha = branchTip(repo, base);
          if (!headSha || !baseSha) { sendError(res, 422, 'head or base branch does not exist'); return; }
          const number = repo.nextNumber++;
          const pull: Pull = {
            number, title, body: typeof body.body === 'string' ? body.body : '',
            state: 'open', headRef: head, baseRef: base, headSha, baseSha,
            merged: false, mergedAt: '', mergeCommitSha: null, seq: nextDbId++,
          };
          repo.pulls.set(number, pull);
          sendJson(res, 201, pullView(pull)); return;
        }
        sendError(res, 404, 'Not Found'); return;
      }
      const num = Number(rest[1]);
      if (!Number.isInteger(num)) { sendError(res, 404, 'Not Found'); return; }
      const pull = repo.pulls.get(num);
      if (!pull) { sendError(res, 404, 'Not Found'); return; }
      if (rest.length === 2) {
        if (method === 'GET') { sendJson(res, 200, pullView(pull)); return; }
        sendError(res, 404, 'Not Found'); return;
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (method === 'GET') {
          sendJson(res, 200, diffFiles(treeOfCommit(pull.baseSha), treeOfCommit(pull.headSha)));
          return;
        }
        sendError(res, 404, 'Not Found'); return;
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (method === 'PUT') {
          if (pull.state !== 'open' || pull.merged) { sendError(res, 405, 'Pull request is already closed'); return; }
          if (prConflict(pull, repo)) { sendError(res, 405, 'Merge conflict'); return; }
          const baseTip = branchTip(repo, pull.baseRef);
          if (!baseTip) { sendError(res, 422, 'base branch does not exist'); return; }
          const message = typeof body.message === 'string' ? body.message : pull.title;
          const mergeCommit = makeCommit(treeOfCommit(pull.headSha), [baseTip], message);
          repo.refs.set(`refs/heads/${pull.baseRef}`, mergeCommit);
          pull.state = 'closed';
          pull.merged = true;
          pull.mergedAt = FIXED_ISO;
          pull.mergeCommitSha = mergeCommit;
          sendJson(res, 200, { sha: mergeCommit, merged: true, message });
          return;
        }
        sendError(res, 404, 'Not Found'); return;
      }
      sendError(res, 404, 'Not Found'); return;
    }
    sendError(res, 404, 'Not Found'); return;
  }

  sendError(res, 404, 'Not Found');
}

// ------------------------------------------------------------------ git smart HTTP

function refLinesV0(repo: Repo): Array<{ oid: string; name: string; peeled?: string }> {
  const out: Array<{ oid: string; name: string; peeled?: string }> = [];
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (tip) out.push({ oid: tip, name: 'HEAD' });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    out.push({ oid, name });
    const obj = getObject(oid);
    if (obj && obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (m) out.push({ oid: m[1], name: `${name}^{}` });
    }
  }
  return out;
}
function advertiseV2(): Buffer {
  const parts: Buffer[] = [
    pktLine('# service=git-upload-pack\n'), PKT_FLUSH,
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`agent=${AGENT}\n`),
    PKT_FLUSH,
  ];
  return Buffer.concat(parts);
}
function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? `side-band-64k thin-pack ofs-delta multi_ack shallow agent=${AGENT} object-format=sha1 symref=HEAD:refs/heads/${repo.defaultBranch}`
    : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} object-format=sha1 symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = refLinesV0(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((r, i) => {
      const line = i === 0 ? `${r.oid} ${r.name}\0${caps}\n` : `${r.oid} ${r.name}\n`;
      parts.push(pktLine(line));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}
function lsRefsResponse(repo: Repo, args: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): Buffer {
  const parts: Buffer[] = [];
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const hasRefs = repo.refs.size > 0;
  if (!hasRefs) {
    if (keep('HEAD') && args.unborn) parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
  } else {
    if (tip && keep('HEAD')) {
      parts.push(pktLine(args.symrefs ? `${tip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n` : `${tip} HEAD\n`));
    }
    const names = [...repo.refs.keys()].sort();
    for (const name of names) {
      if (!keep(name)) continue;
      const oid = repo.refs.get(name)!;
      let line = `${oid} ${name}`;
      if (args.peel) {
        const obj = getObject(oid);
        if (obj && obj.type === 'tag') {
          const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
          if (m) line += ` peeled:${m[1]}`;
        }
      }
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}
function fetchV2Response(plan: FetchPlan): Buffer {
  const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n')];
  const hasShallow = plan.shallow.length > 0 || plan.unshallow.length > 0;
  if (hasShallow) {
    parts.push(PKT_DELIM);
    parts.push(pktLine('shallow-info\n'));
    for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(PKT_DELIM);
  }
  if (plan.objects.length > 0) {
    if (!hasShallow) parts.push(PKT_DELIM);
    parts.push(pktLine('packfile\n'));
    const pack = writePack(plan.objects);
    for (const p of sidebandPackets(pack)) parts.push(p);
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}
function parseV2Args(packets: Pkt[]): { command: string; args: string[] } {
  let command = '';
  const args: string[] = [];
  let afterDelim = false;
  for (const p of packets) {
    if (p.kind === 'flush') break;
    if (p.kind === 'delim') { afterDelim = true; continue; }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
    } else args.push(line);
  }
  return { command, args };
}

async function handleGit(req: http.IncomingMessage, res: http.ServerResponse, ctx: Ctx): Promise<void> {
  const method = req.method ?? 'GET';
  const seg = ctx.segments;
  if (!tokenOk(req)) { sendError(res, 401, 'Bad credentials'); return; }
  // /{owner}/{repo}.git/...
  const gitIdx = seg.findIndex((p) => p.endsWith('.git'));
  if (gitIdx < 0) { sendError(res, 404, 'Not Found'); return; }
  const repoName = seg[gitIdx].slice(0, -4);
  const owner = gitIdx > 0 ? seg[gitIdx - 1] : VIEWER_LOGIN;
  const repo = findRepo(owner, dec(repoName));
  const tail = seg.slice(gitIdx + 1);
  if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
    const service = ctx.query.get('service') ?? '';
    if (!repo) { sendError(res, 404, 'Not Found'); return; }
    if (service === 'git-upload-pack') {
      const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      sendRaw(res, 200, v2 ? advertiseV2() : advertiseV0(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
      return;
    }
    if (service === 'git-receive-pack') {
      sendRaw(res, 200, advertiseV0(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
      return;
    }
    sendError(res, 400, 'Missing service parameter'); return;
  }
  if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
    if (!repo) { sendError(res, 404, 'Not Found'); return; }
    const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    const { packets } = decodePktLines(ctx.body);
    if (v2) {
      const { command, args } = parseV2Args(packets);
      if (command === 'ls-refs') {
        const opts = { peel: false, symrefs: false, unborn: false, prefixes: [] as string[] };
        for (const a of args) {
          if (a === 'peel') opts.peel = true;
          else if (a === 'symrefs') opts.symrefs = true;
          else if (a === 'unborn') opts.unborn = true;
          else if (a.startsWith('ref-prefix ')) opts.prefixes.push(a.slice('ref-prefix '.length));
        }
        sendRaw(res, 200, lsRefsResponse(repo, opts), 'application/x-git-upload-pack-result');
        return;
      }
      if (command === 'fetch') {
        const wants: string[] = []; const haves: string[] = [];
        const shallowArgs: string[] = []; let depth: number | null = null;
        for (const a of args) {
          if (a.startsWith('want ')) wants.push(a.slice(5).trim());
          else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
          else if (a.startsWith('shallow ')) shallowArgs.push(a.slice(8).trim());
          else if (a.startsWith('deepen ')) { const n = Number(a.slice(7).trim()); if (Number.isInteger(n) && n > 0) depth = n; }
        }
        // The fetch response is a pure function of its parameters over the
        // immutable object graph, so a complete plan's response is cached.
        const cacheKey = `f:${[...wants].sort().join(',')}|${[...haves].sort().join(',')}|${[...shallowArgs].sort().join(',')}|${depth ?? ''}`;
        const cached = fetchCache.get(cacheKey);
        if (cached) {
          sendRaw(res, 200, cached, 'application/x-git-upload-pack-result');
          return;
        }
        const plan = planFetch(wants, haves, shallowArgs, depth);
        const response = fetchV2Response(plan);
        if (plan.complete) {
          if (fetchCache.size >= 256) {
            const oldest = fetchCache.keys().next();
            if (!oldest.done) fetchCache.delete(oldest.value);
          }
          fetchCache.set(cacheKey, response);
        }
        sendRaw(res, 200, response, 'application/x-git-upload-pack-result');
        return;
      }
      sendRaw(res, 200, Buffer.concat([pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_FLUSH]), 'application/x-git-upload-pack-result');
      return;
    }
    // Protocol v0 fetch: NAK, optional shallow lines, then the sideband pack.
    const wants: string[] = []; const haves: string[] = [];
    const shallowArgs: string[] = []; let depth: number | null = null;
    let inSecondSection = false;
    for (const p of packets) {
      if (p.kind === 'flush') { inSecondSection = true; continue; }
      if (p.kind !== 'data') continue;
      const line = p.payload.toString('utf8').replace(/\n$/, '');
      if (!inSecondSection) {
        if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]);
        else if (line.startsWith('shallow ')) shallowArgs.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) { const n = Number(line.slice(7).trim()); if (Number.isInteger(n) && n > 0) depth = n; }
      } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    }
    const plan = planFetch(wants, haves, shallowArgs, depth);
    const parts: Buffer[] = [];
    for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(pktLine('NAK\n'));
    if (plan.objects.length > 0) {
      const pack = writePack(plan.objects);
      for (const p of sidebandPackets(pack)) parts.push(p);
    }
    parts.push(PKT_FLUSH);
    sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    return;
  }
  if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
    if (!repo) { sendError(res, 404, 'Not Found'); return; }
    const report = (lines: string[]): Buffer => {
      const parts: Buffer[] = [];
      for (const line of lines) parts.push(pktLine(Buffer.concat([Buffer.from([1]), pktLine(`${line}\n`)])));
      parts.push(PKT_FLUSH);
      return Buffer.concat(parts);
    };
    const { packets, rest } = decodePktLines(ctx.body);
    const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
    let malformed = false;
    for (const p of packets) {
      if (p.kind === 'flush') break;
      if (p.kind !== 'data') continue;
      const text = p.payload.toString('utf8').replace(/\n$/, '');
      const nul = text.indexOf('\0');
      const head = nul >= 0 ? text.slice(0, nul) : text;
      const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/\S+)$/.exec(head);
      if (!m) { malformed = true; break; }
      commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
    }
    if (malformed || commands.length === 0) {
      sendRaw(res, 200, report(['unpack error malformed command list']), 'application/x-git-receive-pack-result');
      return;
    }
    const needsPack = commands.some((c) => c.newOid !== ZERO_OID);
    if (needsPack) {
      if (rest.length === 0) {
        sendRaw(res, 200, report(['unpack error missing packfile']), 'application/x-git-receive-pack-result');
        return;
      }
      try {
        const { objects: packObjects } = readPack(rest);
        for (const entry of packObjects.values()) {
          if (!objects.has(entry.oid)) objects.set(entry.oid, { type: entry.type, data: entry.data });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'pack error';
        sendRaw(res, 200, report([`unpack error ${msg}`]), 'application/x-git-receive-pack-result');
        return;
      }
    }
    const lines: string[] = ['unpack ok'];
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        if (current === undefined) lines.push(`ng ${cmd.ref} remote ref does not exist`);
        else { repo.refs.delete(cmd.ref); lines.push(`ok ${cmd.ref}`); }
        continue;
      }
      if (cmd.oldOid === ZERO_OID) {
        if (current !== undefined) { lines.push(`ng ${cmd.ref} already exists`); continue; }
        const obj = getObject(cmd.newOid);
        const okType = cmd.ref.startsWith('refs/tags/')
          ? obj?.type === 'tag' || obj?.type === 'commit'
          : obj?.type === 'commit';
        if (!obj || !okType) { lines.push(`ng ${cmd.ref} invalid object`); continue; }
        repo.refs.set(cmd.ref, cmd.newOid);
        lines.push(`ok ${cmd.ref}`);
        continue;
      }
      if (current === undefined) { lines.push(`ng ${cmd.ref} remote ref does not exist`); continue; }
      if (current !== cmd.oldOid) { lines.push(`ng ${cmd.ref} stale old value`); continue; }
      if (cmd.newOid === cmd.oldOid) { lines.push(`ok ${cmd.ref}`); continue; }
      const obj = getObject(cmd.newOid);
      const okType = cmd.ref.startsWith('refs/tags/')
        ? obj?.type === 'tag' || obj?.type === 'commit'
        : obj?.type === 'commit';
      if (!obj || !okType) { lines.push(`ng ${cmd.ref} invalid object`); continue; }
      if (!isAncestor(cmd.oldOid, cmd.newOid)) { lines.push(`ng ${cmd.ref} non-fast-forward`); continue; }
      repo.refs.set(cmd.ref, cmd.newOid);
      lines.push(`ok ${cmd.ref}`);
    }
    sendRaw(res, 200, report(lines), 'application/x-git-receive-pack-result');
    return;
  }
  sendError(res, 404, 'Not Found');
}

// ------------------------------------------------------------------ GraphQL

function gid(kind: string, rest: string): string {
  return Buffer.from(`${kind}:${rest}`, 'utf8').toString('base64');
}
function gidRepo(r: Repo): string { return gid('Repository', `${r.owner}/${r.name}`); }
function gidIssue(r: Repo, n: number): string { return gid('Issue', `${r.owner}/${r.name}#${n}`); }
function gidPull(r: Repo, n: number): string { return gid('PullRequest', `${r.owner}/${r.name}#${n}`); }
function gidComment(r: Repo, n: number, id: number): string { return gid('IssueComment', `${r.owner}/${r.name}#${n}:c${id}`); }
function parseGid(id: string): { kind: string; rest: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const i = text.indexOf(':');
    if (i < 0) return null;
    return { kind: text.slice(0, i), rest: text.slice(i + 1) };
  } catch { return null; }
}
function findByGid(id: string): { kind: string; repo: Repo; issue?: Issue; pull?: Pull; comment?: Comment } | null {
  const parsed = parseGid(id);
  if (!parsed) return null;
  const { kind, rest } = parsed;
  const hash = rest.indexOf('#');
  const ownerName = hash < 0 ? rest : rest.slice(0, hash);
  const slash = ownerName.indexOf('/');
  if (slash < 0) return null;
  const repo = findRepo(ownerName.slice(0, slash), ownerName.slice(slash + 1));
  if (!repo) return null;
  if (kind === 'Repository') return { kind, repo };
  const tail = hash < 0 ? '' : rest.slice(hash + 1);
  const colon = tail.indexOf(':');
  const num = Number(colon < 0 ? tail : tail.slice(0, colon));
  if (!Number.isInteger(num)) return null;
  if (kind === 'Issue') {
    const issue = repo.issues.get(num);
    return issue ? { kind, repo, issue } : null;
  }
  if (kind === 'PullRequest') {
    const pull = repo.pulls.get(num);
    return pull ? { kind, repo, pull } : null;
  }
  if (kind === 'IssueComment') {
    const issue = repo.issues.get(num);
    const comment = issue?.comments.find((c) => tail.slice(colon + 1) === `c${c.id}`);
    return issue && comment ? { kind, repo, issue, comment } : null;
  }
  return null;
}
function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}
function cursorIndex(cursor: string): number {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : -1;
  } catch { return -1; }
}
function pageInfoFor(total: number, start: number, end: number): Record<string, unknown> {
  return {
    hasNextPage: end < total,
    hasPreviousPage: start > 0,
    startCursor: end > start ? cursorOf(start) : null,
    endCursor: end > start ? cursorOf(end - 1) : null,
  };
}

// --- minimal GraphQL document parser (queries + mutations, variables,
// --- literals, aliases, inline fragments). Named fragments are rejected.
type GqlValue = string | number | boolean | null | GqlValue[] | { [k: string]: GqlValue };
interface GqlField { kind: 'field'; name: string; alias: string; args: Record<string, GqlValue>; sel: GqlSelection[] | null }
interface GqlFrag { kind: 'fragment'; typeCondition: string | null; sel: GqlSelection[] }
type GqlSelection = GqlField | GqlFrag;
interface GqlOp { operation: 'query' | 'mutation'; vars: Record<string, GqlValue>; sel: GqlSelection[] }

class GqlParseError extends Error {}
class GqlUnknownField extends Error {
  typeName: string; field: string;
  constructor(typeName: string, field: string) {
    super(`Cannot query field "${field}" on type "${typeName}".`);
    this.typeName = typeName; this.field = field;
  }
}

function tokenizeGql(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i++; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '.' && src.slice(i, i + 3) === '...') { tokens.push('...'); i += 3; continue; }
    if ('{}()[]:!=$@'.includes(ch)) { tokens.push(ch); i++; continue; }
    if (ch === '"') {
      let j = i + 1; let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else { out += src[j]; j++; }
      }
      if (j >= src.length) throw new GqlParseError('unterminated string');
      tokens.push(JSON.stringify(out));
      i = j + 1; continue;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*|^-?\d+(\.\d+)?/.exec(src.slice(i));
    if (m) { tokens.push(m[0]); i += m[0].length; continue; }
    throw new GqlParseError(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}
function parseGqlDocument(src: string): GqlOp {
  const tokens = tokenizeGql(src);
  let pos = 0;
  const peek = (): string => tokens[pos] ?? '';
  const next = (): string => tokens[pos++] ?? '';
  const expect = (t: string): void => { if (next() !== t) throw new GqlParseError(`expected ${t}`); };
  const isName = (t: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(t) && !['true', 'false', 'null'].includes(t);
  const parseValue = (): GqlValue => {
    const t = next();
    if (t === '$') return { __var: next() } as unknown as GqlValue;
    if (t === '[') {
      const arr: GqlValue[] = [];
      while (peek() !== ']') arr.push(parseValue());
      expect(']');
      return arr;
    }
    if (t === '{') {
      const obj: { [k: string]: GqlValue } = {};
      while (peek() !== '}') { const k = next(); expect(':'); obj[k] = parseValue(); }
      expect('}');
      return obj;
    }
    if (t.startsWith('"')) return JSON.parse(t) as string;
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null') return null;
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    return t; // enum literal: keep the bare name as a string
  };
  const parseArgs = (): Record<string, GqlValue> => {
    const args: Record<string, GqlValue> = {};
    expect('(');
    while (peek() !== ')') { const k = next(); expect(':'); args[k] = parseValue(); }
    expect(')');
    return args;
  };
  const parseSelectionSet = (): GqlSelection[] => {
    expect('{');
    const sels: GqlSelection[] = [];
    while (peek() !== '}') {
      if (peek() === '...') {
        next();
        if (peek() === 'on') {
          next();
          const typeCondition = next();
          sels.push({ kind: 'fragment', typeCondition, sel: parseSelectionSet() });
        } else if (isName(peek())) {
          throw new GqlParseError('named fragments are not supported');
        } else {
          sels.push({ kind: 'fragment', typeCondition: null, sel: parseSelectionSet() });
        }
        continue;
      }
      let name = next();
      let alias = name;
      if (peek() === ':') { next(); alias = name; name = next(); }
      let args: Record<string, GqlValue> = {};
      if (peek() === '(') args = parseArgs();
      // Directives: skip @name or @name(args).
      while (peek() === '@') {
        next(); next();
        if (peek() === '(') { let depth = 0; while (pos < tokens.length) { const t = next(); if (t === '(') depth++; else if (t === ')') { depth--; if (depth === 0) break; } } }
      }
      let sel: GqlSelection[] | null = null;
      if (peek() === '{') sel = parseSelectionSet();
      sels.push({ kind: 'field', name, alias, args, sel });
    }
    expect('}');
    return sels;
  };
  let operation: 'query' | 'mutation' = 'query';
  if (peek() === 'query' || peek() === 'mutation') operation = next() as 'query' | 'mutation';
  if (isName(peek()) && peek() !== '{') next(); // operation name
  const vars: Record<string, GqlValue> = {};
  if (peek() === '(') {
    expect('(');
    while (peek() !== ')') {
      expect('$');
      const name = next();
      expect(':');
      // Skip the type: Name, [Name], Name!, [Name!]!, etc.
      let depth = 0;
      while (pos < tokens.length) {
        const t = next();
        if (t === '[') depth++;
        else if (t === ']') depth--;
        else if (t === '=' && depth === 0) { vars[name] = parseValue(); break; }
        else if ((t === ',' || t === ')') && depth === 0) { pos--; break; }
        else if (depth === 0 && (t === '$' || t === '{')) { pos--; break; }
      }
      if (peek() === ',') next();
    }
    expect(')');
  }
  const sel = parseSelectionSet();
  return { operation, vars, sel };
}
function resolveVars(op: GqlOp, variables: Record<string, unknown>): Record<string, GqlValue> {
  const out: Record<string, GqlValue> = {};
  for (const [k, v] of Object.entries(op.vars)) out[k] = v as GqlValue;
  for (const [k, v] of Object.entries(variables)) out[k] = v as GqlValue;
  return out;
}
function substVars(value: GqlValue, vars: Record<string, GqlValue>): GqlValue {
  if (Array.isArray(value)) return value.map((v) => substVars(v, vars));
  if (typeof value === 'object' && value !== null) {
    if ('__var' in value) return vars[String((value as { __var: unknown }).__var)] ?? null;
    const out: { [k: string]: GqlValue } = {};
    for (const [k, v] of Object.entries(value)) out[k] = substVars(v, vars);
    return out;
  }
  return value;
}

// --- executor: values carry their GraphQL type in a side table.
const gqlTypes = new WeakMap<object, string>();
function typed<T extends object>(type: string, value: T): T { gqlTypes.set(value, type); return value; }
function typeOfValue(v: unknown): string {
  if (typeof v === 'object' && v !== null) return gqlTypes.get(v) ?? 'Unknown';
  return 'Unknown';
}
const INTROSPECTION: Record<string, { kind: string; fields: string[]; enumValues: string[] }> = {
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body'], enumValues: [] },
  PullRequest: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'], enumValues: [] },
  Repository: { kind: 'OBJECT', fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'], enumValues: [] },
  SearchType: { kind: 'ENUM', fields: [], enumValues: ['CODE', 'COMMIT', 'DISCUSSION', 'ISSUE', 'LABEL', 'MILESTONE', 'PACKAGE', 'REPOSITORY', 'TOPIC', 'USER', 'WIKI'] },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email'], enumValues: [] },
};
function viewerUser(): Record<string, unknown> {
  return typed('User', { login: VIEWER_LOGIN, id: VIEWER_ID, name: 'ada iversen', email: 'adaiversen@example.invalid' });
}
function repoObject(r: Repo): Record<string, unknown> {
  return typed('Repository', { __repo: r });
}
function issueObject(r: Repo, i: Issue): Record<string, unknown> {
  return typed('Issue', { __repo: r, __issue: i });
}
function pullObject(r: Repo, p: Pull): Record<string, unknown> {
  return typed('PullRequest', { __repo: r, __pull: p });
}
function issuesConnection(r: Repo, args: Record<string, GqlValue>): Record<string, unknown> {
  let list = [...r.issues.values()];
  const states = Array.isArray(args.states) ? (args.states as string[]) : [];
  if (states.length > 0) {
    const want = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => want.has(i.state));
  }
  const orderBy = isObj(args.orderBy) ? args.orderBy : {};
  const direction = String(orderBy.direction ?? 'DESC');
  list.sort((a, b) => direction === 'ASC' ? a.number - b.number : b.number - a.number);
  const after = typeof args.after === 'string' ? cursorIndex(args.after) : -1;
  const start = after + 1;
  const first = typeof args.first === 'number' ? args.first : list.length;
  const end = Math.min(list.length, start + first);
  const nodes = list.slice(start, end).map((i) => issueObject(r, i));
  return typed('IssueConnection', {
    nodes,
    pageInfo: typed('PageInfo', pageInfoFor(list.length, start, end)),
    totalCount: list.length,
  });
}
function pullsConnection(r: Repo, args: Record<string, GqlValue>): Record<string, unknown> {
  const list = [...r.pulls.values()].sort((a, b) => b.number - a.number);
  const after = typeof args.after === 'string' ? cursorIndex(args.after) : -1;
  const start = after + 1;
  const first = typeof args.first === 'number' ? args.first : list.length;
  const end = Math.min(list.length, start + first);
  const nodes = list.slice(start, end).map((p) => pullObject(r, p));
  return typed('PullRequestConnection', {
    nodes,
    pageInfo: typed('PageInfo', pageInfoFor(list.length, start, end)),
    totalCount: list.length,
  });
}
function doMergePull(repo: Repo, pull: Pull): { ok: boolean; reason?: string } {
  if (pull.state !== 'open' || pull.merged) return { ok: false, reason: 'Pull request is already closed' };
  if (prConflict(pull, repo)) return { ok: false, reason: 'Merge conflict' };
  const baseTip = branchTip(repo, pull.baseRef);
  if (!baseTip) return { ok: false, reason: 'base branch does not exist' };
  const mergeCommit = makeCommit(treeOfCommit(pull.headSha), [baseTip], pull.title);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeCommit);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_ISO;
  pull.mergeCommitSha = mergeCommit;
  return { ok: true };
}
function resolveField(typeName: string, field: string, source: unknown, args: Record<string, GqlValue>): unknown {
  const src = isObj(source) ? source : {};
  switch (typeName) {
    case 'Query': {
      if (field === 'viewer') return viewerUser();
      if (field === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        const repo = findRepo(owner, name);
        return repo ? repoObject(repo) : null;
      }
      if (field === 'node') {
        const id = String(args.id ?? '');
        const found = findByGid(id);
        if (!found) return null;
        if (found.kind === 'Repository') return repoObject(found.repo);
        if (found.kind === 'Issue' && found.issue) return issueObject(found.repo, found.issue);
        if (found.kind === 'PullRequest' && found.pull) return pullObject(found.repo, found.pull);
        if (found.kind === 'IssueComment' && found.issue && found.comment) {
          return typed('IssueComment', { __repo: found.repo, __issue: found.issue, __comment: found.comment });
        }
        return null;
      }
      if (field === '__type') {
        const name = String(args.name ?? '');
        const spec = INTROSPECTION[name];
        if (!spec) return null;
        return typed('__Type', {
          name, kind: spec.kind,
          fields: spec.fields.map((f) => typed('__Field', { name: f })),
          enumValues: spec.enumValues.map((e) => typed('__EnumValue', { name: e })),
        });
      }
      if (field === '__schema') {
        return typed('__Schema', {
          queryType: typed('__Type', { name: 'Query', kind: 'OBJECT', fields: [], enumValues: [] }),
          mutationType: typed('__Type', { name: 'Mutation', kind: 'OBJECT', fields: [], enumValues: [] }),
          types: [],
        });
      }
      break;
    }
    case 'Mutation': {
      const input = isObj(args.input) ? args.input : {};
      if (field === 'createIssue') {
        const found = findByGid(String(input.repositoryId ?? ''));
        if (!found || found.kind !== 'Repository') throw new GqlParseError('createIssue: unknown repository');
        const repo = found.repo;
        const title = String(input.title ?? '');
        if (title === '') throw new GqlParseError('createIssue: title is required');
        const number = repo.nextNumber++;
        const issue: Issue = {
          number, title, body: typeof input.body === 'string' ? input.body : '',
          state: 'open', labels: [], comments: [], seq: nextDbId++,
        };
        repo.issues.set(number, issue);
        return typed('CreateIssuePayload', { issue: issueObject(repo, issue) });
      }
      if (field === 'closeIssue') {
        const found = findByGid(String(input.issueId ?? ''));
        if (!found || found.kind !== 'Issue' || !found.issue) throw new GqlParseError('closeIssue: unknown issue');
        found.issue.state = 'closed';
        return typed('CloseIssuePayload', { issue: issueObject(found.repo, found.issue) });
      }
      if (field === 'createPullRequest') {
        const found = findByGid(String(input.repositoryId ?? ''));
        if (!found || found.kind !== 'Repository') throw new GqlParseError('createPullRequest: unknown repository');
        const repo = found.repo;
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? '');
        const headSha = branchTip(repo, head);
        const baseSha = branchTip(repo, base);
        if (!headSha || !baseSha) throw new GqlParseError('createPullRequest: head or base branch does not exist');
        const number = repo.nextNumber++;
        const pull: Pull = {
          number, title: String(input.title ?? ''), body: '',
          state: 'open', headRef: head, baseRef: base, headSha, baseSha,
          merged: false, mergedAt: '', mergeCommitSha: null, seq: nextDbId++,
        };
        repo.pulls.set(number, pull);
        return typed('CreatePullRequestPayload', { pullRequest: pullObject(repo, pull) });
      }
      if (field === 'mergePullRequest') {
        const found = findByGid(String(input.pullRequestId ?? ''));
        if (!found || found.kind !== 'PullRequest' || !found.pull) throw new GqlParseError('mergePullRequest: unknown pull request');
        const result = doMergePull(found.repo, found.pull);
        if (!result.ok) throw new GqlParseError(`mergePullRequest: ${result.reason ?? 'failed'}`);
        return typed('MergePullRequestPayload', { pullRequest: pullObject(found.repo, found.pull) });
      }
      if (field === 'addComment') {
        const found = findByGid(String(input.subjectId ?? ''));
        if (!found || found.kind !== 'Issue' || !found.issue) throw new GqlParseError('addComment: unknown subject');
        const comment: Comment = { id: nextDbId++, body: String(input.body ?? '') };
        found.issue.comments.push(comment);
        return typed('AddCommentPayload', {
          commentEdge: typed('IssueCommentEdge', {
            node: typed('IssueComment', { __repo: found.repo, __issue: found.issue, __comment: comment }),
            cursor: cursorOf(found.issue.comments.length - 1),
          }),
        });
      }
      break;
    }
    case 'User':
      if (field === 'login' || field === 'name' || field === 'email') return src[field] ?? null;
      if (field === 'id') return gid('User', VIEWER_LOGIN);
      break;
    case 'Repository': {
      const repo = src.__repo as Repo;
      if (field === 'id') return gidRepo(repo);
      if (field === 'databaseId') return repo.id;
      if (field === 'name') return repo.name;
      if (field === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (field === 'owner') return viewerUser();
      if (field === 'defaultBranchRef') {
        const tip = branchTip(repo, repo.defaultBranch);
        return tip ? typed('Ref', { name: repo.defaultBranch }) : null;
      }
      if (field === 'viewerPermission') return 'ADMIN';
      if (field === 'hasIssuesEnabled') return true;
      if (field === 'issue') {
        const n = Number(args.number);
        const issue = repo.issues.get(n);
        return issue ? issueObject(repo, issue) : null;
      }
      if (field === 'issues') return issuesConnection(repo, args);
      if (field === 'pullRequests') return pullsConnection(repo, args);
      if (field === 'pullRequest') {
        const n = Number(args.number);
        const pull = repo.pulls.get(n);
        return pull ? pullObject(repo, pull) : null;
      }
      break;
    }
    case 'Issue': {
      const issue = src.__issue as Issue;
      const repo = src.__repo as Repo;
      if (field === 'id') return gidIssue(repo, issue.number);
      if (field === 'number') return issue.number;
      if (field === 'title') return issue.title;
      if (field === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field === 'body') return issue.body;
      break;
    }
    case 'PullRequest': {
      const pull = src.__pull as Pull;
      const repo = src.__repo as Repo;
      if (field === 'id') return gidPull(repo, pull.number);
      if (field === 'number') return pull.number;
      if (field === 'title') return pull.title;
      if (field === 'headRefName') return pull.headRef;
      if (field === 'baseRefName') return pull.baseRef;
      if (field === 'mergeable') return prConflict(pull, repo) ? 'CONFLICTING' : 'MERGEABLE';
      if (field === 'state') return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field === 'merged') return pull.merged;
      if (field === 'files') {
        const files = diffFiles(treeOfCommit(pull.baseSha), treeOfCommit(pull.headSha));
        const first = typeof args.first === 'number' ? args.first : files.length;
        const nodes = files.slice(0, first).map((f) => typed('PullRequestFile', { path: f.filename }));
        return typed('PullRequestFileConnection', { nodes, pageInfo: typed('PageInfo', pageInfoFor(files.length, 0, nodes.length)), totalCount: files.length });
      }
      break;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestFileConnection':
      if (field === 'nodes') return src.nodes ?? [];
      if (field === 'pageInfo') return src.pageInfo ?? null;
      if (field === 'totalCount') return src.totalCount ?? 0;
      if (field === 'edges') return [];
      break;
    case 'PageInfo':
      if (field === 'hasNextPage') return src.hasNextPage ?? false;
      if (field === 'hasPreviousPage') return src.hasPreviousPage ?? false;
      if (field === 'startCursor') return src.startCursor ?? null;
      if (field === 'endCursor') return src.endCursor ?? null;
      break;
    case 'IssueComment': {
      const comment = src.__comment as Comment;
      const repo = src.__repo as Repo;
      const issue = src.__issue as Issue;
      if (field === 'id') return gidComment(repo, issue.number, comment.id);
      if (field === 'body') return comment.body;
      break;
    }
    case 'IssueCommentEdge':
      if (field === 'node') return src.node ?? null;
      if (field === 'cursor') return src.cursor ?? null;
      break;
    case 'Ref':
      if (field === 'name') return src.name ?? null;
      break;
    case 'PullRequestFile':
      if (field === 'path') return src.path ?? null;
      break;
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
      if (field === 'issue') return src.issue ?? null;
      break;
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      if (field === 'pullRequest') return src.pullRequest ?? null;
      break;
    case 'AddCommentPayload':
      if (field === 'commentEdge') return src.commentEdge ?? null;
      break;
    case '__Type':
      if (field === 'name') return src.name ?? null;
      if (field === 'kind') return src.kind ?? null;
      if (field === 'fields') return src.fields ?? [];
      if (field === 'enumValues') return src.enumValues ?? [];
      break;
    case '__Field':
    case '__EnumValue':
      if (field === 'name') return src.name ?? null;
      break;
    case '__Schema':
      if (field === 'queryType') return src.queryType ?? null;
      if (field === 'mutationType') return src.mutationType ?? null;
      if (field === 'types') return src.types ?? [];
      break;
  }
  if (field === '__typename') return typeName;
  throw new GqlUnknownField(typeName, field);
}
function execSelection(sel: GqlSelection[], typeName: string, source: unknown, vars: Record<string, GqlValue>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const item of sel) {
    if (item.kind === 'fragment') {
      if (item.typeCondition !== null && item.typeCondition !== typeName) continue;
      Object.assign(out, execSelection(item.sel, typeName, source, vars));
      continue;
    }
    if (item.name === '__typename') { out[item.alias] = typeName; continue; }
    const args: Record<string, GqlValue> = {};
    for (const [k, v] of Object.entries(item.args)) args[k] = substVars(v, vars);
    const value = resolveField(typeName, item.name, source, args);
    if (item.sel === null || value === null || value === undefined) {
      out[item.alias] = value ?? null;
    } else if (Array.isArray(value)) {
      out[item.alias] = value.map((el) => {
        if (typeof el === 'object' && el !== null) return execSelection(item.sel!, typeOfValue(el), el, vars);
        return el;
      });
    } else if (typeof value === 'object') {
      out[item.alias] = execSelection(item.sel, typeOfValue(value), value, vars);
    } else {
      out[item.alias] = value;
    }
  }
  return out;
}
function executeGqlOperation(body: unknown): Record<string, unknown> {
  if (!isObj(body) || typeof body.query !== 'string') {
    return { errors: [{ message: 'A GraphQL query string is required.' }] };
  }
  let op: GqlOp;
  try {
    op = parseGqlDocument(body.query);
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
  }
  const vars = resolveVars(op, isObj(body.variables) ? (body.variables as Record<string, unknown>) : {});
  try {
    const rootType = op.operation === 'mutation' ? 'Mutation' : 'Query';
    const data = execSelection(op.sel, rootType, {}, vars);
    return { data };
  } catch (err) {
    if (err instanceof GqlUnknownField) return { data: null, errors: [{ message: err.message }] };
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL execution error' }] };
  }
}
async function handleGraphQL(req: http.IncomingMessage, res: http.ServerResponse, ctx: Ctx): Promise<void> {
  if (!tokenOk(req)) { sendError(res, 401, 'Bad credentials'); return; }
  if ((req.method ?? 'GET') !== 'POST') { sendError(res, 404, 'Not Found'); return; }
  const parsed = parseJsonBody(ctx.body);
  if (!parsed.ok) { sendJson(res, 400, { errors: [{ message: 'Invalid JSON body' }] }); return; }
  if (Array.isArray(parsed.value)) {
    sendJson(res, 200, parsed.value.map((entry) => executeGqlOperation(entry)));
    return;
  }
  sendJson(res, 200, executeGqlOperation(parsed.value));
}

// ------------------------------------------------------------------ MCP

const SERVER_INFO = { name: 'github-core-clone', version: VERSION };
const MCP_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MCP_TOOLS: Array<Record<string, unknown>> = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function mcpOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = '';
  let repo = '';
  if (typeof args.full_name === 'string' && args.full_name.includes('/')) {
    const [o, r] = args.full_name.split('/');
    owner = o; repo = r;
  }
  if (typeof args.owner === 'string') owner = args.owner;
  else if (typeof args.ownerLogin === 'string') owner = args.ownerLogin;
  else if (typeof args.login === 'string') owner = args.login;
  if (typeof args.repo === 'string') repo = args.repo;
  else if (typeof args.repoName === 'string') repo = args.repoName;
  else if (typeof args.repository === 'string') repo = args.repository;
  return { owner, repo };
}
function mcpResult(data: Record<string, unknown>): Record<string, unknown> {
  const text = JSON.stringify(data);
  return { content: [{ type: 'text', text }], structuredContent: data };
}
function mcpError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], structuredContent: { error: message }, isError: true };
}
function mcpCallTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === 'create_repo') {
    const repoName = typeof args.name === 'string' ? args.name : '';
    if (repoName === '') return mcpError('create_repo requires a name');
    if (findRepo(VIEWER_LOGIN, repoName)) return mcpError('Repository already exists');
    const repo = createRepoRecord(
      VIEWER_LOGIN, repoName,
      typeof args.description === 'string' ? args.description : '',
      args.private === true,
    );
    repo.seq = nextRepoId;
    return mcpResult(repoView(repo) as Record<string, unknown>);
  }
  if (name === 'get_repo') {
    const { owner, repo: repoName } = mcpOwnerRepo(args);
    if (owner === '' || repoName === '') return mcpError('get_repo requires owner and repo');
    const repo = findRepo(owner, repoName);
    if (!repo) return mcpError('Not Found');
    return mcpResult(repoView(repo) as Record<string, unknown>);
  }
  if (name === 'create_issue') {
    const { owner, repo: repoName } = mcpOwnerRepo(args);
    const title = typeof args.title === 'string' ? args.title : '';
    if (owner === '' || repoName === '' || title === '') return mcpError('create_issue requires owner, repo and title');
    const repo = findRepo(owner, repoName);
    if (!repo) return mcpError('Not Found');
    const number = repo.nextNumber++;
    const issue: Issue = {
      number, title, body: typeof args.body === 'string' ? args.body : '',
      state: 'open', labels: [], comments: [], seq: nextDbId++,
    };
    repo.issues.set(number, issue);
    return mcpResult(issueView(issue) as Record<string, unknown>);
  }
  if (name === 'list_issues') {
    const { owner, repo: repoName } = mcpOwnerRepo(args);
    if (owner === '' || repoName === '') return mcpError('list_issues requires owner and repo');
    const repo = findRepo(owner, repoName);
    if (!repo) return mcpError('Not Found');
    const state = typeof args.state === 'string' ? args.state : 'open';
    let list = [...repo.issues.values()];
    if (state !== 'all') list = list.filter((i) => i.state === state);
    list.sort((a, b) => b.number - a.number);
    return mcpResult({ issues: list.map((i) => issueView(i)) });
  }
  if (name === 'create_pull_request') {
    const { owner, repo: repoName } = mcpOwnerRepo(args);
    const title = typeof args.title === 'string' ? args.title : '';
    const head = typeof args.head === 'string' ? args.head : '';
    const base = typeof args.base === 'string' ? args.base : '';
    if (owner === '' || repoName === '' || title === '' || head === '' || base === '') {
      return mcpError('create_pull_request requires owner, repo, title, head and base');
    }
    const repo = findRepo(owner, repoName);
    if (!repo) return mcpError('Not Found');
    const headSha = branchTip(repo, head);
    const baseSha = branchTip(repo, base);
    if (!headSha || !baseSha) return mcpError('head or base branch does not exist');
    const number = repo.nextNumber++;
    const pull: Pull = {
      number, title, body: typeof args.body === 'string' ? args.body : '',
      state: 'open', headRef: head, baseRef: base, headSha, baseSha,
      merged: false, mergedAt: '', mergeCommitSha: null, seq: nextDbId++,
    };
    repo.pulls.set(number, pull);
    return mcpResult(pullView(pull) as Record<string, unknown>);
  }
  if (name === 'merge_pull_request') {
    const { owner, repo: repoName } = mcpOwnerRepo(args);
    const num = Number(args.pull_number ?? args.pullNumber ?? args.number ?? args.pr_number);
    if (owner === '' || repoName === '' || !Number.isInteger(num)) {
      return mcpError('merge_pull_request requires owner, repo and pull_number');
    }
    const repo = findRepo(owner, repoName);
    if (!repo) return mcpError('Not Found');
    const pull = repo.pulls.get(num);
    if (!pull) return mcpError('Not Found');
    const result = doMergePull(repo, pull);
    if (!result.ok) return mcpError(result.reason ?? 'Merge failed');
    return mcpResult({ number: pull.number, merged: true, sha: pull.mergeCommitSha, state: 'closed' });
  }
  return mcpError(`Unknown tool: ${name}`);
}
function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}
function rpcResult(id: unknown, result: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse, ctx: Ctx): Promise<void> {
  if (!tokenOk(req)) { sendError(res, 401, 'Bad credentials'); return; }
  const method = req.method ?? 'GET';
  if (method === 'DELETE') { sendError(res, 405, 'Method Not Allowed'); return; }
  if (method !== 'POST') { sendError(res, 405, 'Method Not Allowed'); return; }
  const raw = ctx.body.toString('utf8');
  const parsed = parseJsonBody(ctx.body);
  if (!parsed.ok) {
    let id: unknown = null;
    const m = /"id"\s*:\s*("[^"]*"|-?\d+|null)/.exec(raw);
    if (m) {
      try { id = JSON.parse(m[1]); } catch { id = null; }
    }
    sendJson(res, 400, rpcError(id, -32700, 'Parse error'));
    return;
  }
  const body = parsed.value;
  if (!isObj(body) || typeof body.method !== 'string') {
    sendJson(res, 400, rpcError(isObj(body) ? body.id : null, -32600, 'Invalid Request'));
    return;
  }
  const id = body.id ?? null;
  const params = isObj(body.params) ? body.params : {};
  const methodName = body.method;
  if (methodName === 'notifications/initialized') {
    res.writeHead(202, { 'X-GitHub-Request-Id': nextRequestId() });
    res.end();
    return;
  }
  if (methodName === 'ping') { sendJson(res, 200, rpcResult(id, {})); return; }
  if (methodName === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_VERSIONS[0];
    sendJson(res, 200, rpcResult(id, {
      protocolVersion: requested,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    }));
    return;
  }
  if (methodName === 'server/discover') {
    sendJson(res, 200, rpcResult(id, {
      supportedVersions: MCP_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    }));
    return;
  }
  if (methodName === 'tools/list') {
    sendJson(res, 200, rpcResult(id, { tools: MCP_TOOLS }));
    return;
  }
  if (methodName === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isObj(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const known = MCP_TOOLS.some((t) => t.name === toolName);
    if (!known) { sendJson(res, 200, rpcError(id, -32602, `Unknown tool: ${toolName}`)); return; }
    sendJson(res, 200, rpcResult(id, mcpCallTool(toolName, args)));
    return;
  }
  sendJson(res, 200, rpcError(id, -32601, `Method not found: ${methodName}`));
}

// ------------------------------------------------------------------ router + lifecycle

async function handler(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const segments = url.pathname.split('/').filter((p) => p !== '').map(dec);
    const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '') ? await readBody(req) : Buffer.alloc(0);
    const ctx: Ctx = { segments, query: url.searchParams, body, rawPath: url.pathname };
    if (url.pathname === '/healthz' && (req.method ?? 'GET') === 'GET') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (segments[0] === 'api' && segments[1] === 'v3') {
      await handleRest(req, res, { ...ctx, segments: segments.slice(2) });
      return;
    }
    if (segments[0] === 'api' && segments[1] === 'graphql') {
      await handleGraphQL(req, res, ctx);
      return;
    }
    if (segments[0] === 'mcp') {
      await handleMcp(req, res, ctx);
      return;
    }
    if (segments.some((s) => s.endsWith('.git'))) {
      await handleGit(req, res, ctx);
      return;
    }
    sendError(res, 404, 'Not Found');
  } catch (err) {
    try {
      sendError(res, 500, err instanceof Error ? err.message : 'Internal error');
    } catch { /* response already gone */ }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<number> {
  const server = http.createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (envUrl === '') {
    // No harness: serve until killed (local development).
    await new Promise<void>(() => {});
    return 0;
  }
  const register = await fetch(`${envUrl}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ port }),
  });
  if (!register.ok) {
    process.stderr.write(`register failed: HTTP ${register.status}\n`);
    return 1;
  }
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`);
      const data = (await response.json().catch(() => ({}))) as { done?: boolean };
      if (data.done === true) break;
    } catch {
      // The harness may restart; keep polling.
    }
    await sleep(1000);
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return 0;
}

const code = await main();
process.exit(code);
