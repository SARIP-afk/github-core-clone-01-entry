// The forge's HTTP surface: git smart HTTP (v0 + v2), REST v3, GraphQL v4
// and MCP, over one Node http server. The entry (main.ts) owns the lifecycle;
// this file owns the wire. Every reply carries X-GitHub-Request-Id; every
// API call (except GET /healthz) requires the bearer token.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge, isErr, type Repo } from './store.ts';
import { executeGraphQL } from './graphql.ts';
import { dispatchMcp, mcpParseError } from './mcp.ts';
import {
  collectReachable,
  collectReachablePruned,
  hashObject,
  parseCommit,
  parsePack,
  parseTag,
  parseTree,
  pktDecodeAll,
  pktLine,
  pktLinesUntilEnd,
  pktSplitAtFlush,
  writePack,
  ZERO_OID,
  type GitObject,
} from './gitutil.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const OAUTH_SCOPES = 'repo, read:org';
const AGENT = 'forge/1.0.0';

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    'x-oauth-scopes': OAUTH_SCOPES,
    ...extra,
  });
  res.end(text);
}

function sendEmpty(res: ServerResponse, status: number, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'x-github-request-id': nextRequestId(), ...extra });
  res.end();
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function pathOf(req: IncomingMessage): string {
  try {
    return decodeURIComponent(new URL(req.url ?? '/', 'http://entry').pathname);
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function parseJsonBody(body: Buffer): unknown | undefined {
  if (body.length === 0) return undefined;
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

function isAuthed(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const auth = req.headers.authorization ?? '';
  if (expected !== '') return auth === `Bearer ${expected}`;
  return auth.startsWith('Bearer ') && auth.length > 7;
}

function intParam(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function linkHeader(req: IncomingMessage, path: string, query: URLSearchParams, page: number, perPage: number, total: number): string | null {
  const pages = Math.max(1, Math.ceil(total / perPage));
  if (pages <= 1) return null;
  const host = req.headers.host ?? 'entry';
  const base = new URLSearchParams(query);
  const urlFor = (pageNumber: number): string => {
    base.set('per_page', String(perPage));
    base.set('page', String(pageNumber));
    return `<http://${host}${path}?${base.toString()}>`;
  };
  const parts: string[] = [];
  if (page < pages) parts.push(`${urlFor(page + 1)}; rel="next"`);
  if (page > 1) parts.push(`${urlFor(page - 1)}; rel="prev"`);
  parts.push(`${urlFor(1)}; rel="first"`);
  parts.push(`${urlFor(pages)}; rel="last"`);
  return parts.join(', ');
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function badAuth(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Bad credentials' });
}

/** Resolve a repo from the URL, requiring it to belong to the viewer. */
function resolveRepo(forge: Forge, owner: string, name: string): Repo | undefined {
  if (owner !== forge.viewer.login) return undefined;
  return forge.getRepo(owner, name);
}

const OWNER_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

async function handleRest(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  query: URLSearchParams,
  body: Buffer,
): Promise<boolean> {
  const seg = path.split('/').filter((part) => part !== '');

  // GET /api/v3/ — the API root.
  if (seg.length === 2 && seg[0] === 'api' && seg[1] === 'v3') {
    if (method !== 'GET') {
      notFound(res);
      return true;
    }
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' });
    return true;
  }

  // GET /api/v3/meta
  if (seg.length === 3 && seg[0] === 'api' && seg[1] === 'v3' && seg[2] === 'meta') {
    if (method !== 'GET') {
      notFound(res);
      return true;
    }
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }

  // GET /api/v3/user
  if (seg.length === 3 && seg[0] === 'api' && seg[1] === 'v3' && seg[2] === 'user') {
    if (method !== 'GET') {
      notFound(res);
      return true;
    }
    sendJson(res, 200, {
      login: forge.viewer.login,
      id: 1000,
      name: forge.viewer.name,
      email: forge.viewer.email,
      type: 'User',
    });
    return true;
  }

  // /api/v3/user/repos
  if (seg.length === 4 && seg[0] === 'api' && seg[1] === 'v3' && seg[2] === 'user' && seg[3] === 'repos') {
    if (method === 'GET') {
      const perPage = Math.min(100, intParam(query, 'per_page', 30));
      const page = intParam(query, 'page', 1);
      const all = forge.listViewerRepos();
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage);
      const link = linkHeader(req, path, query, page, perPage, all.length);
      sendJson(res, 200, slice.map((repo) => forge.repoJson(repo)), link === null ? {} : { link });
      return true;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        sendJson(res, 400, { message: 'Invalid JSON' });
        return true;
      }
      const input = parsed as Record<string, unknown>;
      const name = typeof input.name === 'string' ? input.name : '';
      const description = typeof input.description === 'string' ? input.description : '';
      const isPrivate = input.private === true;
      const created = forge.createRepo(name, description, isPrivate);
      if (isErr(created)) {
        sendJson(res, 422, { message: created.detail ?? created.error });
        return true;
      }
      sendJson(res, 201, forge.repoJson(created));
      return true;
    }
    notFound(res);
    return true;
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (seg.length >= 5 && seg[0] === 'api' && seg[1] === 'v3' && seg[2] === 'repos') {
    const owner = seg[3] as string;
    const repoName = seg[4] as string;
    const repo = resolveRepo(forge, owner, repoName);
    const rest = seg.slice(5);

    // GET/PATCH/DELETE /api/v3/repos/{o}/{r}
    if (rest.length === 0) {
      if (repo === undefined) {
        notFound(res);
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, forge.repoJson(repo));
        return true;
      }
      if (method === 'PATCH') {
        const parsed = parseJsonBody(body);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const input = parsed as Record<string, unknown>;
          if (typeof input.description === 'string') repo.description = input.description;
        }
        sendJson(res, 200, forge.repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        forge.deleteRepo(owner, repoName);
        sendEmpty(res, 204);
        return true;
      }
      notFound(res);
      return true;
    }

    if (repo === undefined) {
      notFound(res);
      return true;
    }

    // POST /git/refs
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs' && method === 'POST') {
      const parsed = parseJsonBody(body);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        sendJson(res, 400, { message: 'Invalid JSON' });
        return true;
      }
      const input = parsed as Record<string, unknown>;
      const ref = typeof input.ref === 'string' ? input.ref : '';
      const sha = typeof input.sha === 'string' ? input.sha : '';
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha) || forge.getObject(repo, sha) === undefined) {
        sendJson(res, 422, { message: 'Invalid ref or sha' });
        return true;
      }
      forge.setRef(repo, ref, sha);
      sendJson(res, 201, { ref, object: { sha } });
      return true;
    }

    // GET /git/refs (all) and /git/refs/heads/{branch} / /git/refs/tags/{tag}
    if (rest[0] === 'git' && rest[1] === 'refs' && method === 'GET') {
      if (rest.length === 2) {
        sendJson(res, 200, forge.listRefs(repo).map(({ refname, oid }) => ({ ref: refname, object: { sha: oid } })));
        return true;
      }
      const refname = rest.slice(2).join('/');
      const tip = forge.refTip(repo, refname);
      if (tip === undefined) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, { ref: refname, object: { sha: tip } });
      return true;
    }

    // GET /branches and /branches/{branch}
    if (rest[0] === 'branches' && method === 'GET') {
      if (rest.length === 1) {
        const branches = forge
          .listRefs(repo)
          .filter(({ refname }) => refname.startsWith('refs/heads/'))
          .map(({ refname, oid }) => ({ name: refname.slice('refs/heads/'.length), commit: { sha: oid } }));
        sendJson(res, 200, branches);
        return true;
      }
      const branch = rest.slice(1).join('/');
      const tip = forge.refTip(repo, `refs/heads/${branch}`);
      if (tip === undefined) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, { name: branch, commit: { sha: tip } });
      return true;
    }

    // GET /commits[?sha=]
    if (rest.length === 1 && rest[0] === 'commits' && method === 'GET') {
      const ref = query.get('sha');
      const tip = ref !== null ? forge.resolveRef(repo, ref) : forge.refTip(repo, `refs/heads/${repo.defaultBranch}`);
      if (tip === undefined) {
        sendJson(res, 200, []);
        return true;
      }
      sendJson(res, 200, forge.commitHistory(repo, tip));
      return true;
    }

    // /contents/{path...}
    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).join('/');
      if (method === 'GET') {
        const ref = query.get('ref') ?? undefined;
        const found = forge.getContent(repo, filePath, ref);
        if (found === null) {
          notFound(res);
          return true;
        }
        if (found.kind === 'dir') {
          sendJson(res, 200, found.entries);
          return true;
        }
        sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          content: found.content.toString('base64'),
          sha: found.blobOid,
          size: found.content.length,
          name: filePath.split('/').pop() ?? filePath,
          path: filePath,
        });
        return true;
      }
      if (method === 'PUT') {
        const parsed = parseJsonBody(body);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          sendJson(res, 400, { message: 'Invalid JSON' });
          return true;
        }
        const input = parsed as Record<string, unknown>;
        const message = typeof input.message === 'string' ? input.message : 'update';
        const contentB64 = typeof input.content === 'string' ? input.content : '';
        const branch = typeof input.branch === 'string' ? input.branch : undefined;
        const sha = typeof input.sha === 'string' ? input.sha : undefined;
        let content: Buffer;
        try {
          content = Buffer.from(contentB64.replace(/\s/g, ''), 'base64');
        } catch {
          sendJson(res, 400, { message: 'Invalid base64 content' });
          return true;
        }
        const result = forge.putContent(repo, filePath, content, message, branch, sha);
        if (isErr(result)) {
          sendJson(res, result.error === 'conflict' ? 409 : 422, { message: result.detail ?? result.error });
          return true;
        }
        sendJson(res, result.status, {
          content: {
            name: filePath.split('/').pop() ?? filePath,
            path: filePath,
            sha: result.blobOid,
            size: content.length,
            type: 'file',
            encoding: 'base64',
          },
          commit: { sha: result.commitOid },
        });
        return true;
      }
      if (method === 'DELETE') {
        const parsed = parseJsonBody(body);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          sendJson(res, 400, { message: 'Invalid JSON' });
          return true;
        }
        const input = parsed as Record<string, unknown>;
        const message = typeof input.message === 'string' ? input.message : 'delete';
        const sha = typeof input.sha === 'string' ? input.sha : '';
        const branch = typeof input.branch === 'string' ? input.branch : undefined;
        const result = forge.deleteContent(repo, filePath, message, sha, branch);
        if (isErr(result)) {
          sendJson(res, result.error === 'conflict' ? 409 : 404, { message: result.detail ?? result.error });
          return true;
        }
        sendJson(res, 200, { commit: { sha: result.commitOid } });
        return true;
      }
      notFound(res);
      return true;
    }

    // POST /labels
    if (rest.length === 1 && rest[0] === 'labels' && method === 'POST') {
      const parsed = parseJsonBody(body);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        sendJson(res, 400, { message: 'Invalid JSON' });
        return true;
      }
      const input = parsed as Record<string, unknown>;
      const name = typeof input.name === 'string' ? input.name : '';
      const color = typeof input.color === 'string' ? input.color : 'ededed';
      if (name === '') {
        sendJson(res, 422, { message: 'name is required' });
        return true;
      }
      const label = forge.createLabel(repo, name, color);
      sendJson(res, 201, { name: label.name, color: label.color });
      return true;
    }

    // /issues...
    if (rest[0] === 'issues') {
      // GET/POST /issues
      if (rest.length === 1) {
        if (method === 'GET') {
          const stateParam = query.get('state') ?? 'open';
          const state = stateParam === 'closed' ? 'closed' : stateParam === 'all' ? 'all' : 'open';
          const direction = query.get('direction') === 'asc' ? 'asc' : 'desc';
          const perPage = Math.min(100, intParam(query, 'per_page', 30));
          const page = intParam(query, 'page', 1);
          const list = forge.listIssues(repo, state, 'created', direction, perPage, page);
          const total = forge.listIssues(repo, state, 'created', direction, 100000, 1).length;
          const link = linkHeader(req, path, query, page, perPage, total);
          sendJson(res, 200, list.map((issue) => forge.issueJson(repo, issue)), link === null ? {} : { link });
          return true;
        }
        if (method === 'POST') {
          const parsed = parseJsonBody(body);
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            sendJson(res, 400, { message: 'Invalid JSON' });
            return true;
          }
          const input = parsed as Record<string, unknown>;
          const title = typeof input.title === 'string' ? input.title : '';
          const content = typeof input.body === 'string' ? input.body : '';
          const labels = Array.isArray(input.labels) ? input.labels.filter((label): label is string => typeof label === 'string') : [];
          if (title === '') {
            sendJson(res, 422, { message: 'title is required' });
            return true;
          }
          const created = forge.createIssue(repo, title, content, labels);
          if (isErr(created)) {
            sendJson(res, 422, { message: created.detail ?? created.error });
            return true;
          }
          sendJson(res, 201, forge.issueJson(repo, created));
          return true;
        }
        notFound(res);
        return true;
      }
      // /issues/{n} and /issues/{n}/comments
      const number = Number.parseInt(rest[1] as string, 10);
      if (!Number.isFinite(number)) {
        notFound(res);
        return true;
      }
      if (rest.length === 2) {
        const issue = forge.getIssue(repo, number);
        if (issue === undefined) {
          notFound(res);
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, forge.issueJson(repo, issue));
          return true;
        }
        if (method === 'PATCH') {
          const parsed = parseJsonBody(body);
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            sendJson(res, 400, { message: 'Invalid JSON' });
            return true;
          }
          const input = parsed as Record<string, unknown>;
          const patch: { state?: string; title?: string; body?: string } = {};
          if (typeof input.state === 'string') patch.state = input.state;
          if (typeof input.title === 'string') patch.title = input.title;
          if (typeof input.body === 'string') patch.body = input.body;
          const updated = forge.updateIssue(repo, number, patch);
          if (updated === undefined) {
            notFound(res);
            return true;
          }
          sendJson(res, 200, forge.issueJson(repo, updated));
          return true;
        }
        notFound(res);
        return true;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        const issue = forge.getIssue(repo, number);
        if (issue === undefined) {
          notFound(res);
          return true;
        }
        if (method === 'GET') {
          sendJson(
            res,
            200,
            forge.listComments(repo, number).map((comment) => ({
              id: comment.id,
              body: comment.body,
              user: { login: forge.viewer.login, id: 1000 },
              created_at: '2025-01-01T00:00:00Z',
            })),
          );
          return true;
        }
        if (method === 'POST') {
          const parsed = parseJsonBody(body);
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            sendJson(res, 400, { message: 'Invalid JSON' });
            return true;
          }
          const input = parsed as Record<string, unknown>;
          const content = typeof input.body === 'string' ? input.body : '';
          const added = forge.addComment(repo, number, content);
          if (isErr(added)) {
            notFound(res);
            return true;
          }
          sendJson(res, 201, {
            id: added.id,
            body: added.body,
            user: { login: forge.viewer.login, id: 1000 },
            created_at: '2025-01-01T00:00:00Z',
          });
          return true;
        }
        notFound(res);
        return true;
      }
      notFound(res);
      return true;
    }

    // /pulls...
    if (rest[0] === 'pulls') {
      // GET/POST /pulls
      if (rest.length === 1) {
        if (method === 'GET') {
          const stateParam = query.get('state') ?? 'open';
          const state = stateParam === 'closed' ? 'closed' : stateParam === 'all' ? 'all' : 'open';
          sendJson(res, 200, forge.listPulls(repo, state).map((pull) => forge.pullJson(repo, pull)));
          return true;
        }
        if (method === 'POST') {
          const parsed = parseJsonBody(body);
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            sendJson(res, 400, { message: 'Invalid JSON' });
            return true;
          }
          const input = parsed as Record<string, unknown>;
          const title = typeof input.title === 'string' ? input.title : '';
          const head = typeof input.head === 'string' ? input.head : '';
          const base = typeof input.base === 'string' ? input.base : '';
          const content = typeof input.body === 'string' ? input.body : '';
          const created = forge.createPull(repo, title, head, base, content);
          if (isErr(created)) {
            sendJson(res, 422, { message: created.detail ?? created.error });
            return true;
          }
          sendJson(res, 201, forge.pullJson(repo, created));
          return true;
        }
        notFound(res);
        return true;
      }
      const number = Number.parseInt(rest[1] as string, 10);
      if (!Number.isFinite(number)) {
        notFound(res);
        return true;
      }
      const pull = forge.getPull(repo, number);
      if (rest.length === 2) {
        if (pull === undefined) {
          notFound(res);
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, forge.pullJson(repo, pull));
          return true;
        }
        notFound(res);
        return true;
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        if (pull === undefined) {
          notFound(res);
          return true;
        }
        sendJson(res, 200, forge.pullFiles(repo, pull));
        return true;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (pull === undefined) {
          notFound(res);
          return true;
        }
        const merged = forge.mergePull(repo, pull);
        if (isErr(merged)) {
          if (merged.error === 'conflict' || merged.error === 'merged') {
            sendJson(res, 405, { message: merged.detail ?? merged.error });
            return true;
          }
          sendJson(res, 422, { message: merged.detail ?? merged.error });
          return true;
        }
        sendJson(res, 200, {
          sha: merged.commitOid,
          merged: true,
          message: `Pull Request successfully merged`,
        });
        return true;
      }
      notFound(res);
      return true;
    }

    notFound(res);
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const mainTip = repo.refs.get('refs/heads/main');
  const caps =
    service === 'git-upload-pack'
      ? 'side-band-64k multi_ack thin-pack ofs-delta shallow symref=HEAD:refs/heads/main agent=forge/1.0.0'
      : 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0.0';
  const parts: Buffer[] = [pktLine(Buffer.from(`# service=${service}\n`, 'ascii')), pktLine(null)];
  const refs = forgeListRefs(repo);
  if (mainTip === undefined && refs.length === 0) {
    parts.push(pktLine(Buffer.from(`${ZERO_OID} capabilities^{}\0${caps}\n`, 'ascii')));
  } else {
    const headOid = mainTip ?? ZERO_OID;
    parts.push(pktLine(Buffer.from(`${headOid} HEAD\0${caps}\n`, 'ascii')));
    for (const { refname, oid } of refs) {
      parts.push(pktLine(Buffer.from(`${oid} ${refname}\n`, 'ascii')));
      const peeled = peeledCommit(repo, oid);
      if (peeled !== undefined && refname.startsWith('refs/tags/')) {
        parts.push(pktLine(Buffer.from(`${peeled} ${refname}^{}\n`, 'ascii')));
      }
    }
  }
  parts.push(pktLine(null));
  return Buffer.concat(parts);
}

