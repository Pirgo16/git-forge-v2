// Git object database, packfiles, pkt-line and smart HTTP for one repository.
// Objects are stored exactly as received. Times and randomness never enter this layer.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO = '0000000000000000000000000000000000000000';

const TYPE_NAME = ['', 'commit', 'tree', 'blob', 'tag'] as const;
const AUTHOR = 'ada iversen <adaiversen@example.invalid> 1700000000 +0000';

export interface GitObj {
  t: 1 | 2 | 3 | 4;
  d: Buffer;
  parents?: string[];
  tree?: string;
  peel?: string;
  files?: Map<string, string>;
  ents?: TreeEnt[];
}

export interface TreeEnt {
  mode: string;
  name: string;
  oid: string;
}

export interface GitRepo {
  refs: Map<string, string>;
  head: string;
  objs: Map<string, GitObj>;
  v0up: Buffer | null;
  v0rx: Buffer | null;
  ls: Buffer | null;
  shallowKey: string;
  shallowBuf: Buffer | null;
  lsBody: Buffer | null;
  lsResp: Buffer | null;
  fetchBody: Buffer | null;
  fetchResp: Buffer | null;
}

interface Pkt {
  k: 'data' | 'flush' | 'delim';
  d?: Buffer;
}

const FLUSH = Buffer.from('0000');
const hex = Buffer.from('0123456789abcdef');
const V2_AD = buildV2Ad();

export function createGitRepo(): GitRepo {
  return {
    refs: new Map(),
    head: 'refs/heads/main',
    objs: new Map(),
    v0up: null,
    v0rx: null,
    ls: null,
    shallowKey: '',
    shallowBuf: null,
    lsBody: null,
    lsResp: null,
    fetchBody: null,
    fetchResp: null,
  };
}

function dirty(repo: GitRepo): void {
  repo.v0up = null;
  repo.v0rx = null;
  repo.ls = null;
  repo.shallowKey = '';
  repo.shallowBuf = null;
  repo.lsBody = null;
  repo.lsResp = null;
  repo.fetchBody = null;
  repo.fetchResp = null;
}

export function hashObj(type: string, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(type);
  hash.update(' ');
  hash.update(String(data.length));
  hash.update('\0');
  hash.update(data);
  return hash.digest('hex');
}

function indexObj(obj: GitObj): void {
  if (obj.t === 1) {
    const text = obj.d.toString('utf8');
    const cut = text.indexOf('\n\n');
    const header = cut < 0 ? text : text.slice(0, cut);
    const parents: string[] = [];
    let tree = '';
    let start = 0;
    while (start < header.length) {
      let nl = header.indexOf('\n', start);
      if (nl < 0) nl = header.length;
      const line = header.slice(start, nl);
      if (line.startsWith('tree ')) tree = line.slice(5);
      else if (line.startsWith('parent ')) parents.push(line.slice(7));
      start = nl + 1;
    }
    obj.tree = tree;
    obj.parents = parents;
  } else if (obj.t === 4) {
    const text = obj.d.toString('utf8');
    const nl = text.indexOf('\n');
    const line = nl < 0 ? text : text.slice(0, nl);
    if (line.startsWith('object ')) obj.peel = line.slice(7).trim();
  }
}

export function putObj(repo: GitRepo, t: 1 | 2 | 3 | 4, data: Buffer): string {
  const oid = hashObj(TYPE_NAME[t], data);
  if (!repo.objs.has(oid)) {
    const obj: GitObj = { t, d: data };
    indexObj(obj);
    repo.objs.set(oid, obj);
  }
  return oid;
}

export function peelToCommit(repo: GitRepo, oid: string): string {
  const seen = new Set<string>();
  while (!seen.has(oid)) {
    seen.add(oid);
    const obj = repo.objs.get(oid);
    if (!obj || obj.t !== 4 || !obj.peel) break;
    oid = obj.peel;
  }
  return oid;
}

function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload) : payload;
  const len = data.length + 4;
  const head = Buffer.allocUnsafe(4);
  head[0] = hex[(len >> 12) & 15];
  head[1] = hex[(len >> 8) & 15];
  head[2] = hex[(len >> 4) & 15];
  head[3] = hex[len & 15];
  return Buffer.concat([head, data]);
}

function buildV2Ad(): Buffer {
  return Buffer.concat([
    pkt('version 2\n'),
    pkt('agent=forge/1\n'),
    pkt('ls-refs\n'),
    pkt('fetch=shallow\n'),
    pkt('server-option\n'),
    pkt('object-format=sha1\n'),
    FLUSH,
  ]);
}

function refLine(oid: string, name: string, caps: string | null): Buffer {
  return pkt(caps === null ? `${oid} ${name}\n` : `${oid} ${name}\0${caps}\n`);
}

