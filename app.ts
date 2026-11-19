// HTTP surface: GitHub REST v3, GraphQL, MCP and git smart HTTP, one in-memory store.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  advertiseReceive,
  advertiseUpload,
  branchNames,
  commitLog,
  createGitRepo,
  createRef,
  deletePath,
  diffCommits,
  handleReceive,
  handleUpload,
  lookupPath,
  mergeable,
  resolveRev,
  squashMerge,
  writePath,
  type GitRepo,
} from './git.ts';

const VIEWER = 'adaiversen';
const JSON_TYPE = 'application/json; charset=utf-8';
const BEARER = `Bearer ${process.env.MAKEFUN_SHOP_TOKEN ?? ''}`;
const MERGED_AT = '1970-01-01T00:00:00Z';
const ISSUE_RE = /^\/api\/v3\/repos\/([^/?]+)\/([^/?]+)\/issues\/(\d+)$/;
const ISSUE_POST_RE = /^\/api\/v3\/repos\/([^/?]+)\/([^/?]+)\/issues$/;
const UP_AD = 'application/x-git-upload-pack-advertisement';
const RX_AD = 'application/x-git-receive-pack-advertisement';
const UP_RES = 'application/x-git-upload-pack-result';
const RX_RES = 'application/x-git-receive-pack-result';
const TEXT = 'text/plain; charset=utf-8';
const NOT_FOUND = Buffer.from('not found\n');
const BAD_REQ = Buffer.from('bad request\n');

let rid = 0;

interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Array<{ id: number; body: string }>;
  json: Buffer;
}

interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
}

interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  git: GitRepo;
  labels: Set<string>;
  issues: Issue[];
  issueByNumber: Map<number, Issue>;
  pulls: Pull[];
  pullByNumber: Map<number, Pull>;
  nextIssue: number;
  nextPull: number;
}

const repos = new Map<string, Repo>();
const order: Repo[] = [];
const repoById = new Map<number, Repo>();
let nextRepoId = 1;
let nextIssueId = 1;
let nextPullId = 1;
let nextCommentId = 1;

function keyOf(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner },
  };
}

function sealIssue(issue: Issue): void {
  issue.json = Buffer.from(
    JSON.stringify({
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((name) => ({ name })),
    }),
  );
}

function addIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
  const issue: Issue = {
    id: nextIssueId++,
    number: repo.nextIssue++,
    title,
    body,
    state: 'open',
    labels: labels.slice(),
    comments: [],
    json: Buffer.alloc(0),
  };
  sealIssue(issue);
  repo.issues.push(issue);
  repo.issueByNumber.set(issue.number, issue);
  return issue;
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.git.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
  const baseSha = repo.git.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    head: { ref: pull.head, sha: headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: baseSha, label: `${repo.owner}:${pull.base}` },
  };
}

function gid(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`010:${kind}:${parts.join(':')}`).toString('base64');
}

function parseGid(id: string): string[] | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    if (!text.startsWith('010:')) return null;
    return text.split(':');
  } catch {
    return null;
  }
}

function repoFromGid(id: string): Repo | null {
  const parts = parseGid(id);
  if (!parts || parts[1] !== 'Repository') return null;
  return repoById.get(Number(parts[2])) ?? null;
}

function issueFromGid(id: string): { repo: Repo; issue: Issue } | null {
  const parts = parseGid(id);
  if (!parts || parts[1] !== 'Issue') return null;
  const repo = repoById.get(Number(parts[2]));
  if (!repo) return null;
  const issue = repo.issueByNumber.get(Number(parts[3]));
  return issue ? { repo, issue } : null;
}

function pullFromGid(id: string): { repo: Repo; pull: Pull } | null {
  const parts = parseGid(id);
  if (!parts || parts[1] !== 'PullRequest') return null;
  const repo = repoById.get(Number(parts[2]));
  if (!repo) return null;
  const pull = repo.pullByNumber.get(Number(parts[3]));
  return pull ? { repo, pull } : null;
}

export function createApp(): Server {
  const server = createServer((req, res) => {
    const sock = req.socket;
    if (sock) sock.setNoDelay(true);
    const raw = req.url ?? '/';
    const qat = raw.indexOf('?');
    const path = qat < 0 ? raw : raw.slice(0, qat);
    if (req.method === 'GET') {
      const match = ISSUE_RE.exec(path);
      if (match) {
        if (req.headers.authorization !== BEARER) return sendJson(res, 401, { message: 'Requires authentication' });
        const repo = repos.get(keyOf(decodeURIComponent(match[1]!), decodeURIComponent(match[2]!)));
        const issue = repo?.issueByNumber.get(Number(match[3]));
        if (!repo || !issue) return sendJson(res, 404, { message: 'Not Found' });
        sendBuf(res, 200, issue.json);
        return;
      }
    } else if (req.method === 'POST' && serveIssuePost(req, res, path)) {
      return;
    }
    if (serveGit(req, res, raw, path)) return;
    handle(req, res, raw, path).catch((err) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const message = err instanceof Error ? err.message : 'Internal Server Error';
      sendJson(res, 500, { message });
    });
  });
  server.on('connection', (sock) => sock.setNoDelay(true));
  server.on('clientError', (_err, sock) => sock.destroy());
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 0;
  return server;
}

function sendBuf(res: ServerResponse, status: number, buf: Buffer, headers?: Record<string, string | number>): void {
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': buf.length,
    'x-github-request-id': String(++rid),
    'x-oauth-scopes': 'repo, read:org',
    ...headers,
  });
  res.end(buf);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string | number>): void {
  sendBuf(res, status, Buffer.from(JSON.stringify(body)), headers);
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'content-length': 0, 'x-github-request-id': String(++rid) });
  res.end();
}

function takeBody(req: IncomingMessage, done: (body: Buffer) => void, fail: () => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let settled = false;
  req.on('data', (chunk: Buffer | string) => {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += buf.length;
    if (size > 64 * 1024 * 1024) {
      req.destroy();
      return;
    }
    chunks.push(buf);
  });
  req.on('end', () => {
    if (settled) return;
    settled = true;
    done(chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks));
  });
  req.on('error', () => {
    if (settled) return;
    settled = true;
    fail();
  });
}

function repoAt(path: string, a: string, b: string): Repo | null {
  return repos.get(keyOf(decodeURIComponent(a), decodeURIComponent(b))) ?? null;
}

function serveIssuePost(req: IncomingMessage, res: ServerResponse, path: string): boolean {
  const match = ISSUE_POST_RE.exec(path);
  if (!match) return false;
  if (req.headers.authorization !== BEARER) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }
  const repo = repoAt(path, match[1]!, match[2]!);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  takeBody(req, (body) => {
    if (body.length === 0) {
      createIssue(res, repo, {});
      return;
    }
    let parsed: Record<string, unknown> | null = null;
    try {
      const value = JSON.parse(body.toString('utf8')) as unknown;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      parsed = value as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    createIssue(res, repo, parsed);
  }, () => {
    if (!res.headersSent) sendJson(res, 400, { message: 'Problems parsing JSON' });
  });
  return true;
}