function forgeListRefs(repo: Repo): { refname: string; oid: string }[] {
  return [...repo.refs.entries()]
    .map(([refname, oid]) => ({ refname, oid }))
    .sort((a, b) => (a.refname < b.refname ? -1 : a.refname > b.refname ? 1 : 0));
}

/** The commit an annotated tag points at (undefined when the ref is not a tag). */
function peeledCommit(repo: Repo, oid: string): string | undefined {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tag') return undefined;
  return parseTag(object.data).object;
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine(Buffer.from('# service=git-upload-pack\n', 'ascii')),
    pktLine(null),
    pktLine(Buffer.from('version 2\n', 'ascii')),
    pktLine(Buffer.from(`agent=${AGENT}\n`, 'ascii')),
    pktLine(Buffer.from('ls-refs=unborn\n', 'ascii')),
    pktLine(Buffer.from('fetch=shallow\n', 'ascii')),
    pktLine(Buffer.from('object-format=sha1\n', 'ascii')),
    pktLine(null),
  ]);
}

function collectTreeObjects(repo: Repo, treeOid: string, out: Map<string, GitObject>): void {
  const tree = repo.objects.get(treeOid);
  if (tree === undefined || tree.type !== 'tree' || out.has(treeOid)) return;
  out.set(treeOid, tree);
  for (const entry of parseTree(tree.data)) {
    if (entry.mode === '40000' || entry.mode === '040000') {
      collectTreeObjects(repo, entry.oid, out);
    } else if (entry.mode !== '160000') {
      const blob = repo.objects.get(entry.oid);
      if (blob !== undefined && !out.has(entry.oid)) out.set(entry.oid, blob);
    }
  }
}