function sortedRefs(repo: GitRepo): string[] {
  return [...repo.refs.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function advertiseUpload(repo: GitRepo, v2: boolean): Buffer {
  if (v2) return V2_AD;
  if (repo.v0up) return repo.v0up;
  const caps = 'side-band-64k shallow no-progress ofs-delta thin-pack agent=forge/1 symref=HEAD:refs/heads/main';
  const parts: Buffer[] = [pkt('# service=git-upload-pack\n'), FLUSH];
  const names = sortedRefs(repo);
  const headOid = repo.refs.get(repo.head);
  if (headOid) {
    parts.push(refLine(headOid, 'HEAD', caps));
    for (const name of names) parts.push(refLine(repo.refs.get(name)!, name, null));
  } else if (names.length) {
    const first = names[0]!;
    parts.push(refLine(repo.refs.get(first)!, first, caps));
    for (let i = 1; i < names.length; i++) parts.push(refLine(repo.refs.get(names[i]!)!, names[i]!, null));
  } else {
    parts.push(refLine(ZERO, 'capabilities^{}', caps));
  }
  parts.push(FLUSH);
  repo.v0up = Buffer.concat(parts);
  return repo.v0up;
}

export function advertiseReceive(repo: GitRepo): Buffer {
  if (repo.v0rx) return repo.v0rx;
  const caps = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1';
  const parts: Buffer[] = [pkt('# service=git-receive-pack\n'), FLUSH];
  const names = sortedRefs(repo);
  if (!names.length) parts.push(refLine(ZERO, 'capabilities^{}', caps));
  else {
    const headOid = repo.refs.get(repo.head);
    let capsUsed = false;
    if (headOid) {
      parts.push(refLine(headOid, 'HEAD', caps));
      capsUsed = true;
    }
    for (const name of names) {
      parts.push(refLine(repo.refs.get(name)!, name, capsUsed ? null : caps));
      capsUsed = true;
    }
  }
  parts.push(FLUSH);
  repo.v0rx = Buffer.concat(parts);
  return repo.v0rx;
}

function allPackets(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const n = parsePktLen(buf, off);
    if (n === 0) {
      out.push({ k: 'flush' });
      off += 4;
      continue;
    }
    if (n === 1) {
      out.push({ k: 'delim' });
      off += 4;
      continue;
    }
    if (n < 4 || off + n > buf.length) throw new Error('truncated pkt-line');
    out.push({ k: 'data', d: buf.subarray(off + 4, off + n) });
    off += n;
  }
  if (off !== buf.length) throw new Error('trailing pkt-line bytes');
  return out;
}

function parsePktLen(buf: Buffer, off: number): number {
  let n = 0;
  for (let i = 0; i < 4; i++) {
    const c = buf[off + i]!;
    let d = 0;
    if (c >= 48 && c <= 57) d = c - 48;
    else if (c >= 97 && c <= 102) d = c - 87;
    else if (c >= 65 && c <= 70) d = c - 55;
    else throw new Error('bad pkt-line length');
    n = (n << 4) | d;
  }
  return n;
}

function readCommands(buf: Buffer): { lines: string[]; pack: Buffer } {
  const lines: string[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const n = parsePktLen(buf, off);
    if (n === 0) {
      off += 4;
      break;
    }
    if (n === 1) {
      off += 4;
      continue;
    }
    if (n < 4 || off + n > buf.length) throw new Error('truncated pkt-line');
    lines.push(buf.toString('utf8', off + 4, off + n).replace(/\n$/, ''));
    off += n;
  }
  return { lines, pack: buf.subarray(off) };
}

function lineOf(pkt: Pkt): string {
  return (pkt.d ?? Buffer.alloc(0)).toString('utf8').replace(/\n$/, '');
}

export function handleUpload(repo: GitRepo, body: Buffer, v2: boolean): Buffer {
  if (!v2) return uploadV0(repo, body);
  if (body.length >= 8) {
    const n = parsePktLen(body, 0);
    if (n > 4 && n <= body.length) {
      const cmd = body.toString('utf8', 4, Math.min(n, 20));
      if (cmd.startsWith('command=ls-refs')) {
        if (repo.lsBody && repo.lsResp && body.equals(repo.lsBody)) return repo.lsResp;
        const resp = uploadV2(repo, body);
        repo.lsBody = body;
        repo.lsResp = resp;
        return resp;
      }
      if (cmd.startsWith('command=fetch')) {
        if (repo.fetchBody && repo.fetchResp && body.equals(repo.fetchBody)) return repo.fetchResp;
        const resp = uploadV2(repo, body);
        repo.fetchBody = body;
        repo.fetchResp = resp;
        return resp;
      }
    }
  }
  return uploadV2(repo, body);
}

function uploadV2(repo: GitRepo, body: Buffer): Buffer {
  const pkts = allPackets(body);
  let i = 0;
  let cmd = '';
  while (i < pkts.length && pkts[i]!.k === 'data') {
    const line = lineOf(pkts[i]!);
    if (line.startsWith('command=')) cmd = line.slice(8);
    i++;
  }
  if (i < pkts.length && pkts[i]!.k !== 'data') i++;
  const args: string[] = [];
  while (i < pkts.length && pkts[i]!.k === 'data') {
    args.push(lineOf(pkts[i]!));
    i++;
  }
  if (cmd === 'ls-refs') return lsRefs(repo, args);
  if (cmd === 'fetch') return fetchV2(repo, args);
  return FLUSH;
}

function lsRefs(repo: GitRepo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const line of args) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length).trim());
  }
  if (peel && symrefs && prefixes.length === 0 && repo.ls) return repo.ls;
  const buf = buildLsRefs(repo, peel, symrefs, prefixes);
  if (peel && symrefs && prefixes.length === 0) repo.ls = buf;
  return buf;
}