function serviceOf(raw: string): string {
  const q = raw.indexOf('?');
  if (q < 0) return '';
  const query = raw.slice(q + 1);
  let from = 0;
  while (from <= query.length) {
    const amp = query.indexOf('&', from);
    const part = amp < 0 ? query.slice(from) : query.slice(from, amp);
    if (part.startsWith('service=')) return decodeURIComponent(part.slice(8));
    if (amp < 0) break;
    from = amp + 1;
  }
  return '';
}

function serveGit(req: IncomingMessage, res: ServerResponse, raw: string, path: string): boolean {
  const gitAt = path.indexOf('.git/');
  if (gitAt < 1) return false;
  const slash = path.lastIndexOf('/', gitAt);
  if (slash <= 0) return false;
  if (req.headers.authorization !== BEARER) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }
  let owner: string;
  let name: string;
  try {
    owner = decodeURIComponent(path.slice(1, slash));
    name = decodeURIComponent(path.slice(slash + 1, gitAt));
  } catch {
    sendJson(res, 400, { message: 'Bad request' });
    return true;
  }
  const repo = repos.get(keyOf(owner, name));
  const tail = path.slice(gitAt + 4);
  if (!repo) {
    sendRaw(res, 404, TEXT, NOT_FOUND);
    return true;
  }
  if (req.method === 'GET' && tail === '/info/refs') {
    const service = serviceOf(raw);
    const v2 = String(req.headers['git-protocol'] ?? '').includes('version=2');
    if (service === 'git-upload-pack') {
      sendRaw(res, 200, UP_AD, advertiseUpload(repo.git, v2));
      return true;
    }
    if (service === 'git-receive-pack') {
      sendRaw(res, 200, RX_AD, advertiseReceive(repo.git));
      return true;
    }
    sendJson(res, 400, { message: 'service required' });
    return true;
  }
  if (req.method === 'POST' && (tail === '/git-upload-pack' || tail === '/git-receive-pack')) {
    const upload = tail === '/git-upload-pack';
    const v2 = upload && String(req.headers['git-protocol'] ?? '').includes('version=2');
    takeBody(req, (body) => {
      try {
        const out = upload ? handleUpload(repo.git, body, v2) : handleReceive(repo.git, body);
        sendRaw(res, 200, upload ? UP_RES : RX_RES, out);
      } catch {
        if (!res.headersSent) sendRaw(res, 400, TEXT, BAD_REQ);
      }
    }, () => {
      if (!res.headersSent) sendRaw(res, 400, TEXT, BAD_REQ);
    });
    return true;
  }
  return false;
}

function sendRaw(res: ServerResponse, status: number, type: string, buf: Buffer): void {
  res.writeHead(status, { 'content-type': type, 'content-length': buf.length, 'cache-control': 'no-cache' });
  res.end(buf);
}

function authed(req: IncomingMessage): boolean {
  return req.headers.authorization === BEARER;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    if (size > 64 * 1024 * 1024) throw new Error('body too large');
    chunks.push(buf);
  }
  return chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
}

function partsOf(path: string): string[] {
  const out: string[] = [];
  let start = path.charCodeAt(0) === 47 ? 1 : 0;
  for (let i = start; i <= path.length; i++) {
    if (i === path.length || path.charCodeAt(i) === 47) {
      if (i > start) out.push(decodeURIComponent(path.slice(start, i)));
      start = i + 1;
    }
  }
  return out;
}

async function handle(req: IncomingMessage, res: ServerResponse, raw: string, path: string): Promise<void> {
  if (path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }
  const method = req.method ?? 'GET';
  if (path === '/mcp') {
    await mcp(req, res, method);
    return;
  }
  if (path === '/api/graphql') {
    await graphql(req, res, method);
    return;
  }
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authed(req)) return sendJson(res, 401, { message: 'Requires authentication' });
    await rest(req, res, method, raw, path);
    return;
  }
  const parts = partsOf(path);
  if (parts.length >= 2 && parts[1]!.endsWith('.git')) {
    if (!authed(req)) return sendJson(res, 401, { message: 'Requires authentication' });
    await gitHttp(req, res, method, raw, parts);
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}