interface FetchPlan {
  readonly objects: GitObject[];
  readonly shallow: string[];
  readonly unshallow: string[];
}

/**
 * The object set for a fetch: the wanted closure (depth-limited when a depth
 * is given) minus what the client already has, plus the shallow boundaries.
 */
function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  previousShallow: string[],
  depth: number | undefined,
): FetchPlan {
  const wanted = new Map<string, GitObject>();
  if (depth === undefined) {
    for (const object of collectReachable(wants, (oid) => repo.objects.get(oid))) {
      wanted.set(hashObject(object.type, object.data), object);
    }
  } else {
    const queue: { oid: string; depth: number }[] = wants.map((oid) => ({ oid, depth: 1 }));
    const seenCommits = new Set<string>();
    while (queue.length > 0) {
      const { oid, depth: d } = queue.pop() as { oid: string; depth: number };
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      if (object.type === 'tag') {
        if (!wanted.has(oid)) wanted.set(oid, object);
        queue.push({ oid: parseTag(object.data).object, depth: d });
        continue;
      }
      if (object.type !== 'commit') {
        if (!wanted.has(oid)) wanted.set(oid, object);
        continue;
      }
      if (seenCommits.has(oid)) continue;
      seenCommits.add(oid);
      if (!wanted.has(oid)) wanted.set(oid, object);
      const parsed = parseCommit(object.data);
      collectTreeObjects(repo, parsed.tree, wanted);
      if (d < depth) {
        for (const parent of parsed.parents) queue.push({ oid: parent, depth: d + 1 });
      }
    }
  }

  // What the client actually holds: the haves' closure, but never past a
  // shallow boundary — a shallow commit's parents were never delivered.
  const held = new Set<string>();
  for (const object of collectReachablePruned(haves, new Set(previousShallow), (oid) => repo.objects.get(oid))) {
    held.add(hashObject(object.type, object.data));
  }

  const included = new Map<string, GitObject>();
  for (const [oid, object] of wanted) {
    if (!held.has(oid)) included.set(oid, object);
  }

  // Shallow boundaries: included commits whose parents are neither in the
  // pack nor already held; plus previous boundaries that are still shallow,
  // minus previous boundaries whose parents are now delivered.
  const includedOids = new Set(included.keys());
  const shallow = new Set<string>();
  for (const [oid, object] of included) {
    if (object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!includedOids.has(parent) && !held.has(parent)) {
        shallow.add(oid);
        break;
      }
    }
  }
  const unshallow: string[] = [];
  for (const boundary of previousShallow) {
    const object = repo.objects.get(boundary);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    const stillShallow = parents.some((parent) => !includedOids.has(parent) && !held.has(parent));
    if (stillShallow) shallow.add(boundary);
    else unshallow.push(boundary);
  }

  const objects = [...included.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, object]) => object);
  return { objects, shallow: [...shallow].sort(), unshallow: unshallow.sort() };
}