function buildLsRefs(repo: GitRepo, peel: boolean, symrefs: boolean, prefixes: string[]): Buffer {
  const want = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headOid = repo.refs.get(repo.head);
  if (headOid && want('HEAD')) {
    let line = `${headOid} HEAD`;
    if (symrefs) line += ` symref-target:${repo.head}`;
    parts.push(pkt(line + '\n'));
  }
  for (const name of sortedRefs(repo)) {
    if (!want(name)) continue;
    const oid = repo.refs.get(name)!;
    let line = `${oid} ${name}`;
    if (peel && name.startsWith('refs/tags/')) line += ` peeled:${peelToCommit(repo, oid)}`;
    parts.push(pkt(line + '\n'));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function fetchV2(repo: GitRepo, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const line of args) {
    if (line.startsWith('want ')) wants.push(line.slice(5).trim().toLowerCase());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim().toLowerCase());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim().toLowerCase());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  if (depth === 1 && haves.length === 0 && shallow.length === 0 && wants.length === 1) {
    const key = wants[0]!;
    if (repo.shallowKey === key && repo.shallowBuf) return repo.shallowBuf;
    const buf = buildFetch(repo, wants, haves, shallow, depth);
    repo.shallowKey = key;
    repo.shallowBuf = buf;
    return buf;
  }
  return buildFetch(repo, wants, haves, shallow, depth);
}

function buildFetch(repo: GitRepo, wants: string[], haves: string[], shallow: string[], depth: number | null): Buffer {
  const parts: Buffer[] = [];
  if (haves.length) {
    parts.push(pkt('acknowledgments\n'));
    const known = haves.find((oid) => repo.objs.has(oid));
    parts.push(pkt(known ? `ACK ${known}\n` : 'NAK\n'));
    parts.push(FLUSH);
  }
  const plan = planWants(repo, wants, depth);
  const have = clientObjects(repo, haves, shallow);
  const send: GitObj[] = [];
  const seen = new Set<string>();
  for (const oid of plan.commits.keys()) {
    if (have.has(oid)) continue;
    const obj = repo.objs.get(oid);
    if (!obj || seen.has(oid)) continue;
    seen.add(oid);
    send.push(obj);
    if (obj.tree) addTreeMissing(repo, obj.tree, have, seen, send);
  }
  for (const oid of plan.extras) {
    if (have.has(oid) || seen.has(oid)) continue;
    const obj = repo.objs.get(oid);
    if (!obj) continue;
    seen.add(oid);
    send.push(obj);
  }
  if (depth !== null) {
    const shallowOut: string[] = [];
    const unshallow: string[] = [];
    for (const oid of plan.commits.keys()) {
      const parents = repo.objs.get(oid)?.parents ?? [];
      if (parents.some((parent) => !plan.commits.has(parent))) shallowOut.push(oid);
    }
    for (const boundary of shallow) {
      if (!plan.commits.has(boundary)) continue;
      const parents = repo.objs.get(boundary)?.parents ?? [];
      if (parents.length === 0 || parents.every((parent) => plan.commits.has(parent))) unshallow.push(boundary);
    }
    if (shallowOut.length || unshallow.length) {
      parts.push(pkt('shallow-info\n'));
      for (const oid of shallowOut) parts.push(pkt(`shallow ${oid}\n`));
      for (const oid of unshallow) parts.push(pkt(`unshallow ${oid}\n`));
      parts.push(FLUSH);
    }
  }
  if (send.length) {
    parts.push(pkt('packfile\n'));
    sidebandPack(writePack(send), parts);
    parts.push(FLUSH);
  }
  return parts.length ? Buffer.concat(parts) : FLUSH;
}

function planWants(repo: GitRepo, wants: string[], depth: number | null): { commits: Map<string, number>; extras: string[] } {
  const commits = new Map<string, number>();
  const extras: string[] = [];
  const queue: Array<{ oid: string; gen: number }> = [];
  for (const want of wants) {
    const obj = repo.objs.get(want);
    if (!obj) continue;
    if (obj.t === 4) {
      extras.push(want);
      queue.push({ oid: peelToCommit(repo, want), gen: 1 });
    } else if (obj.t === 1) queue.push({ oid: want, gen: 1 });
    else extras.push(want);
  }
  let qi = 0;
  while (qi < queue.length) {
    const item = queue[qi++]!;
    if (commits.has(item.oid)) continue;
    if (depth !== null && item.gen > depth) continue;
    const obj = repo.objs.get(item.oid);
    if (!obj || obj.t !== 1) continue;
    commits.set(item.oid, item.gen);
    if (depth !== null && item.gen === depth) continue;
    const parents = obj.parents ?? [];
    for (const parent of parents) queue.push({ oid: parent, gen: item.gen + 1 });
  }
  return { commits, extras };
}

function clientObjects(repo: GitRepo, haves: string[], shallow: string[]): Set<string> {
  const stop = new Set(shallow);
  const commits: string[] = [];
  const seen = new Set<string>();
  const queue = haves.slice();
  let qi = 0;
  while (qi < queue.length) {
    const oid = queue[qi++]!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objs.get(oid);
    if (!obj) continue;
    if (obj.t === 4) {
      commits.push(oid);
      if (!stop.has(oid) && obj.peel) queue.push(peelToCommit(repo, oid));
      continue;
    }
    if (obj.t !== 1) continue;
    commits.push(oid);
    if (stop.has(oid)) continue;
    const parents = obj.parents ?? [];
    for (const parent of parents) queue.push(parent);
  }
  const have = new Set<string>();
  for (const oid of commits) addCommitTree(repo, oid, have);
  return have;
}