async function gitHttp(req: IncomingMessage, res: ServerResponse, method: string, raw: string, parts: string[]): Promise<void> {
  const owner = parts[0]!;
  const name = parts[1]!.slice(0, -4);
  const repo = repos.get(keyOf(owner, name));
  const rest = parts.slice(2);
  if (!repo) {
    sendRaw(res, 404, 'text/plain; charset=utf-8', Buffer.from('not found\n'));
    return;
  }
  try {
    if (method === 'GET' && rest[0] === 'info' && rest[1] === 'refs') {
      const q = raw.indexOf('?');
      const params = new URLSearchParams(q < 0 ? '' : raw.slice(q + 1));
      const service = params.get('service');
      const v2 = String(req.headers['git-protocol'] ?? '').includes('version=2');
      if (service === 'git-upload-pack') {
        sendRaw(res, 200, 'application/x-git-upload-pack-advertisement', advertiseUpload(repo.git, v2));
        return;
      }
      if (service === 'git-receive-pack') {
        sendRaw(res, 200, 'application/x-git-receive-pack-advertisement', advertiseReceive(repo.git));
        return;
      }
      sendJson(res, 400, { message: 'service required' });
      return;
    }
    if (method === 'POST' && rest[0] === 'git-upload-pack') {
      const body = await readBody(req);
      const v2 = String(req.headers['git-protocol'] ?? '').includes('version=2');
      sendRaw(res, 200, 'application/x-git-upload-pack-result', handleUpload(repo.git, body, v2));
      return;
    }
    if (method === 'POST' && rest[0] === 'git-receive-pack') {
      const body = await readBody(req);
      sendRaw(res, 200, 'application/x-git-receive-pack-result', handleReceive(repo.git, body));
      return;
    }
  } catch {
    if (!res.headersSent) sendRaw(res, 400, 'text/plain; charset=utf-8', Buffer.from('bad request\n'));
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}

async function rest(req: IncomingMessage, res: ServerResponse, method: string, raw: string, path: string): Promise<void> {
  let parts: string[];
  try {
    parts = partsOf(path);
  } catch {
    sendJson(res, 400, { message: 'Bad request' });
    return;
  }
  const p = parts.slice(2);
  const qat = raw.indexOf('?');
  const query = new URLSearchParams(qat < 0 ? '' : raw.slice(qat + 1));
  if (p.length === 0) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' });
    return;
  }
  if (p[0] === 'meta' && p.length === 1) {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return;
  }
  if (p[0] === 'user' && p.length === 1 && method === 'GET') {
    sendJson(res, 200, { login: VIEWER, id: 1000, name: 'ada iversen' });
    return;
  }
  if (p[0] === 'user' && p[1] === 'repos' && p.length === 2) {
    if (method === 'GET') return listRepos(req, res, query);
    if (method === 'POST') return createRepo(res, await jsonBody(req, res));
  }
  if (p[0] === 'repos' && p.length >= 3) {
    const owner = p[1]!;
    const name = p[2]!;
    const repo = repos.get(keyOf(owner, name));
    const tail = p.slice(3);
    if (tail.length === 0) {
      if (!repo) return sendJson(res, 404, { message: 'Not Found' });
      if (method === 'GET') return sendJson(res, 200, repoJson(repo));
      if (method === 'PATCH') return patchRepo(res, repo, await jsonBody(req, res));
      if (method === 'DELETE') {
        repos.delete(keyOf(owner, name));
        const idx = order.indexOf(repo);
        if (idx >= 0) order.splice(idx, 1);
        repoById.delete(repo.id);
        return sendEmpty(res, 204);
      }
    }
    if (!repo) return sendJson(res, 404, { message: 'Not Found' });
    if (tail[0] === 'contents') return contents(req, res, method, repo, tail.slice(1).join('/'), query);
    if (tail[0] === 'git' && tail[1] === 'refs' && tail.length === 2 && method === 'POST') return createGitRef(res, repo, await jsonBody(req, res));
    if (tail[0] === 'git' && tail[1] === 'refs' && tail[2] === 'heads' && method === 'GET') return getRef(res, repo, tail.slice(3).join('/'));
    if (tail[0] === 'branches' && tail.length === 1 && method === 'GET') {
      return sendJson(res, 200, branchNames(repo.git).map((branch) => ({ name: branch.name, commit: { sha: branch.sha } })));
    }
    if (tail[0] === 'branches' && method === 'GET') return getBranch(res, repo, tail.slice(1).join('/'));
    if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') return listCommits(res, repo, query.get('sha'));
    if (tail[0] === 'labels' && tail.length === 1 && method === 'POST') return createLabel(res, repo, await jsonBody(req, res));
    if (tail[0] === 'issues' && tail.length === 1) {
      if (method === 'GET') return listIssues(res, repo, query);
      if (method === 'POST') return createIssue(res, repo, await jsonBody(req, res));
    }
    if (tail[0] === 'issues' && tail.length === 2) {
      const issue = repo.issueByNumber.get(Number(tail[1]));
      if (!issue || !Number.isInteger(Number(tail[1]))) return sendJson(res, 404, { message: 'Not Found' });
      if (method === 'GET') return sendBuf(res, 200, issue.json);
      if (method === 'PATCH') return patchIssue(res, issue, await jsonBody(req, res));
    }
    if (tail[0] === 'issues' && tail[2] === 'comments') {
      const issue = repo.issueByNumber.get(Number(tail[1]));
      if (!issue) return sendJson(res, 404, { message: 'Not Found' });
      if (method === 'GET') return sendJson(res, 200, issue.comments.map((comment) => ({ id: comment.id, body: comment.body })));
      if (method === 'POST') return createComment(res, issue, await jsonBody(req, res));
    }
    if (tail[0] === 'pulls' && tail.length === 1) {
      if (method === 'GET') return listPulls(res, repo, query);
      if (method === 'POST') return createPull(res, repo, await jsonBody(req, res));
    }
    if (tail[0] === 'pulls' && tail.length === 2 && method === 'GET') {
      const pull = repo.pullByNumber.get(Number(tail[1]));
      if (!pull) return sendJson(res, 404, { message: 'Not Found' });
      return sendJson(res, 200, pullJson(repo, pull));
    }
    if (tail[0] === 'pulls' && tail[2] === 'files' && method === 'GET') return pullFiles(res, repo, Number(tail[1]));
    if (tail[0] === 'pulls' && tail[2] === 'merge' && method === 'PUT') return mergePull(res, repo, Number(tail[1]), await jsonBody(req, res));
  }
  sendJson(res, 404, { message: 'Not Found' });
}

async function jsonBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  const buf = await readBody(req);
  if (buf.length === 0) return {};
  try {
    const value = JSON.parse(buf.toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return null;
    }
    return value as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return null;
  }
}

function listRepos(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): void {
  const per = clamp(query.get('per_page'), 30, 1, 100);
  const page = clamp(query.get('page'), 1, 1, 100000);
  const start = (page - 1) * per;
  const slice = order.slice(start, start + per);
  const headers: Record<string, string | number> = {};
  if (start + per < order.length) {
    const host = req.headers.host ?? '127.0.0.1';
    headers.link = `<http://${host}/api/v3/user/repos?per_page=${per}&page=${page + 1}>; rel="next"`;
  }
  sendJson(res, 200, slice.map(repoJson), headers);
}

function createRepo(res: ServerResponse, body: Record<string, unknown> | null): void {
  if (body === null || res.headersSent) return;
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '' || name.length > 100 || name.includes('/') || name.includes(' ')) {
    sendJson(res, 422, { message: 'Repository name is invalid' });
    return;
  }
  if (repos.has(keyOf(VIEWER, name))) {
    sendJson(res, 422, { message: 'Repository already exists' });
    return;
  }
  const repo: Repo = {
    id: nextRepoId++,
    name,
    owner: VIEWER,
    description: typeof body.description === 'string' ? body.description : '',
    private: body.private === true,
    defaultBranch: 'main',
    git: createGitRepo(),
    labels: new Set(),
    issues: [],
    issueByNumber: new Map(),
    pulls: [],
    pullByNumber: new Map(),
    nextIssue: 1,
    nextPull: 1,
  };
  repos.set(keyOf(VIEWER, name), repo);
  order.push(repo);
  repoById.set(repo.id, repo);
  sendJson(res, 201, { name: repo.name, private: repo.private, default_branch: repo.defaultBranch, id: repo.id, description: repo.description });
}

function patchRepo(res: ServerResponse, repo: Repo, body: Record<string, unknown> | null): void {
  if (body === null || res.headersSent) return;
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.private === 'boolean') repo.private = body.private;
  if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
  sendJson(res, 200, repoJson(repo));
}

function contents(req: IncomingMessage, res: ServerResponse, method: string, repo: Repo, path: string, query: URLSearchParams): Promise<void> | void {
  const branch = query.get('ref') ?? repo.defaultBranch;
  if (method === 'GET') {
    const tip = resolveRev(repo.git, query.get('ref'));
    if (!tip) return sendJson(res, 404, { message: 'Not Found' });
    const hit = lookupPath(repo.git, tip, path);
    if (!hit) return sendJson(res, 404, { message: 'Not Found' });
    if (hit.kind === 'dir') return sendJson(res, 200, hit.entries);
    return sendJson(res, 200, {
      type: 'file',
      encoding: 'base64',
      name: path.split('/').pop() ?? path,
      path,
      content: hit.data.toString('base64'),
      sha: hit.oid,
      size: hit.size,
    });
  }
  if (method === 'PUT' || method === 'DELETE') {
    return jsonBody(req, res).then((body) => {
      if (body === null || res.headersSent) return;
      const message = typeof body.message === 'string' ? body.message : 'update';
      const target = typeof body.branch === 'string' && body.branch !== '' ? body.branch : branch;
      const sha = typeof body.sha === 'string' ? body.sha : undefined;
      if (method === 'DELETE') {
        if (!sha) return sendJson(res, 409, { message: 'sha is required' });
        const result = deletePath(repo.git, target, path, message, sha);
        if (result === 'missing') return sendJson(res, 404, { message: 'Not Found' });
        if (result === 'stale') return sendJson(res, 409, { message: 'sha does not match' });
        return sendJson(res, 200, { commit: { sha: result }, content: null });
      }
      const content = typeof body.content === 'string' ? body.content : null;
      if (content === null) return sendJson(res, 422, { message: 'content is required' });
      let bytes: Buffer;
      try {
        bytes = Buffer.from(content, 'base64');
      } catch {
        return sendJson(res, 422, { message: 'content is not base64' });
      }
      const result = writePath(repo.git, target, path, bytes, message, sha);
      if (result === 'missing') return sendJson(res, 404, { message: 'Not Found' });
      if (result === 'stale') return sendJson(res, 409, { message: 'sha does not match' });
      if (result === 'bad-sha') return sendJson(res, 422, { message: 'sha does not match' });
      sendJson(res, result.created ? 201 : 200, { content: { sha: result.blob, encoding: 'base64' }, commit: { sha: result.commit } });
    });
  }
  sendJson(res, 404, { message: 'Not Found' });
}