/** A pack as sideband band-1 pkt-lines (each ≤ 65,515 data bytes). */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65_515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) {
    // A pack is never empty: even zero objects serialize to a 32-byte header.
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), writePack([])])));
  }
  return parts;
}

function handleLsRefs(repo: Repo, argLines: Buffer[], wantPeel: boolean, wantSymrefs: boolean, wantUnborn: boolean): Buffer {
  const prefixes: string[] = [];
  for (const line of argLines) {
    const text = line.toString('utf8');
    if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length).trim());
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const mainTip = repo.refs.get('refs/heads/main');
  const refs = forgeListRefs(repo);
  if (prefixes.length === 0) {
    if (mainTip !== undefined) {
      let line = `${mainTip} HEAD`;
      if (wantSymrefs) line += ' symref-target:refs/heads/main';
      parts.push(pktLine(Buffer.from(`${line}\n`, 'ascii')));
    } else if (wantUnborn) {
      let line = 'unborn HEAD';
      if (wantSymrefs) line += ' symref-target:refs/heads/main';
      parts.push(pktLine(Buffer.from(`${line}\n`, 'ascii')));
    }
  }
  for (const { refname, oid } of refs) {
    if (!matches(refname)) continue;
    let line = `${oid} ${refname}`;
    const peeled = peeledCommit(repo, oid);
    if (wantPeel && peeled !== undefined) line += ` peeled:${peeled}`;
    parts.push(pktLine(Buffer.from(`${line}\n`, 'ascii')));
  }
  parts.push(pktLine(null));
  return Buffer.concat(parts);
}