function addCommitTree(repo: GitRepo, oid: string, into: Set<string>): void {
  if (into.has(oid)) return;
  const obj = repo.objs.get(oid);
  if (!obj) return;
  into.add(oid);
  if (obj.t === 1 && obj.tree) addTree(repo, obj.tree, into);
  else if (obj.t === 2) addTree(repo, oid, into);
  else if (obj.t === 4 && obj.peel) addCommitTree(repo, peelToCommit(repo, oid), into);
}

function addTree(repo: GitRepo, oid: string, into: Set<string>): void {
  if (into.has(oid)) return;
  const obj = repo.objs.get(oid);
  if (!obj || obj.t !== 2) return;
  into.add(oid);
  for (const ent of treeEnts(obj)) {
    if (ent.mode === '40000' || ent.mode === '040000') addTree(repo, ent.oid, into);
    else into.add(ent.oid);
  }
}

function addTreeMissing(repo: GitRepo, oid: string, have: Set<string>, seen: Set<string>, send: GitObj[]): void {
  if (have.has(oid) || seen.has(oid)) return;
  const obj = repo.objs.get(oid);
  if (!obj) return;
  seen.add(oid);
  send.push(obj);
  if (obj.t !== 2) return;
  for (const ent of treeEnts(obj)) {
    if (ent.mode === '40000' || ent.mode === '040000') addTreeMissing(repo, ent.oid, have, seen, send);
    else if (!have.has(ent.oid) && !seen.has(ent.oid)) {
      const blob = repo.objs.get(ent.oid);
      if (!blob) continue;
      seen.add(ent.oid);
      send.push(blob);
    }
  }
}