function createGitRef(res: ServerResponse, repo: Repo, body: Record<string, unknown> | null): void {
  if (body === null || res.headersSent) return;
  const ref = typeof body.ref === 'string' ? body.ref : '';
  const sha = typeof body.sha === 'string' ? body.sha.toLowerCase() : '';
  if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) return sendJson(res, 422, { message: 'Invalid ref' });
  const result = createRef(repo.git, ref, sha);
  if (result === 'missing') return sendJson(res, 422, { message: 'Object does not exist' });
  if (result === 'exists') return sendJson(res, 422, { message: 'Reference already exists' });
  sendJson(res, 201, { ref, object: { sha, type: 'commit' } });
}

function getRef(res: ServerResponse, repo: Repo, branch: string): void {
  const sha = repo.git.refs.get(`refs/heads/${branch}`);
  if (!sha) return sendJson(res, 404, { message: 'Not Found' });
  sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
}

function getBranch(res: ServerResponse, repo: Repo, branch: string): void {
  const sha = repo.git.refs.get(`refs/heads/${branch}`);
  if (!sha) return sendJson(res, 404, { message: 'Not Found' });
  sendJson(res, 200, { name: branch, commit: { sha } });
}

function listCommits(res: ServerResponse, repo: Repo, sha: string | null): void {
  const tip = resolveRev(repo.git, sha);
  if (!tip) return sendJson(res, 200, []);
  const obj = repo.git.objs.get(tip);
  const start = obj && obj.t === 1 ? tip : null;
  if (!start) return sendJson(res, 200, []);
  sendJson(res, 200, commitLog(repo.git, start).map((commit) => ({ sha: commit.sha, commit: { message: commit.message } })));
}

function createLabel(res: ServerResponse, repo: Repo, body: Record<string, unknown> | null): void {
  if (body === null || res.headersSent) return;
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '') return sendJson(res, 422, { message: 'name is required' });
  repo.labels.add(name);
  sendJson(res, 201, { name, color: typeof body.color === 'string' ? body.color : 'ededed' });
}

function listIssues(res: ServerResponse, repo: Repo, query: URLSearchParams): void {
  const state = query.get('state') ?? 'open';
  let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
  const dir = query.get('direction') === 'asc' ? 1 : -1;
  list = list.slice().sort((a, b) => (a.number - b.number) * dir);
  const per = clamp(query.get('per_page'), 30, 1, 100);
  const page = clamp(query.get('page'), 1, 1, 100000);
  const start = (page - 1) * per;
  sendJson(res, 200, list.slice(start, start + per).map((issue) => JSON.parse(issue.json.toString('utf8')) as unknown));
}

function createIssue(res: ServerResponse, repo: Repo, body: Record<string, unknown> | null): void {
  if (body === null || res.headersSent) return;
  const title = typeof body.title === 'string' ? body.title : '';
  if (title === '') return sendJson(res, 422, { message: 'title is required' });
  const labels = Array.isArray(body.labels) ? body.labels.filter((label): label is string => typeof label === 'string') : [];
  for (const label of labels) {
    if (!repo.labels.has(label)) return sendJson(res, 422, { message: `Label ${label} does not exist` });
  }
  const issue = addIssue(repo, title, typeof body.body === 'string' ? body.body : '', labels);
  sendBuf(res, 201, issue.json);
}

function patchIssue(res: ServerResponse, issue: Issue, body: Record<string, unknown> | null): void {
  if (body === null || res.headersSent) return;
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
  sealIssue(issue);
  sendBuf(res, 200, issue.json);
}

function createComment(res: ServerResponse, issue: Issue, body: Record<string, unknown> | null): void {
  if (body === null || res.headersSent) return;
  const text = typeof body.body === 'string' ? body.body : '';
  const comment = { id: nextCommentId++, body: text };
  issue.comments.push(comment);
  sendJson(res, 201, { id: comment.id, body: comment.body });
}

function listPulls(res: ServerResponse, repo: Repo, query: URLSearchParams): void {
  const state = query.get('state') ?? 'open';
  let list = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
  const per = clamp(query.get('per_page'), 30, 1, 100);
  const page = clamp(query.get('page'), 1, 1, 100000);
  const start = (page - 1) * per;
  sendJson(res, 200, list.slice(start, start + per).map((pull) => pullJson(repo, pull)));
}

function createPull(res: ServerResponse, repo: Repo, body: Record<string, unknown> | null): void {
  if (body === null || res.headersSent) return;
  const title = typeof body.title === 'string' ? body.title : '';
  const head = typeof body.head === 'string' ? body.head : '';
  const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
  if (title === '' || head === '' || base === '') return sendJson(res, 422, { message: 'title, head and base are required' });
  const headSha = repo.git.refs.get(`refs/heads/${head}`);
  const baseSha = repo.git.refs.get(`refs/heads/${base}`);
  if (!headSha || !baseSha) return sendJson(res, 422, { message: 'head or base does not exist' });
  const pull: Pull = {
    id: nextPullId++,
    number: repo.nextPull++,
    title,
    body: typeof body.body === 'string' ? body.body : '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeSha: null,
    head,
    base,
    headSha,
    baseSha,
  };
  repo.pulls.push(pull);
  repo.pullByNumber.set(pull.number, pull);
  sendJson(res, 201, pullJson(repo, pull));
}

function pullFiles(res: ServerResponse, repo: Repo, number: number): void {
  const pull = repo.pullByNumber.get(number);
  if (!pull) return sendJson(res, 404, { message: 'Not Found' });
  const base = repo.git.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
  const head = repo.git.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
  sendJson(res, 200, diffCommits(repo.git, base, head).filter((file) => file.status !== 'removed'));
}