function handleFetchV2(repo: Repo, argLines: Buffer[], previousShallow: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  let depth: number | undefined;
  for (const line of argLines) {
    const text = line.toString('utf8').trim();
    if (text.startsWith('want ')) wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) previousShallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) depth = Number.parseInt(text.slice(7).trim(), 10);
  }
  const plan = planFetch(repo, wants, haves, previousShallow, depth);
  const parts: Buffer[] = [];
  parts.push(pktLine(Buffer.from('acknowledgments\n', 'ascii')));
  if (haves.length === 0) {
    parts.push(pktLine(Buffer.from('NAK\n', 'ascii')));
  } else {
    let acked = false;
    for (const have of haves) {
      if (repo.objects.has(have)) {
        parts.push(pktLine(Buffer.from(`ACK ${have}\n`, 'ascii')));
        acked = true;
      }
    }
    if (!acked) parts.push(pktLine(Buffer.from('NAK\n', 'ascii')));
    else parts.push(pktLine(Buffer.from('ready\n', 'ascii')));
  }
  parts.push(pktLine(null));
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine(Buffer.from('shallow-info\n', 'ascii')));
    for (const oid of plan.shallow) parts.push(pktLine(Buffer.from(`shallow ${oid}\n`, 'ascii')));
    for (const oid of plan.unshallow) parts.push(pktLine(Buffer.from(`unshallow ${oid}\n`, 'ascii')));
    parts.push(pktLine(null));
  }
  const refTips = new Map<string, string>();
  for (const { refname, oid } of forgeListRefs(repo)) refTips.set(oid, refname);
  const wantedRefs = wants.filter((want) => refTips.has(want));
  if (wantedRefs.length > 0) {
    parts.push(pktLine(Buffer.from('wanted-refs\n', 'ascii')));
    for (const want of wantedRefs) {
      parts.push(pktLine(Buffer.from(`${want} ${refTips.get(want) as string}\n`, 'ascii')));
    }
    parts.push(pktLine(null));
  }
  parts.push(pktLine(Buffer.from('packfile\n', 'ascii')));
  for (const part of sidebandPack(writePack(plan.objects))) parts.push(part);
  parts.push(pktLine(null));
  return Buffer.concat(parts);
}