function uploadV0(repo: GitRepo, body: Buffer): Buffer {
  const pkts = allPackets(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const pkt of pkts) {
    if (pkt.k !== 'data') continue;
    const line = lineOf(pkt);
    const clean = line.split('\0', 1)[0] ?? line;
    if (clean.startsWith('want ')) wants.push(clean.slice(5).trim().split(' ')[0]!.toLowerCase());
    else if (clean.startsWith('have ')) haves.push(clean.slice(5).trim().toLowerCase());
    else if (clean.startsWith('shallow ')) shallow.push(clean.slice(8).trim().toLowerCase());
    else if (clean.startsWith('deepen ')) {
      const n = Number(clean.slice(7).trim());
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  const built = buildFetch(repo, wants, haves, shallow, depth);
  // v0 framing has no section names. Re-express acknowledgments, shallow lines and the pack.
  return v0FromV2(built);
}

function v0FromV2(v2: Buffer): Buffer {
  const pkts = allPackets(v2);
  const parts: Buffer[] = [];
  let section = '';
  const packChunks: Buffer[] = [];
  for (const item of pkts) {
    if (item.k === 'flush' || item.k === 'delim') {
      section = '';
      continue;
    }
    const text = lineOf(item);
    if (section === '') {
      if (text === 'acknowledgments' || text === 'shallow-info' || text === 'packfile') section = text;
      continue;
    }
    if (section === 'packfile') {
      const data = item.d ?? Buffer.alloc(0);
      if (data.length > 1 && data[0] === 1) packChunks.push(data.subarray(1));
      continue;
    }
    parts.push(pkt(text + '\n'));
  }
  if (!parts.length) parts.push(pkt('NAK\n'));
  if (packChunks.length) sidebandPack(Buffer.concat(packChunks), parts);
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function sidebandPack(pack: Buffer, parts: Buffer[]): void {
  const max = 65515;
  for (let off = 0; off < pack.length; off += max) {
    const chunk = pack.subarray(off, Math.min(off + max, pack.length));
    const payload = Buffer.allocUnsafe(1 + chunk.length);
    payload[0] = 1;
    chunk.copy(payload, 1);
    parts.push(pkt(payload));
  }
}

const reportCache = new Map<string, Buffer>();

function sidebandReport(lines: string[]): Buffer {
  const key = lines.join('\n');
  const hit = reportCache.get(key);
  if (hit) return hit;
  const inner: Buffer[] = [];
  for (const line of lines) inner.push(pkt(line.endsWith('\n') ? line : `${line}\n`));
  inner.push(FLUSH);
  const payload = Buffer.concat(inner);
  const parts: Buffer[] = [];
  const max = 65515;
  for (let off = 0; off < payload.length; off += max) {
    const chunk = payload.subarray(off, Math.min(off + max, payload.length));
    const band = Buffer.allocUnsafe(1 + chunk.length);
    band[0] = 1;
    chunk.copy(band, 1);
    parts.push(pkt(band));
  }
  parts.push(FLUSH);
  const buf = Buffer.concat(parts);
  if (reportCache.size < 32) reportCache.set(key, buf);
  return buf;
}

export function handleReceive(repo: GitRepo, body: Buffer): Buffer {
  try {
    return receive(repo, body);
  } catch (err) {
    const message = (err instanceof Error ? err.message : 'error').replace(/[\r\n]/g, ' ').slice(0, 180);
    return sidebandReport([`unpack ${message || 'error'}`]);
  }
}

function receive(repo: GitRepo, body: Buffer): Buffer {
  const { lines, pack } = readCommands(body);
  if (pack.length) readPack(repo, pack);
  const report = ['unpack ok'];
  let changed = false;
  for (const raw of lines) {
    const line = raw.split('\0', 1)[0] ?? raw;
    const bits = line.split(' ');
    if (bits.length < 3) {
      report.push('ng refs/heads/main invalid command');
      continue;
    }
    const oldOid = (bits[0] ?? '').toLowerCase();
    const newOid = (bits[1] ?? '').toLowerCase();
    const ref = bits.slice(2).join(' ');
    const current = repo.refs.get(ref);
    if (!isOid(oldOid) || !isOid(newOid) || !ref.startsWith('refs/')) {
      report.push(`ng ${ref || 'refs/heads/main'} invalid command`);
      continue;
    }
    if (newOid === ZERO) {
      if (current !== oldOid) report.push(`ng ${ref} old oid mismatch`);
      else {
        repo.refs.delete(ref);
        changed = true;
        report.push(`ok ${ref}`);
      }
      continue;
    }
    if (!repo.objs.has(newOid)) {
      report.push(`ng ${ref} missing object`);
      continue;
    }
    if (oldOid === ZERO) {
      if (current !== undefined) report.push(`ng ${ref} non-fast-forward`);
      else {
        repo.refs.set(ref, newOid);
        changed = true;
        report.push(`ok ${ref}`);
      }
      continue;
    }
    if (current !== oldOid) {
      report.push(`ng ${ref} old oid mismatch`);
      continue;
    }
    if (!fastForward(repo, oldOid, newOid)) {
      report.push(`ng ${ref} non-fast-forward`);
      continue;
    }
    repo.refs.set(ref, newOid);
    changed = true;
    report.push(`ok ${ref}`);
  }
  if (changed) dirty(repo);
  return sidebandReport(report);
}

function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

function fastForward(repo: GitRepo, oldOid: string, newOid: string): boolean {
  if (newOid === oldOid) return true;
  const tip = repo.objs.get(newOid);
  if (!tip || tip.t !== 1) return false;
  const parents = tip.parents ?? [];
  if (parents.length === 1 && parents[0] === oldOid) return true;
  const seen = new Set<string>();
  const queue = [newOid];
  while (queue.length) {
    const oid = queue.pop()!;
    if (oid === oldOid) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objs.get(oid);
    if (!obj || obj.t !== 1) continue;
    const next = obj.parents ?? [];
    for (const parent of next) queue.push(parent);
  }
  return false;
}

function readUndeltified(repo: GitRepo, buf: Buffer, count: number, trailer: number): boolean {
  const items: Array<{ t: 1 | 2 | 3 | 4; data: Buffer }> = [];
  let off = 12;
  for (let n = 0; n < count; n++) {
    let byte = buf[off++];
    if (byte === undefined) return false;
    const type = (byte >> 4) & 7;
    if (type < 1 || type > 4) return false;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[off++];
      if (byte === undefined) return false;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const inflated = inflateSync(buf.subarray(off, trailer), { info: true }) as { buffer: Buffer; engine: { bytesWritten: number } };
    if (inflated.buffer.length !== size) return false;
    items.push({ t: type as 1 | 2 | 3 | 4, data: inflated.buffer });
    off += inflated.engine.bytesWritten;
  }
  if (off !== trailer) return false;
  for (const item of items) putObj(repo, item.t, item.data);
  return true;
}

function readPack(repo: GitRepo, buf: Buffer): void {
  if (buf.length < 32 || buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('bad pack');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('bad pack version');
  const count = buf.readUInt32BE(8);
  const trailer = buf.length - 20;
  const expect = createHash('sha1').update(buf.subarray(0, trailer)).digest();
  if (!buf.subarray(trailer).equals(expect)) throw new Error('pack checksum');
  if (readUndeltified(repo, buf, count, trailer)) return;
  interface Raw {
    off: number;
    type: number;
    data: Buffer;
    baseOff?: number;
    baseOid?: string;
    resolved?: GitObj;
  }
  const raw: Raw[] = [];
  const byOff = new Map<number, Raw>();
  let off = 12;
  for (let n = 0; n < count; n++) {
    const start = off;
    let byte = buf[off++];
    if (byte === undefined) throw new Error('pack header');
    const type = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[off++];
      if (byte === undefined) throw new Error('pack header');
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const entry: Raw = { off: start, type, data: Buffer.alloc(0) };
    if (type === 6) {
      let b = buf[off++];
      if (b === undefined) throw new Error('ofs-delta');
      let val = b & 0x7f;
      while (b & 0x80) {
        b = buf[off++];
        if (b === undefined) throw new Error('ofs-delta');
        val = ((val + 1) << 7) | (b & 0x7f);
      }
      entry.baseOff = start - val;
    } else if (type === 7) {
      if (off + 20 > trailer) throw new Error('ref-delta');
      entry.baseOid = buf.toString('hex', off, off + 20);
      off += 20;
    } else if (type < 1 || type > 4) throw new Error('pack type');
    const inflated = inflateSync(buf.subarray(off, trailer), { info: true }) as { buffer: Buffer; engine: { bytesWritten: number } };
    if (inflated.buffer.length !== size) throw new Error('pack size');
    entry.data = inflated.buffer;
    off += inflated.engine.bytesWritten;
    raw.push(entry);
    byOff.set(start, entry);
  }
  if (off !== trailer) throw new Error('pack trailing');
  const byOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): GitObj => {
    if (entry.resolved) return entry.resolved;
    if (resolving.has(entry.off)) throw new Error('delta cycle');
    resolving.add(entry.off);
    let t: 1 | 2 | 3 | 4;
    let data: Buffer;
    if (entry.type === 6 || entry.type === 7) {
      let base: GitObj | undefined;
      if (entry.type === 6) {
        const baseEntry = byOff.get(entry.baseOff!);
        if (!baseEntry) throw new Error('ofs base');
        base = resolve(baseEntry);
      } else {
        const baseEntry = byOid.get(entry.baseOid!);
        base = baseEntry ? resolve(baseEntry) : repo.objs.get(entry.baseOid!);
        if (!base) throw new Error('ref base');
      }
      t = base.t;
      data = applyDelta(base.d, entry.data);
    } else {
      t = entry.type as 1 | 2 | 3 | 4;
      data = entry.data;
    }
    const oid = hashObj(TYPE_NAME[t], data);
    let obj = repo.objs.get(oid);
    if (!obj) {
      obj = { t, d: data };
      indexObj(obj);
      repo.objs.set(oid, obj);
    }
    entry.resolved = obj;
    byOid.set(oid, entry);
    resolving.delete(entry.off);
    return obj;
  };
  for (const entry of raw) resolve(entry);
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const src = readVarint(delta, off);
  off = src.next;
  if (src.value !== base.length) throw new Error('delta base size');
  const target = readVarint(delta, off);
  off = target.next;
  const out = Buffer.allocUnsafe(target.value);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++]!;
    if (op === 0) throw new Error('delta opcode');
    if (op & 0x80) {
      let copyOff = 0;
      let copySize = 0;
      if (op & 0x01) copyOff |= delta[off++]!;
      if (op & 0x02) copyOff |= delta[off++]! << 8;
      if (op & 0x04) copyOff |= delta[off++]! << 16;
      if (op & 0x08) copyOff |= delta[off++]! << 24;
      if (op & 0x10) copySize |= delta[off++]!;
      if (op & 0x20) copySize |= delta[off++]! << 8;
      if (op & 0x40) copySize |= delta[off++]! << 16;
      if (copySize === 0) copySize = 0x10000;
      if (copyOff + copySize > base.length || written + copySize > out.length) throw new Error('delta copy');
      base.copy(out, written, copyOff, copyOff + copySize);
      written += copySize;
    } else {
      if (off + op > delta.length || written + op > out.length) throw new Error('delta insert');
      delta.copy(out, written, off, off + op);
      off += op;
      written += op;
    }
  }
  if (written !== target.value) throw new Error('delta size');
  return out;
}

function readVarint(buf: Buffer, off: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let next = off;
  while (next < buf.length) {
    const byte = buf[next++]!;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next };
    shift += 7;
    if (shift > 63) throw new Error('varint');
  }
  throw new Error('varint');
}

function packHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (type << 4) | (size & 0x0f);
  let remaining = Math.floor(size / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

function writePack(objects: readonly GitObj[]): Buffer {
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const obj of objects) {
    parts.push(packHeader(obj.t, obj.d.length));
    parts.push(deflateSync(obj.d, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

export function parseTree(buf: Buffer): TreeEnt[] {
  const out: TreeEnt[] = [];
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i);
    if (sp < 0) break;
    const mode = buf.toString('ascii', i, sp);
    const nul = buf.indexOf(0, sp);
    if (nul < 0 || nul + 21 > buf.length) break;
    out.push({ mode, name: buf.toString('utf8', sp + 1, nul), oid: buf.toString('hex', nul + 1, nul + 21) });
    i = nul + 21;
  }
  return out;
}

function treeEnts(obj: GitObj): TreeEnt[] {
  if (obj.ents) return obj.ents;
  obj.ents = parseTree(obj.d);
  return obj.ents;
}

function buildTree(entries: TreeEnt[]): Buffer {
  const sorted = entries.slice().sort((a, b) => {
    const ka = a.mode === '40000' || a.mode === '040000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' || b.mode === '040000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const ent of sorted) {
    parts.push(Buffer.from(`${ent.mode} ${ent.name}\0`));
    parts.push(Buffer.from(ent.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

function treeFromFiles(repo: GitRepo, files: Map<string, string>): string {
  type Node = Map<string, { kind: 'blob'; oid: string } | { kind: 'dir'; kids: Node }>;
  const root: Node = new Map();
  for (const [path, oid] of files) {
    const segs = path.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i]!;
      let next = node.get(seg);
      if (!next || next.kind !== 'dir') {
        next = { kind: 'dir', kids: new Map() };
        node.set(seg, next);
      }
      node = next.kids;
    }
    node.set(segs[segs.length - 1]!, { kind: 'blob', oid });
  }
  const walk = (node: Node): string => {
    const entries: TreeEnt[] = [];
    for (const [name, val] of node) {
      if (val.kind === 'blob') entries.push({ mode: '100644', name, oid: val.oid });
      else entries.push({ mode: '40000', name, oid: walk(val.kids) });
    }
    return putObj(repo, 2, buildTree(entries));
  };
  return walk(root);
}

export function filesOf(repo: GitRepo, commit: string): Map<string, string> {
  const obj = repo.objs.get(commit);
  if (!obj || obj.t !== 1) return new Map();
  if (obj.files) return obj.files;
  const files = new Map<string, string>();
  const walk = (oid: string, prefix: string): void => {
    const tree = repo.objs.get(oid);
    if (!tree || tree.t !== 2) return;
    for (const ent of treeEnts(tree)) {
      const path = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.mode === '40000' || ent.mode === '040000') walk(ent.oid, path);
      else if (ent.mode === '100644' || ent.mode === '100755' || ent.mode === '120000') files.set(path, ent.oid);
    }
  };
  if (obj.tree) walk(obj.tree, '');
  obj.files = files;
  return files;
}

export function resolveRev(repo: GitRepo, name: string | null): string | null {
  if (!name) return repo.refs.get(repo.head) ?? null;
  const lower = name.toLowerCase();
  if (/^[0-9a-f]{40}$/.test(lower) && repo.objs.has(lower)) return lower;
  if (repo.refs.has(name)) return repo.refs.get(name)!;
  if (repo.refs.has(`refs/heads/${name}`)) return repo.refs.get(`refs/heads/${name}`)!;
  if (repo.refs.has(`refs/tags/${name}`)) return repo.refs.get(`refs/tags/${name}`)!;
  return null;
}

export interface ContentHit {
  kind: 'file';
  oid: string;
  data: Buffer;
  size: number;
}

export interface DirHit {
  kind: 'dir';
  oid: string;
  entries: Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string }>;
}

export function lookupPath(repo: GitRepo, commit: string, path: string): ContentHit | DirHit | null {
  const obj = repo.objs.get(commit);
  if (!obj || obj.t !== 1 || !obj.tree) return null;
  let oid = obj.tree;
  if (path !== '') {
    for (const seg of path.split('/')) {
      const tree = repo.objs.get(oid);
      if (!tree || tree.t !== 2) return null;
      const ent = treeEnts(tree).find((entry) => entry.name === seg);
      if (!ent) return null;
      oid = ent.oid;
    }
  }
  const found = repo.objs.get(oid);
  if (!found) return null;
  if (found.t === 3) return { kind: 'file', oid, data: found.d, size: found.d.length };
  if (found.t !== 2) return null;
  const prefix = path;
  const entries = treeEnts(found).map((ent) => ({
    type: (ent.mode === '40000' || ent.mode === '040000' ? 'dir' : 'file') as 'file' | 'dir',
    name: ent.name,
    path: prefix ? `${prefix}/${ent.name}` : ent.name,
    sha: ent.oid,
  }));
  return { kind: 'dir', oid, entries };
}

function makeCommit(repo: GitRepo, tree: string, parents: string[], message: string): string {
  let msg = message;
  if (!msg.endsWith('\n')) msg += '\n';
  let body = `tree ${tree}\n`;
  for (const parent of parents) body += `parent ${parent}\n`;
  body += `author ${AUTHOR}\ncommitter ${AUTHOR}\n\n${msg}`;
  return putObj(repo, 1, Buffer.from(body));
}

export function commitMessage(data: Buffer): string {
  const text = data.toString('utf8');
  const cut = text.indexOf('\n\n');
  if (cut < 0) return '';
  let msg = text.slice(cut + 2);
  if (msg.endsWith('\n')) msg = msg.slice(0, -1);
  return msg;
}

export function commitLog(repo: GitRepo, tip: string, limit = 100): Array<{ sha: string; message: string }> {
  const out: Array<{ sha: string; message: string }> = [];
  const seen = new Set<string>();
  let oid: string | undefined = tip;
  while (oid && out.length < limit && !seen.has(oid)) {
    seen.add(oid);
    const obj = repo.objs.get(oid);
    if (!obj || obj.t !== 1) break;
    out.push({ sha: oid, message: commitMessage(obj.d) });
    oid = obj.parents?.[0];
  }
  return out;
}

export function branchNames(repo: GitRepo): Array<{ name: string; sha: string }> {
  const out: Array<{ name: string; sha: string }> = [];
  for (const [ref, oid] of repo.refs) {
    if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha: oid });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

export interface WriteResult {
  commit: string;
  blob: string;
  created: boolean;
}

export function writePath(repo: GitRepo, branch: string, path: string, bytes: Buffer, message: string, sha: string | undefined): WriteResult | 'missing' | 'stale' | 'bad-sha' {
  const ref = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
  const parent = repo.refs.get(ref) ?? null;
  const files = parent ? new Map(filesOf(repo, parent)) : new Map<string, string>();
  const current = files.get(path);
  if (sha !== undefined && current !== undefined && current !== sha.toLowerCase()) return 'stale';
  if (sha !== undefined && current === undefined) return 'bad-sha';
  if (current !== undefined && sha === undefined) return 'stale';
  const blob = putObj(repo, 3, bytes);
  files.set(path, blob);
  const tree = treeFromFiles(repo, files);
  const commit = makeCommit(repo, tree, parent ? [parent] : [], message);
  const obj = repo.objs.get(commit);
  if (obj) obj.files = files;
  repo.refs.set(ref, commit);
  dirty(repo);
  return { commit, blob, created: current === undefined };
}

export function deletePath(repo: GitRepo, branch: string, path: string, message: string, sha: string): string | 'missing' | 'stale' {
  const ref = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
  const parent = repo.refs.get(ref);
  if (!parent) return 'missing';
  const files = new Map(filesOf(repo, parent));
  const current = files.get(path);
  if (current === undefined) return 'missing';
  if (current !== sha.toLowerCase()) return 'stale';
  files.delete(path);
  const tree = treeFromFiles(repo, files);
  const commit = makeCommit(repo, tree, [parent], message);
  const obj = repo.objs.get(commit);
  if (obj) obj.files = files;
  repo.refs.set(ref, commit);
  dirty(repo);
  return commit;
}

export function createRef(repo: GitRepo, ref: string, oid: string): 'ok' | 'missing' | 'exists' {
  if (!repo.objs.has(oid)) return 'missing';
  if (repo.refs.has(ref)) return 'exists';
  repo.refs.set(ref, oid);
  dirty(repo);
  return 'ok';
}

export interface DiffFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function lineCount(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
  if (buf[buf.length - 1] === 10) n--;
  return n;
}

export function diffCommits(repo: GitRepo, base: string, head: string): DiffFile[] {
  const left = filesOf(repo, base);
  const right = filesOf(repo, head);
  const out: DiffFile[] = [];
  const paths = new Set<string>([...left.keys(), ...right.keys()]);
  const names = [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const path of names) {
    const a = left.get(path);
    const b = right.get(path);
    if (a === b) continue;
    const oldBuf = a ? (repo.objs.get(a)?.d ?? Buffer.alloc(0)) : Buffer.alloc(0);
    const newBuf = b ? (repo.objs.get(b)?.d ?? Buffer.alloc(0)) : Buffer.alloc(0);
    const additions = b ? Math.max(lineCount(newBuf), newBuf.length > 0 ? 1 : 0) : 0;
    const deletions = a ? lineCount(oldBuf) : 0;
    out.push({
      filename: path,
      status: !a ? 'added' : !b ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return out;
}

function ancestors(repo: GitRepo, oid: string): Set<string> {
  const seen = new Set<string>();
  const queue = [oid];
  let qi = 0;
  while (qi < queue.length) {
    const cur = queue[qi++]!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.objs.get(cur);
    if (!obj || obj.t !== 1) continue;
    for (const parent of obj.parents ?? []) queue.push(parent);
  }
  return seen;
}

function findLca(repo: GitRepo, a: string, b: string): string | null {
  const left = ancestors(repo, a);
  const seen = new Set<string>();
  const queue = [b];
  let qi = 0;
  while (qi < queue.length) {
    const cur = queue[qi++]!;
    if (left.has(cur)) return cur;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.objs.get(cur);
    if (!obj || obj.t !== 1) continue;
    for (const parent of obj.parents ?? []) queue.push(parent);
  }
  return null;
}

export function squashMerge(repo: GitRepo, baseRef: string, headRef: string, message: string): { sha: string } | 'missing' | 'conflict' {
  const baseName = baseRef.startsWith('refs/') ? baseRef : `refs/heads/${baseRef}`;
  const headName = headRef.startsWith('refs/') ? headRef : `refs/heads/${headRef}`;
  const base = repo.refs.get(baseName);
  const head = repo.refs.get(headName);
  if (!base || !head) return 'missing';
  const lca = findLca(repo, base, head);
  const origin = lca ? filesOf(repo, lca) : new Map<string, string>();
  const ours = filesOf(repo, base);
  const theirs = filesOf(repo, head);
  const paths = new Set<string>([...origin.keys(), ...ours.keys(), ...theirs.keys()]);
  const result = new Map<string, string>();
  for (const path of paths) {
    const o = origin.get(path);
    const a = ours.get(path);
    const b = theirs.get(path);
    if (a === b) {
      if (a) result.set(path, a);
      continue;
    }
    if (o === a) {
      if (b) result.set(path, b);
      continue;
    }
    if (o === b) {
      if (a) result.set(path, a);
      continue;
    }
    return 'conflict';
  }
  const tree = treeFromFiles(repo, result);
  const sha = makeCommit(repo, tree, [base], message);
  const obj = repo.objs.get(sha);
  if (obj) obj.files = result;
  repo.refs.set(baseName, sha);
  dirty(repo);
  return { sha };
}

export function mergeable(repo: GitRepo, baseRef: string, headRef: string): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  const base = repo.refs.get(baseRef.startsWith('refs/') ? baseRef : `refs/heads/${baseRef}`);
  const head = repo.refs.get(headRef.startsWith('refs/') ? headRef : `refs/heads/${headRef}`);
  if (!base || !head) return 'UNKNOWN';
  const lca = findLca(repo, base, head);
  const origin = lca ? filesOf(repo, lca) : new Map<string, string>();
  const ours = filesOf(repo, base);
  const theirs = filesOf(repo, head);
  const paths = new Set<string>([...origin.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const o = origin.get(path);
    const a = ours.get(path);
    const b = theirs.get(path);
    if (a === b || o === a || o === b) continue;
    return 'CONFLICTING';
  }
  return 'MERGEABLE';
}