function mergePull(res: ServerResponse, repo: Repo, number: number, body: Record<string, unknown> | null): void {
  if (body === null || res.headersSent) return;
  const pull = repo.pullByNumber.get(number);
  if (!pull) return sendJson(res, 404, { message: 'Not Found' });
  if (pull.merged) return sendJson(res, 405, { message: 'Pull request is already merged' });
  const method = typeof body.merge_method === 'string' ? body.merge_method : 'squash';
  if (method !== 'squash') return sendJson(res, 405, { message: 'Only squash merges are supported' });
  const message = typeof body.commit_message === 'string' && body.commit_message !== '' ? body.commit_message : pull.title;
  const result = squashMerge(repo.git, pull.base, pull.head, message);
  if (result === 'missing') return sendJson(res, 404, { message: 'Not Found' });
  if (result === 'conflict') return sendJson(res, 405, { message: 'Merge conflict' });
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = MERGED_AT;
  pull.mergeSha = result.sha;
  pull.baseSha = result.sha;
  sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
}

function clamp(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

// ---------------------------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------------------------

type Val = { k: 'lit'; x: unknown } | { k: 'var'; n: string } | { k: 'enum'; n: string } | { k: 'list'; xs: Val[] } | { k: 'obj'; fs: Array<[string, Val]> };
interface SelField { kind: 'field'; alias: string; name: string; args: Array<[string, Val]>; sels: Sel[] }
interface SelFrag { kind: 'frag'; type: string; sels: Sel[] }
type Sel = SelField | SelFrag;
interface GqlOp { kind: 'query' | 'mutation'; sels: Sel[] }

const SCHEMA: Record<string, { fields?: string[]; enums?: string[] }> = {
  Issue: { fields: ['id', 'number', 'title', 'state', 'body'] },
  PullRequest: { fields: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'] },
  Repository: { fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'] },
  SearchType: { enums: ['ISSUE', 'REPOSITORY', 'USER'] },
};

async function graphql(req: IncomingMessage, res: ServerResponse, method: string): Promise<void> {
  if (method !== 'POST') return sendJson(res, 404, { message: 'Not Found' });
  if (!authed(req)) return sendJson(res, 401, { message: 'Requires authentication' });
  const buf = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return;
  }
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map((item) => runOp(item)));
    return;
  }
  sendJson(res, 200, runOp(parsed));
}

function runOp(item: unknown): { data: unknown; errors?: Array<{ message: string }> } {
  const errors: Array<{ message: string }> = [];
  try {
    if (typeof item !== 'object' || item === null) throw new Error('operation is not an object');
    const rec = item as { query?: unknown; variables?: unknown };
    if (typeof rec.query !== 'string') throw new Error('query is required');
    const op = parseOp(rec.query);
    const vars = rec.variables && typeof rec.variables === 'object' ? (rec.variables as Record<string, unknown>) : {};
    const data = exec(op, vars, errors);
    return errors.length ? { data, errors } : { data };
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL error' }] };
  }
}

function exec(op: GqlOp, vars: Record<string, unknown>, errors: Array<{ message: string }>): unknown {
  return execObj(op.kind === 'mutation' ? 'Mutation' : 'Query', { kind: op.kind }, op.sels, vars, errors);
}

function execObj(type: string, value: unknown, sels: Sel[], vars: Record<string, unknown>, errors: Array<{ message: string }>): unknown {
  if (value == null) return null;
  const out: Record<string, unknown> = {};
  for (const sel of sels) {
    if (sel.kind === 'frag') {
      if (sel.type === type) {
        const inner = execObj(type, value, sel.sels, vars, errors);
        if (inner && typeof inner === 'object') Object.assign(out, inner as Record<string, unknown>);
      }
      continue;
    }
    try {
      out[sel.alias] = field(type, value, sel, vars, errors);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : 'field error' });
      out[sel.alias] = null;
    }
  }
  return out;
}

interface Spec {
  kind: 'scalar' | 'object' | 'list';
  type?: string;
  value?: unknown;
  items?: unknown[];
}

function field(type: string, value: unknown, sel: SelField, vars: Record<string, unknown>, errors: Array<{ message: string }>): unknown {
  const args: Record<string, unknown> = {};
  for (const [name, val] of sel.args) args[name] = resolveVal(val, vars);
  const spec = lookup(type, value, sel.name, args);
  if (!spec) {
    errors.push({ message: `Cannot query field "${sel.name}" on type "${type}".` });
    return null;
  }
  if (spec.kind === 'scalar') return spec.value ?? null;
  if (spec.kind === 'list') return (spec.items ?? []).map((item) => (item == null ? null : execObj(spec.type ?? 'Unknown', item, sel.sels, vars, errors)));
  if (spec.value == null) return null;
  return execObj(spec.type ?? 'Unknown', spec.value, sel.sels, vars, errors);
}

function lookup(type: string, value: unknown, name: string, args: Record<string, unknown>): Spec | null {
  if (type === 'Query') {
    if (name === 'viewer') return { kind: 'object', type: 'User', value: { login: VIEWER } };
    if (name === 'repository') {
      const owner = String(args.owner ?? '');
      const repoName = String(args.name ?? '');
      return { kind: 'object', type: 'Repository', value: repos.get(keyOf(owner, repoName)) ?? null };
    }
    if (name === 'node') {
      const repo = repoFromGid(String(args.id ?? ''));
      return { kind: 'object', type: 'Repository', value: repo };
    }
    if (name === '__type') {
      const schema = SCHEMA[String(args.name ?? '')];
      return { kind: 'object', type: '__Type', value: schema ? { name: String(args.name), ...schema } : null };
    }
    return null;
  }
  if (type === 'Mutation') {
    if (name === 'createIssue') return mutateCreateIssue(args);
    if (name === 'closeIssue') return mutateCloseIssue(args);
    if (name === 'createPullRequest') return mutateCreatePull(args);
    if (name === 'mergePullRequest') return mutateMerge(args);
    if (name === 'addComment') return mutateComment(args);
    return null;
  }
  if (type === 'User') {
    const user = value as { login: string };
    if (name === 'login') return { kind: 'scalar', value: user.login };
    return null;
  }
  if (type === 'Repository') return repoField(value as Repo, name, args);
  if (type === 'Ref') {
    if (name === 'name') return { kind: 'scalar', value: (value as { name: string }).name };
    return null;
  }
  if (type === 'Issue') return issueField(value as Issue, name);
  if (type === 'IssueConnection') return connectionField(value, name, 'Issue');
  if (type === 'PullRequestConnection') return connectionField(value, name, 'PullRequest');
  if (type === 'PullRequest') return pullField(value as { repo: Repo; pull: Pull }, name, args);
  if (type === 'FileConnection') return connectionField(value, name, 'File');
  if (type === 'File') {
    if (name === 'path') return { kind: 'scalar', value: (value as { path: string }).path };
    return null;
  }
  if (type === 'PageInfo') {
    const info = value as { hasNextPage: boolean; endCursor: string | null };
    if (name === 'hasNextPage') return { kind: 'scalar', value: info.hasNextPage };
    if (name === 'endCursor') return { kind: 'scalar', value: info.endCursor };
    return null;
  }
  if (type === 'CreateIssuePayload' || type === 'CloseIssuePayload') {
    if (name === 'issue') return { kind: 'object', type: 'Issue', value: (value as { issue: Issue }).issue };
    return null;
  }
  if (type === 'CreatePullPayload') {
    if (name === 'pullRequest') return { kind: 'object', type: 'PullRequest', value: (value as { pull: { repo: Repo; pull: Pull } }).pull };
    return null;
  }
  if (type === 'MergePayload') {
    if (name === 'pullRequest') return { kind: 'object', type: 'PullRequest', value: (value as { pull: { repo: Repo; pull: Pull } }).pull };
    return null;
  }
  if (type === 'AddCommentPayload') {
    if (name === 'commentEdge') return { kind: 'object', type: 'CommentEdge', value: (value as { edge: { node: { id: number; body: string } } }).edge };
    return null;
  }
  if (type === 'CommentEdge') {
    if (name === 'node') return { kind: 'object', type: 'Comment', value: (value as { node: { id: number; body: string } }).node };
    return null;
  }
  if (type === 'Comment') {
    const comment = value as { id: number; body: string };
    if (name === 'id') return { kind: 'scalar', value: gid('IssueComment', comment.id) };
    if (name === 'body') return { kind: 'scalar', value: comment.body };
    return null;
  }
  if (type === '__Type') {
    const schema = value as { name: string; fields?: string[]; enums?: string[] };
    if (name === 'name') return { kind: 'scalar', value: schema.name };
    if (name === 'fields') return { kind: 'list', type: '__Field', items: (schema.fields ?? []).map((fieldName) => ({ name: fieldName })) };
    if (name === 'enumValues') return { kind: 'list', type: '__EnumValue', items: (schema.enums ?? []).map((fieldName) => ({ name: fieldName })) };
    return null;
  }
  if (type === '__Field' || type === '__EnumValue') {
    if (name === 'name') return { kind: 'scalar', value: (value as { name: string }).name };
    return null;
  }
  return null;
}

