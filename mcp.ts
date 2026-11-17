// MCP over /mcp: JSON-RPC 2.0 Streamable HTTP, modern revision 2026-07-28.
// `server/discover` first (the suite's probe), `initialize` as a legacy
// fallback, six tools over the same store the REST surface uses.

import { Forge, isErr } from './store.ts';

export const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const MCP_SERVER_INFO = { name: 'forge', version: '1.0.0' };

export interface McpToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

// Static list (built once): two tools/list calls must answer byte-identically.
export const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
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
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

export interface McpResponse {
  readonly status: number;
  readonly body: unknown | null;
}

function jsonRpcResult(id: unknown, result: unknown): McpResponse {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function jsonRpcError(id: unknown, code: number, message: string, data?: unknown): McpResponse {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { status: 200, body: { jsonrpc: '2.0', id, error } };
}

export function mcpParseError(): McpResponse {
  return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
}

function toolTextResult(result: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function toolErrorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function requiredArg(args: Record<string, unknown>, name: string): unknown {
  const value = args[name];
  if (value === undefined || value === null || (typeof value === 'string' && value === '')) {
    throw new Error(`missing required argument: ${name}`);
  }
  return value;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = String(requiredArg(args, 'name'));
      const description = typeof args.description === 'string' ? args.description : '';
      const isPrivate = args.private === true;
      const created = forge.createRepo(repoName, description, isPrivate);
      if (isErr(created)) return toolErrorResult(created.detail ?? created.error);
      return toolTextResult(forge.repoJson(created));
    }
    case 'get_repo': {
      const owner = String(requiredArg(args, 'owner'));
      const repoName = String(requiredArg(args, 'repo'));
      const repo = forge.getRepo(owner, repoName);
      if (repo === undefined) return toolErrorResult('Repository not found');
      return toolTextResult(forge.repoJson(repo));
    }
    case 'create_issue': {
      const owner = String(requiredArg(args, 'owner'));
      const repoName = String(requiredArg(args, 'repo'));
      const title = String(requiredArg(args, 'title'));
      const body = typeof args.body === 'string' ? args.body : '';
      const repo = forge.getRepo(owner, repoName);
      if (repo === undefined) return toolErrorResult('Repository not found');
      const created = forge.createIssue(repo, title, body, []);
      if (isErr(created)) return toolErrorResult(created.detail ?? created.error);
      return toolTextResult(forge.issueJson(repo, created));
    }
    case 'list_issues': {
      const owner = String(requiredArg(args, 'owner'));
      const repoName = String(requiredArg(args, 'repo'));
      const state = typeof args.state === 'string' ? args.state : 'all';
      const repo = forge.getRepo(owner, repoName);
      if (repo === undefined) return toolErrorResult('Repository not found');
      const list = forge.listIssues(repo, state === 'open' || state === 'closed' ? state : 'all', 'created', 'asc', 100, 1);
      return toolTextResult(list.map((issue) => forge.issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const owner = String(requiredArg(args, 'owner'));
      const repoName = String(requiredArg(args, 'repo'));
      const title = String(requiredArg(args, 'title'));
      const head = String(requiredArg(args, 'head'));
      const base = String(requiredArg(args, 'base'));
      const repo = forge.getRepo(owner, repoName);
      if (repo === undefined) return toolErrorResult('Repository not found');
      const created = forge.createPull(repo, title, head, base, '');
      if (isErr(created)) return toolErrorResult(created.detail ?? created.error);
      return toolTextResult(forge.pullJson(repo, created));
    }
    case 'merge_pull_request': {
      const owner = String(requiredArg(args, 'owner'));
      const repoName = String(requiredArg(args, 'repo'));
      const pullNumber = Number(requiredArg(args, 'pull_number'));
      const repo = forge.getRepo(owner, repoName);
      if (repo === undefined) return toolErrorResult('Repository not found');
      const pull = forge.getPull(repo, pullNumber);
      if (pull === undefined) return toolErrorResult('Pull request not found');
      const merged = forge.mergePull(repo, pull);
      if (isErr(merged)) return toolErrorResult(merged.detail ?? merged.error);
      return toolTextResult(forge.pullJson(repo, pull));
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/**
 * Dispatch one parsed JSON-RPC request. Returns the HTTP status and the JSON
 * body (null body means an empty 202/204-style answer).
 */
export function dispatchMcp(forge: Forge, request: unknown): McpResponse {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const req = request as Record<string, unknown>;
  const id = req.id;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (typeof req.params === 'object' && req.params !== null ? req.params : {}) as Record<string, unknown>;

  // Notifications (no id) are answered 202 with an empty body.
  if (id === undefined) {
    return { status: 202, body: null };
  }

  // A declared protocol version that this server does not speak is refused
  // with -32022 and the supported list (except `initialize`, where the client
  // negotiates by trying revisions in order and needs -32602 to move on).
  const meta = (typeof params._meta === 'object' && params._meta !== null ? params._meta : {}) as Record<string, unknown>;
  const declared = meta['io.modelcontextprotocol/protocolVersion'];
  if (method !== 'initialize' && typeof declared === 'string' && !MCP_SUPPORTED_VERSIONS.includes(declared)) {
    return jsonRpcError(id, -32022, 'Unsupported protocol version', { supported: MCP_SUPPORTED_VERSIONS });
  }

  if (method === 'server/discover') {
    return jsonRpcResult(id, {
      supportedVersions: MCP_SUPPORTED_VERSIONS,
      serverInfo: MCP_SERVER_INFO,
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
    });
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    if (!MCP_SUPPORTED_VERSIONS.includes(requested)) {
      return jsonRpcError(id, -32602, `Unsupported protocol version: ${requested}`);
    }
    return jsonRpcResult(id, {
      protocolVersion: requested,
      capabilities: { tools: {} },
      serverInfo: MCP_SERVER_INFO,
    });
  }

  if (method === 'tools/list') {
    return jsonRpcResult(id, { tools: MCP_TOOLS });
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
    if (name === '') return jsonRpcError(id, -32602, 'Missing tool name');
    if (!MCP_TOOLS.some((tool) => tool.name === name)) {
      return jsonRpcError(id, -32602, `Unknown tool: ${name}`);
    }
    try {
      const result = callTool(forge, name, args);
      return jsonRpcResult(id, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Tool call failed';
      if (message.startsWith('missing required argument:')) {
        return jsonRpcError(id, -32602, message);
      }
      return jsonRpcResult(id, toolErrorResult(message));
    }
  }

  if (method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }

  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}