function handleUploadPack(repo: Repo, body: Buffer, isV2: boolean): { status: number; body: Buffer } {
  try {
    if (isV2) {
      const packets = pktDecodeAll(body);
      const delimIndex = packets.findIndex((packet) => packet === 'delim');
      const headerLines = pktLinesUntilEnd(delimIndex === -1 ? packets : packets.slice(0, delimIndex));
      const argLines = delimIndex === -1 ? [] : pktLinesUntilEnd(packets.slice(delimIndex + 1));
      const commandLine = headerLines.find((line) => line.toString('utf8').startsWith('command='));
      const command = commandLine === undefined ? '' : commandLine.toString('utf8').slice('command='.length).trim();
      if (command === 'ls-refs') {
        const wantPeel = argLines.some((line) => line.toString('utf8').trim() === 'peel');
        const wantSymrefs = argLines.some((line) => line.toString('utf8').trim() === 'symrefs');
        const wantUnborn = argLines.some((line) => line.toString('utf8').trim() === 'unborn');
        return { status: 200, body: handleLsRefs(repo, argLines, wantPeel, wantSymrefs, wantUnborn) };
      }
      if (command === 'fetch') {
        return { status: 200, body: handleFetchV2(repo, argLines, []) };
      }
      return { status: 400, body: Buffer.from(JSON.stringify({ message: 'unknown command' }), 'utf8') };
    }
    // v0: want lines, flush, have/shallow/deepen lines, done, flush.
    const packets = pktDecodeAll(body);
    const flushIndex = packets.findIndex((packet) => packet === 'flush');
    const wantLines = flushIndex === -1 ? pktLinesUntilEnd(packets) : pktLinesUntilEnd(packets.slice(0, flushIndex));
    const afterLines = flushIndex === -1 ? [] : pktLinesUntilEnd(packets.slice(flushIndex + 1));
    const wants: string[] = [];
    for (const line of wantLines) {
      const text = line.toString('utf8').trim();
      if (text.startsWith('want ')) wants.push(text.slice(5).split(' ')[0] as string);
    }
    const haves: string[] = [];
    const previousShallow: string[] = [];
    let depth: number | undefined;
    for (const line of afterLines) {
      const text = line.toString('utf8').trim();
      if (text.startsWith('have ')) haves.push(text.slice(5).trim());
      else if (text.startsWith('shallow ')) previousShallow.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) depth = Number.parseInt(text.slice(7).trim(), 10);
    }
    const plan = planFetch(repo, wants, haves, previousShallow, depth);
    const parts: Buffer[] = [];
    if (haves.length === 0) {
      parts.push(pktLine(Buffer.from('NAK\n', 'ascii')));
    } else {
      let acked = false;
      for (const have of haves) {
        if (repo.objects.has(have)) {
          parts.push(pktLine(Buffer.from(`ACK ${have}\n`, 'ascii')));
          acked = true;
        }
      }
      if (!acked) parts.push(pktLine(Buffer.from('NAK\n', 'ascii')));
    }
    for (const oid of plan.shallow) parts.push(pktLine(Buffer.from(`shallow ${oid}\n`, 'ascii')));
    for (const oid of plan.unshallow) parts.push(pktLine(Buffer.from(`unshallow ${oid}\n`, 'ascii')));
    for (const part of sidebandPack(writePack(plan.objects))) parts.push(part);
    parts.push(pktLine(null));
    return { status: 200, body: Buffer.concat(parts) };
  } catch {
    return { status: 400, body: Buffer.from(JSON.stringify({ message: 'malformed git request' }), 'utf8') };
  }
}