function repoField(repo: Repo, name: string, args: Record<string, unknown>): Spec | null {
  if (name === 'id') return { kind: 'scalar', value: gid('Repository', repo.id) };
  if (name === 'databaseId') return { kind: 'scalar', value: repo.id };
  if (name === 'name') return { kind: 'scalar', value: repo.name };
  if (name === 'nameWithOwner') return { kind: 'scalar', value: `${repo.owner}/${repo.name}` };
  if (name === 'viewerPermission') return { kind: 'scalar', value: 'ADMIN' };
  if (name === 'hasIssuesEnabled') return { kind: 'scalar', value: true };
  if (name === 'owner') return { kind: 'object', type: 'User', value: { login: repo.owner } };
  if (name === 'defaultBranchRef') {
    const oid = repo.git.refs.get(`refs/heads/${repo.defaultBranch}`);
    return { kind: 'object', type: 'Ref', value: oid ? { name: repo.defaultBranch } : null };
  }
  if (name === 'issue') {
    const issue = repo.issueByNumber.get(Number(args.number));
    return { kind: 'object', type: 'Issue', value: issue ?? null };
  }
  if (name === 'pullRequest') {
    const pull = repo.pullByNumber.get(Number(args.number));
    return { kind: 'object', type: 'PullRequest', value: pull ? { repo, pull } : null };
  }
  if (name === 'issues') return { kind: 'object', type: 'IssueConnection', value: pageIssues(repo, args) };
  if (name === 'pullRequests') return { kind: 'object', type: 'PullRequestConnection', value: pagePulls(repo, args) };
  return null;
}

function issueField(issue: Issue, name: string): Spec | null {
  if (name === 'id') return { kind: 'scalar', value: gid('Issue', issueIdRepo(issue), issue.number) };
  if (name === 'number') return { kind: 'scalar', value: issue.number };
  if (name === 'title') return { kind: 'scalar', value: issue.title };
  if (name === 'body') return { kind: 'scalar', value: issue.body };
  if (name === 'state') return { kind: 'scalar', value: issue.state === 'open' ? 'OPEN' : 'CLOSED' };
  return null;
}

function issueIdRepo(issue: Issue): number {
  for (const repo of repoById.values()) if (repo.issueByNumber.get(issue.number) === issue) return repo.id;
  return 0;
}

function pullField(box: { repo: Repo; pull: Pull }, name: string, args: Record<string, unknown>): Spec | null {
  const { repo, pull } = box;
  if (name === 'id') return { kind: 'scalar', value: gid('PullRequest', repo.id, pull.number) };
  if (name === 'number') return { kind: 'scalar', value: pull.number };
  if (name === 'title') return { kind: 'scalar', value: pull.title };
  if (name === 'body') return { kind: 'scalar', value: pull.body };
  if (name === 'state') return { kind: 'scalar', value: pull.state === 'open' ? 'OPEN' : 'CLOSED' };
  if (name === 'merged') return { kind: 'scalar', value: pull.merged };
  if (name === 'headRefName') return { kind: 'scalar', value: pull.head };
  if (name === 'baseRefName') return { kind: 'scalar', value: pull.base };
  if (name === 'mergeable') return { kind: 'scalar', value: mergeable(repo.git, pull.base, pull.head) };
  if (name === 'files') {
    const base = repo.git.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
    const head = repo.git.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
    const files = diffCommits(repo.git, base, head).map((file) => ({ path: file.filename }));
    const first = typeof args.first === 'number' ? args.first : files.length;
    return { kind: 'object', type: 'FileConnection', value: { nodes: files.slice(0, first), pageInfo: { hasNextPage: files.length > first, endCursor: null } } };
  }
  return null;
}

function connectionField(value: unknown, name: string, itemType: string): Spec | null {
  const conn = value as { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
  if (name === 'nodes') return { kind: 'list', type: itemType, items: conn.nodes };
  if (name === 'pageInfo') return { kind: 'object', type: 'PageInfo', value: conn.pageInfo };
  return null;
}

function pageIssues(repo: Repo, args: Record<string, unknown>): { nodes: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } {
  let list = repo.issues.slice();
  const states = Array.isArray(args.states) ? args.states.map((state) => String(state)) : null;
  if (states && states.length) {
    const want = new Set(states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : state.toLowerCase())));
    list = list.filter((issue) => want.has(issue.state));
  }
  const orderBy = args.orderBy && typeof args.orderBy === 'object' ? (args.orderBy as { direction?: string }) : null;
  const desc = orderBy ? orderBy.direction !== 'ASC' : false;
  list.sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
  let start = 0;
  if (typeof args.after === 'string' && args.after.startsWith('n:')) {
    const n = Number(args.after.slice(2));
    const idx = list.findIndex((issue) => issue.number === n);
    start = idx < 0 ? list.length : idx + 1;
  }
  const first = typeof args.first === 'number' ? args.first : 30;
  const nodes = list.slice(start, start + first);
  return {
    nodes,
    pageInfo: { hasNextPage: start + first < list.length, endCursor: nodes.length ? `n:${nodes[nodes.length - 1]!.number}` : null },
  };
}

function pagePulls(repo: Repo, args: Record<string, unknown>): { nodes: Array<{ repo: Repo; pull: Pull }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } {
  const states = Array.isArray(args.states) ? args.states.map((state) => String(state)) : ['OPEN'];
  const want = new Set(states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : state.toLowerCase())));
  const list = repo.pulls.filter((pull) => want.has(pull.state));
  const first = typeof args.first === 'number' ? args.first : 30;
  const nodes = list.slice(0, first).map((pull) => ({ repo, pull }));
  return { nodes, pageInfo: { hasNextPage: list.length > first, endCursor: null } };
}

function inputOf(args: Record<string, unknown>): Record<string, unknown> {
  return args.input && typeof args.input === 'object' ? (args.input as Record<string, unknown>) : {};
}

function mutateCreateIssue(args: Record<string, unknown>): Spec {
  const input = inputOf(args);
  const repo = repoFromGid(String(input.repositoryId ?? ''));
  if (!repo) throw new Error('repository not found');
  const title = typeof input.title === 'string' ? input.title : '';
  if (title === '') throw new Error('title is required');
  const issue = addIssue(repo, title, typeof input.body === 'string' ? input.body : '', []);
  return { kind: 'object', type: 'CreateIssuePayload', value: { issue } };
}

function mutateCloseIssue(args: Record<string, unknown>): Spec {
  const input = inputOf(args);
  const found = issueFromGid(String(input.issueId ?? ''));
  if (!found) throw new Error('issue not found');
  found.issue.state = 'closed';
  sealIssue(found.issue);
  return { kind: 'object', type: 'CloseIssuePayload', value: { issue: found.issue } };
}

function mutateCreatePull(args: Record<string, unknown>): Spec {
  const input = inputOf(args);
  const repo = repoFromGid(String(input.repositoryId ?? ''));
  if (!repo) throw new Error('repository not found');
  const head = typeof input.headRefName === 'string' ? input.headRefName : '';
  const base = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
  const title = typeof input.title === 'string' ? input.title : '';
  const headSha = repo.git.refs.get(`refs/heads/${head}`);
  const baseSha = repo.git.refs.get(`refs/heads/${base}`);
  if (!headSha || !baseSha) throw new Error('head or base does not exist');
  const pull: Pull = {
    id: nextPullId++,
    number: repo.nextPull++,
    title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeSha: null,
    head,
    base,
    headSha,
    baseSha,
  };
  repo.pulls.push(pull);
  repo.pullByNumber.set(pull.number, pull);
  return { kind: 'object', type: 'CreatePullPayload', value: { pull: { repo, pull } } };
}

function mutateMerge(args: Record<string, unknown>): Spec {
  const input = inputOf(args);
  const found = pullFromGid(String(input.pullRequestId ?? ''));
  if (!found) throw new Error('pull request not found');
  const result = squashMerge(found.repo.git, found.pull.base, found.pull.head, found.pull.title);
  if (result === 'conflict') throw new Error('Merge conflict');
  if (result === 'missing') throw new Error('head or base does not exist');
  found.pull.merged = true;
  found.pull.state = 'closed';
  found.pull.mergedAt = MERGED_AT;
  found.pull.mergeSha = result.sha;
  return { kind: 'object', type: 'MergePayload', value: { pull: found } };
}

function mutateComment(args: Record<string, unknown>): Spec {
  const input = inputOf(args);
  const found = issueFromGid(String(input.subjectId ?? ''));
  if (!found) throw new Error('subject not found');
  const comment = { id: nextCommentId++, body: typeof input.body === 'string' ? input.body : '' };
  found.issue.comments.push(comment);
  return { kind: 'object', type: 'AddCommentPayload', value: { edge: { node: comment } } };
}

function resolveVal(val: Val, vars: Record<string, unknown>): unknown {
  if (val.k === 'lit' || val.k === 'enum') return val.k === 'lit' ? val.x : val.n;
  if (val.k === 'var') return vars[val.n] ?? null;
  if (val.k === 'list') return val.xs.map((item) => resolveVal(item, vars));
  const obj: Record<string, unknown> = {};
  for (const [key, item] of val.fs) obj[key] = resolveVal(item, vars);
  return obj;
}

class Parser {
  i = 0;
  s: string;
  constructor(source: string) {
    this.s = source;
  }
  skip(): void {
    const s = this.s;
    let i = this.i;
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 44) {
        i++;
        continue;
      }
      if (c === 35) {
        while (i < s.length && s.charCodeAt(i) !== 10) i++;
        continue;
      }
      break;
    }
    this.i = i;
  }
  peek(): string {
    this.skip();
    return this.s[this.i] ?? '';
  }
  eat(tok: string): boolean {
    this.skip();
    if (this.s.startsWith(tok, this.i)) {
      this.i += tok.length;
      return true;
    }
    return false;
  }
  word(tok: string): boolean {
    this.skip();
    if (!this.s.startsWith(tok, this.i)) return false;
    const after = this.s.charCodeAt(this.i + tok.length);
    if ((after >= 48 && after <= 57) || after === 95 || (after >= 65 && after <= 90) || (after >= 97 && after <= 122)) return false;
    this.i += tok.length;
    return true;
  }
  name(): string {
    this.skip();
    const m = /^[_A-Za-z][_0-9A-Za-z]*/.exec(this.s.slice(this.i));
    if (!m) throw new Error(`expected a name at ${this.i}`);
    this.i += m[0].length;
    return m[0];
  }
  string(): string {
    this.skip();
    if (this.s[this.i] !== '"') throw new Error('expected a string');
    this.i++;
    let out = '';
    while (this.i < this.s.length) {
      const c = this.s[this.i++]!;
      if (c === '"') return out;
      if (c === '\\') {
        const n = this.s[this.i++] ?? '';
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
      } else out += c;
    }
    throw new Error('unterminated string');
  }
  number(): number {
    this.skip();
    const m = /^-?\d+/.exec(this.s.slice(this.i));
    if (!m) throw new Error('expected a number');
    this.i += m[0].length;
    return Number(m[0]);
  }
}

function parseOp(source: string): GqlOp {
  const p = new Parser(source);
  p.skip();
  let kind: 'query' | 'mutation' = 'query';
  if (p.peek() === '{') return { kind, sels: parseSels(p) };
  if (p.word('mutation')) kind = 'mutation';
  else if (!p.word('query')) throw new Error('expected an operation');
  if (/[_A-Za-z]/.test(p.peek())) p.name();
  if (p.eat('(')) {
    while (!p.eat(')')) {
      p.eat('$');
      p.name();
      if (!p.eat(':')) throw new Error('expected :');
      parseType(p);
      if (p.eat('=')) parseValue(p);
    }
  }
  return { kind, sels: parseSels(p) };
}

function parseType(p: Parser): void {
  if (p.eat('[')) {
    parseType(p);
    if (!p.eat(']')) throw new Error('expected ]');
  } else p.name();
  p.eat('!');
}