function handleReceivePack(repo: Repo, body: Buffer): { status: number; body: Buffer } {
  const report: Buffer[] = [];
  const addReport = (line: string): void => {
    report.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.from(line, 'ascii')])));
  };
  try {
    const { packets, rest } = pktSplitAtFlush(body);
    const lines = pktLinesUntilEnd(packets);
    if (lines.length === 0) {
      addReport('unpack ok\n');
      return { status: 200, body: Buffer.concat([...report, pktLine(null)]) };
    }
    // Parse + store the pack first (delete-only pushes carry no pack).
    if (rest.length > 0) {
      const objects = parsePack(rest);
      for (const object of objects) {
        repo.objects.set(object.oid, { type: object.type, data: object.data });
      }
    }
    const commands: { oldOid: string; newOid: string; refname: string }[] = [];
    for (const line of lines) {
      const text = line.toString('utf8');
      const nul = text.indexOf('\0');
      const clean = (nul === -1 ? text : text.slice(0, nul)).trim();
      const parts = clean.split(' ');
      if (parts.length < 3) continue;
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, refname: parts.slice(2).join(' ') });
    }
    addReport('unpack ok\n');
    for (const command of commands) {
      const { oldOid, newOid, refname } = command;
      if (!refname.startsWith('refs/')) {
        addReport(`ng ${refname} invalid ref\n`);
        continue;
      }
      const current = repo.refs.get(refname);
      if (newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          addReport(`ng ${refname} ref does not exist\n`);
        } else if (oldOid !== ZERO_OID && oldOid !== current) {
          addReport(`ng ${refname} non-fast-forward\n`);
        } else {
          repo.refs.delete(refname);
          addReport(`ok ${refname}\n`);
        }
        continue;
      }
      if (repo.objects.get(newOid) === undefined) {
        addReport(`ng ${refname} object not found\n`);
        continue;
      }
      if (oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          addReport(`ng ${refname} non-fast-forward\n`);
        } else {
          repo.refs.set(refname, newOid);
          addReport(`ok ${refname}\n`);
        }
        continue;
      }
      // Update.
      if (current === undefined) {
        addReport(`ng ${refname} ref does not exist\n`);
        continue;
      }
      if (current !== oldOid) {
        addReport(`ng ${refname} non-fast-forward\n`);
        continue;
      }
      if (refname.startsWith('refs/tags/')) {
        if (newOid === current) addReport(`ok ${refname}\n`);
        else addReport(`ng ${refname} non-fast-forward\n`);
        continue;
      }
      if (newOid === current || repoHasAncestor(repo, oldOid, newOid)) {
        repo.refs.set(refname, newOid);
        addReport(`ok ${refname}\n`);
      } else {
        addReport(`ng ${refname} non-fast-forward\n`);
      }
    }
    return { status: 200, body: Buffer.concat([...report, pktLine(null)]) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unpack failed';
    const failed: Buffer[] = [pktLine(Buffer.concat([Buffer.from([1]), Buffer.from(`unpack ${detail}\n`, 'ascii')]))];
    return { status: 200, body: Buffer.concat([...failed, pktLine(null)]) };
  }
}

function repoHasAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue: string[] = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
      continue;
    }
    if (object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

async function handleGit(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  query: URLSearchParams,
  body: Buffer,
): Promise<boolean> {
  const seg = path.split('/').filter((part) => part !== '');
  if (seg.length < 2 || !seg[1]?.endsWith('.git')) return false;
  const owner = seg[0] as string;
  const repoName = (seg[1] as string).slice(0, -'.git'.length);
  if (!OWNER_REPO_RE.test(owner) || !OWNER_REPO_RE.test(repoName) || repoName.endsWith('.git')) {
    notFound(res);
    return true;
  }
  const repo = resolveRepo(forge, owner, repoName);
  const rest = seg.slice(2);

  // GET /{o}/{r}.git/info/refs?service=...
  if (rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs' && method === 'GET') {
    if (repo === undefined) {
      notFound(res);
      return true;
    }
    const service = query.get('service');
    if (service === 'git-upload-pack') {
      const isV2 = req.headers['git-protocol'] === 'version=2';
      const advertisement = isV2 ? v2Advertisement() : v0Advertisement(repo, 'git-upload-pack');
      sendRaw(res, 200, advertisement, 'application/x-git-upload-pack-advertisement');
      return true;
    }
    if (service === 'git-receive-pack') {
      sendRaw(res, 200, v0Advertisement(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
      return true;
    }
    notFound(res);
    return true;
  }

  // POST /{o}/{r}.git/git-upload-pack
  if (rest.length === 1 && rest[0] === 'git-upload-pack' && method === 'POST') {
    if (repo === undefined) {
      notFound(res);
      return true;
    }
    const isV2 = req.headers['git-protocol'] === 'version=2';
    const result = handleUploadPack(repo, body, isV2);
    if (result.status === 200) {
      sendRaw(res, 200, result.body, 'application/x-git-upload-pack-result');
    } else {
      sendJson(res, result.status, JSON.parse(result.body.toString('utf8')) as unknown);
    }
    return true;
  }

  // POST /{o}/{r}.git/git-receive-pack
  if (rest.length === 1 && rest[0] === 'git-receive-pack' && method === 'POST') {
    if (repo === undefined) {
      notFound(res);
      return true;
    }
    const result = handleReceivePack(repo, body);
    sendRaw(res, 200, result.body, 'application/x-git-receive-pack-result');
    return true;
  }

  notFound(res);
  return true;
}

// ---------------------------------------------------------------------------
// GraphQL + MCP dispatch, and the server
// ---------------------------------------------------------------------------

async function handleGraphQL(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  body: Buffer,
): Promise<boolean> {
  if (method !== 'POST') {
    notFound(res);
    return true;
  }
  const parsed = parseJsonBody(body);
  if (parsed === null) {
    sendJson(res, 400, { errors: [{ message: 'Invalid JSON' }] });
    return true;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        return { data: null, errors: [{ message: 'Invalid operation' }] };
      }
      const record = entry as Record<string, unknown>;
      const query = typeof record.query === 'string' ? record.query : '';
      const variables = (typeof record.variables === 'object' && record.variables !== null ? record.variables : {}) as Record<string, unknown>;
      return executeGraphQL(forge, query, variables);
    });
    sendJson(res, 200, results);
    return true;
  }
  if (typeof parsed !== 'object') {
    sendJson(res, 400, { errors: [{ message: 'Invalid JSON' }] });
    return true;
  }
  const record = parsed as Record<string, unknown>;
  const query = typeof record.query === 'string' ? record.query : '';
  const variables = (typeof record.variables === 'object' && record.variables !== null ? record.variables : {}) as Record<string, unknown>;
  sendJson(res, 200, executeGraphQL(forge, query, variables));
  return true;
}

async function handleMcp(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  body: Buffer,
): Promise<boolean> {
  if (method === 'DELETE') {
    sendEmpty(res, 204);
    return true;
  }
  if (method === 'GET') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  if (method !== 'POST') {
    notFound(res);
    return true;
  }
  let parsed: unknown;
  try {
    parsed = body.length === 0 ? null : (JSON.parse(body.toString('utf8')) as unknown);
  } catch {
    const error = mcpParseError();
    sendJson(res, error.status, error.body);
    return true;
  }
  const answer = dispatchMcp(forge, parsed);
  if (answer.body === null) {
    sendEmpty(res, answer.status);
    return true;
  }
  sendJson(res, answer.status, answer.body);
  return true;
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const forge = new Forge();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';
        const query = queryOf(req);

        // The env's boot check calls this twice, without a token.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (!isAuthed(req)) {
          badAuth(res);
          return;
        }

        const body = await readBody(req);

        if (path === '/api/graphql') {
          await handleGraphQL(forge, req, res, method, body);
          return;
        }
        if (path === '/mcp') {
          await handleMcp(forge, req, res, method, body);
          return;
        }
        if (path.startsWith('/api/v3')) {
          if (await handleRest(forge, req, res, method, path, query, body)) return;
        }
        if (await handleGit(forge, req, res, method, path, query, body)) return;
        notFound(res);
      } catch (error) {
        try {
          sendJson(res, 500, { message: 'Internal Server Error' });
        } catch {
          // The socket is gone; nothing left to do.
        }
        process.stderr.write(`forge: request failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      }
    })();
  });
}