function parseSels(p: Parser): Sel[] {
  if (!p.eat('{')) throw new Error('expected {');
  const sels: Sel[] = [];
  while (!p.eat('}')) {
    if (p.eat('...')) {
      if (!p.word('on')) throw new Error('expected on');
      const type = p.name();
      sels.push({ kind: 'frag', type, sels: parseSels(p) });
      continue;
    }
    let alias = p.name();
    let name = alias;
    if (p.eat(':')) name = p.name();
    const args: Array<[string, Val]> = [];
    if (p.eat('(')) {
      while (!p.eat(')')) {
        const key = p.name();
        if (!p.eat(':')) throw new Error('expected :');
        args.push([key, parseValue(p)]);
      }
    }
    const nested = p.peek() === '{' ? parseSels(p) : [];
    sels.push({ kind: 'field', alias, name, args, sels: nested });
  }
  return sels;
}

function parseValue(p: Parser): Val {
  p.skip();
  const c = p.peek();
  if (c === '$') {
    p.eat('$');
    return { k: 'var', n: p.name() };
  }
  if (c === '"') return { k: 'lit', x: p.string() };
  if (c === '-' || (c >= '0' && c <= '9')) return { k: 'lit', x: p.number() };
  if (p.eat('[')) {
    const xs: Val[] = [];
    while (!p.eat(']')) xs.push(parseValue(p));
    return { k: 'list', xs };
  }
  if (p.eat('{')) {
    const fs: Array<[string, Val]> = [];
    while (!p.eat('}')) {
      const key = p.name();
      if (!p.eat(':')) throw new Error('expected :');
      fs.push([key, parseValue(p)]);
    }
    return { k: 'obj', fs };
  }
  const id = p.name();
  if (id === 'true') return { k: 'lit', x: true };
  if (id === 'false') return { k: 'lit', x: false };
  if (id === 'null') return { k: 'lit', x: null };
  return { k: 'enum', n: id };
}

// ---------------------------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------------------------

const TOOLS = [
  { name: 'create_repo', description: 'Create a repository for the authenticated user.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Read one repository by owner and name.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Open an issue on a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues on a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Open a pull request.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Squash-merge a pull request.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } }, required: ['owner', 'repo', 'pull_number'] } },
];

const SERVER_INFO = { name: 'forge', version: '1.0.0' };

async function mcp(req: IncomingMessage, res: ServerResponse, method: string): Promise<void> {
  if (method !== 'POST') return sendJson(res, 404, { message: 'Not Found' });
  const buf = await readBody(req);
  let msg: unknown;
  try {
    msg = JSON.parse(buf.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (typeof msg !== 'object' || msg === null) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
    return;
  }
  const rec = msg as { id?: unknown; method?: unknown; params?: unknown };
  const id = rec.id === undefined ? null : rec.id;
  if (!authed(req)) {
    sendJson(res, 401, { jsonrpc: '2.0', id, error: { code: -32001, message: 'Requires authentication' } });
    return;
  }
  const rpcMethod = typeof rec.method === 'string' ? rec.method : '';
  const params = rec.params && typeof rec.params === 'object' ? (rec.params as Record<string, unknown>) : {};
  if (rpcMethod === 'server/discover' || rpcMethod === 'initialize') {
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2026-07-28',
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      },
    });
    return;
  }
  if (rpcMethod === 'notifications/initialized' || rec.id === undefined) {
    sendEmpty(res, 202);
    return;
  }
  if (rpcMethod === 'tools/list') {
    sendJson(res, 200, { jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (rpcMethod === 'tools/call') {
    const result = callTool(params);
    if ('error' in result) sendJson(res, 200, { jsonrpc: '2.0', id, error: result.error });
    else sendJson(res, 200, { jsonrpc: '2.0', id, result: result.result });
    return;
  }
  sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${rpcMethod}` } });
}

function toolText(value: unknown, isError = false): { result: { content: Array<{ type: string; text: string }>; isError?: boolean } } {
  return { result: { content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) } };
}

function callTool(params: Record<string, unknown>): { result: unknown } | { error: { code: number; message: string } } {
  const name = typeof params.name === 'string' ? params.name : '';
  const args = params.arguments && typeof params.arguments === 'object' ? (params.arguments as Record<string, unknown>) : {};
  const tool = TOOLS.find((item) => item.name === name);
  if (!tool) return { error: { code: -32602, message: `Unknown tool: ${name}` } };
  const required = tool.inputSchema.required;
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') return toolText({ message: `missing required argument ${key}` }, true);
  }
  if (name === 'create_repo') {
    const repoName = String(args.name);
    if (repos.has(keyOf(VIEWER, repoName))) return toolText({ message: 'Repository already exists' }, true);
    const repo: Repo = {
      id: nextRepoId++,
      name: repoName,
      owner: VIEWER,
      description: typeof args.description === 'string' ? args.description : '',
      private: args.private === true,
      defaultBranch: 'main',
      git: createGitRepo(),
      labels: new Set(),
      issues: [],
      issueByNumber: new Map(),
      pulls: [],
      pullByNumber: new Map(),
      nextIssue: 1,
      nextPull: 1,
    };
    repos.set(keyOf(VIEWER, repoName), repo);
    order.push(repo);
    repoById.set(repo.id, repo);
    return toolText({ id: repo.id, name: repo.name, full_name: `${VIEWER}/${repo.name}`, private: repo.private, description: repo.description });
  }
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER;
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  const repo = repos.get(keyOf(owner, repoName));
  if (name === 'get_repo') {
    if (!repo) return toolText({ message: 'Not Found' }, true);
    return toolText({ name: repo.name, full_name: `${repo.owner}/${repo.name}`, private: repo.private, description: repo.description, default_branch: repo.defaultBranch, id: repo.id });
  }
  if (!repo) return toolText({ message: 'Not Found' }, true);
  if (name === 'create_issue') {
    const issue = addIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
    return toolText({ number: issue.number, title: issue.title, state: issue.state, id: issue.id });
  }
  if (name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    const list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    return toolText(list.map((issue) => ({ number: issue.number, title: issue.title, body: issue.body, state: issue.state })));
  }
  if (name === 'create_pull_request') {
    const head = String(args.head);
    const base = String(args.base);
    const headSha = repo.git.refs.get(`refs/heads/${head}`);
    const baseSha = repo.git.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) return toolText({ message: 'head or base does not exist' }, true);
    const pull: Pull = {
      id: nextPullId++,
      number: repo.nextPull++,
      title: String(args.title),
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeSha: null,
      head,
      base,
      headSha,
      baseSha,
    };
    repo.pulls.push(pull);
    repo.pullByNumber.set(pull.number, pull);
    return toolText({ number: pull.number, title: pull.title, head: pull.head, base: pull.base, state: pull.state });
  }
  if (name === 'merge_pull_request') {
    const pull = repo.pullByNumber.get(Number(args.pull_number));
    if (!pull) return toolText({ message: 'Not Found' }, true);
    const result = squashMerge(repo.git, pull.base, pull.head, pull.title);
    if (result !== 'conflict' && result !== 'missing') {
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = MERGED_AT;
      pull.mergeSha = result.sha;
      return toolText({ number: pull.number, merged: true, sha: result.sha, state: pull.state });
    }
    return toolText({ message: result === 'conflict' ? 'Merge conflict' : 'Not Found' }, true);
  }
  return { error: { code: -32602, message: `Unknown tool: ${name}` } };
}
