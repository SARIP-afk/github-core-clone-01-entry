// GraphQL over /api/graphql: a small recursive-descent parser plus an executor
// for the document shapes the suite sends (viewer, repository, issue and pull
// request reads, the five mutations, __type introspection, node, batching).
// Unknown fields are HTTP-200 GraphQL errors, never HTTP errors.

import { Forge, FIXED_NOW_ISO, type Issue, type PullRequest, type Repo } from './store.ts';

// ---------------------------------------------------------------------------
// tokenizer + parser
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';
interface Token {
  readonly kind: TokenKind;
  readonly value: string;
}

const PUNCT = new Set(['!', '$', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|', '&']);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '\\' ? '\\' : esc === '"' ? '"' : esc === '/' ? '/' : esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.]/.test(source[j] as string)) j += 1;
      const raw = source.slice(i, j);
      tokens.push({ kind: raw.includes('.') ? 'float' : 'int', value: raw });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_A-Za-z0-9]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`graphql: unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

export interface Selection {
  readonly alias: string;
  readonly name: string;
  readonly args: { name: string; value: ValueNode }[];
  readonly selections: Selection[] | null;
  readonly inlineFragmentOn: string | null;
}

export interface Operation {
  readonly kind: 'query' | 'mutation';
  readonly name: string | null;
  readonly selections: Selection[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`graphql: expected '${value}' but got '${token.value}'`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name' || (value !== undefined && token.value !== value)) {
      throw new Error(`graphql: expected name ${value ?? ''} but got '${token.value}'`);
    }
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      kind = token.value;
      this.next();
    }
    let name: string | null = null;
    if (this.peek().kind === 'name') name = this.next().value;
    if (this.peek().kind === 'punct' && this.peek().value === '(') this.skipVariableDefinitions();
    const selections = this.parseSelectionSet();
    return { kind, name, selections };
  }

  private skipVariableDefinitions(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'eof') throw new Error('graphql: unterminated variable definitions');
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') depth -= 1;
      if (token.kind === 'punct' && token.value === '[') depth += 1;
      if (token.kind === 'punct' && token.value === ']') depth -= 1;
      if (token.kind === 'punct' && token.value === '{') depth += 1;
      if (token.kind === 'punct' && token.value === '}') depth -= 1;
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('graphql: unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      let on: string | null = null;
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        on = this.expectName();
      }
      const selections = this.parseSelectionSet();
      return { alias: '', name: '', args: [], selections, inlineFragmentOn: on };
    }
    const first = this.expectName();
    let alias = first;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      name = this.expectName();
    }
    const args: { name: string; value: ValueNode }[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    let selections: Selection[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selections = this.parseSelectionSet();
    }
    return { alias, name, args, selections, inlineFragmentOn: null };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name' && token.value === 'true') return { kind: 'boolean', value: true };
    if (token.kind === 'name' && token.value === 'false') return { kind: 'boolean', value: false };
    if (token.kind === 'name' && token.value === 'null') return { kind: 'null' };
    if (token.kind === 'name') return { kind: 'enum', value: token.value };
    throw new Error(`graphql: unexpected value token '${token.value}'`);
  }
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => evalValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

function argValue(selection: Selection, name: string, variables: Record<string, unknown>): unknown {
  const arg = selection.args.find((entry) => entry.name === name);
  return arg === undefined ? undefined : evalValue(arg.value, variables);
}

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

type GqlObject =
  | { type: 'Query' }
  | { type: 'Mutation' }
  | { type: 'Repository'; repo: Repo }
  | { type: 'Issue'; repo: Repo; issue: Issue }
  | { type: 'PullRequest'; repo: Repo; pull: PullRequest }
  | { type: 'User'; login: string }
  | { type: 'IssueConnection'; repo: Repo; issues: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { type: 'PullRequestConnection'; pulls: { repo: Repo; pull: PullRequest }[] }
  | { type: 'PullRequestFileConnection'; files: { path: string }[] }
  | { type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { type: 'BranchRef'; name: string }
  | { type: 'Type'; name: string }
  | { type: 'Field'; name: string }
  | { type: 'EnumValue'; name: string }
  | { type: 'CreateIssuePayload'; repo: Repo; issue: Issue | null }
  | { type: 'CloseIssuePayload'; repo: Repo; issue: Issue | null }
  | { type: 'CreatePullRequestPayload'; repo: Repo; pull: PullRequest | null }
  | { type: 'MergePullRequestPayload'; repo: Repo; pull: PullRequest | null }
  | { type: 'AddCommentPayload'; repo: Repo; comment: { id: number; body: string } | null }
  | { type: 'CommentEdge'; repo: Repo; comment: { id: number; body: string } }
  | { type: 'IssueComment'; repo: Repo; comment: { id: number; body: string }; issueNumber: number };

const ISSUE_TYPE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'labels', 'comments'];
const PULL_REQUEST_TYPE_FIELDS = ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'createdAt', 'updatedAt', 'author'];
const REPOSITORY_TYPE_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt', 'url'];
const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'ORGANIZATION', 'TEAM', 'PROJECT', 'WIKI', 'APP', 'MARKETPLACE_LISTING'];

function cursorForIssue(issue: Issue): string {
  return Buffer.from(`issue:${issue.number}`, 'utf8').toString('base64');
}

function issueNumberAfter(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return 0;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^issue:(\d+)$/.exec(text);
    return match === null ? 0 : Number.parseInt(match[1], 10);
  } catch {
    return 0;
  }
}

interface Executor {
  forge: Forge;
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

function resolveField(exec: Executor, parent: GqlObject, selection: Selection): unknown {
  const { forge, variables } = exec;
  switch (parent.type) {
    case 'Query': {
      if (selection.name === 'viewer') return { type: 'User', login: forge.viewer.login } as GqlObject;
      if (selection.name === 'repository') {
        const owner = argValue(selection, 'owner', variables);
        const name = argValue(selection, 'name', variables);
        const repo = typeof owner === 'string' && typeof name === 'string' ? forge.getRepo(owner, name) : undefined;
        return repo === undefined ? null : ({ type: 'Repository', repo } as GqlObject);
      }
      if (selection.name === 'node') {
        const id = argValue(selection, 'id', variables);
        if (typeof id !== 'string') return null;
        const decoded = forge.decodeGlobalId(id);
        if (decoded === null || decoded.kind !== 'Repository') return null;
        const repo = forge.getRepoById(decoded.repoId);
        return repo === undefined ? null : ({ type: 'Repository', repo } as GqlObject);
      }
      if (selection.name === '__type') {
        const name = argValue(selection, 'name', variables);
        if (typeof name !== 'string') return null;
        if (name === 'Issue' || name === 'PullRequest' || name === 'Repository' || name === 'SearchType') {
          return { type: 'Type', name } as GqlObject;
        }
        return null;
      }
      break;
    }
    case 'Mutation': {
      if (selection.name === 'createIssue') {
        const input = argValue(selection, 'input', variables) as Record<string, unknown> | undefined;
        const repoId = typeof input?.repositoryId === 'string' ? forge.decodeGlobalId(input.repositoryId)?.repoId : undefined;
        const repo = repoId === undefined ? undefined : forge.getRepoById(repoId);
        if (repo === undefined) return { type: 'CreateIssuePayload', repo: undefined as unknown as Repo, issue: null } as GqlObject;
        const title = typeof input?.title === 'string' ? input.title : '';
        const body = typeof input?.body === 'string' ? input.body : '';
        const created = forge.createIssue(repo, title, body, []);
        const issue = created === null || typeof created === 'object' && 'error' in created ? null : (created as Issue);
        return { type: 'CreateIssuePayload', repo, issue } as GqlObject;
      }
      if (selection.name === 'closeIssue') {
        const input = argValue(selection, 'input', variables) as Record<string, unknown> | undefined;
        const decoded = typeof input?.issueId === 'string' ? forge.decodeGlobalId(input.issueId) : null;
        const repo = decoded !== null && decoded.kind === 'Issue' ? forge.getRepoById(decoded.repoId) : undefined;
        const issue = repo !== undefined && decoded?.number !== undefined ? forge.updateIssue(repo, decoded.number, { state: 'closed' }) ?? null : null;
        return { type: 'CloseIssuePayload', repo: repo as unknown as Repo, issue } as GqlObject;
      }
      if (selection.name === 'createPullRequest') {
        const input = argValue(selection, 'input', variables) as Record<string, unknown> | undefined;
        const repoId = typeof input?.repositoryId === 'string' ? forge.decodeGlobalId(input.repositoryId)?.repoId : undefined;
        const repo = repoId === undefined ? undefined : forge.getRepoById(repoId);
        if (repo === undefined) return { type: 'CreatePullRequestPayload', repo: undefined as unknown as Repo, pull: null } as GqlObject;
        const title = typeof input?.title === 'string' ? input.title : '';
        const head = typeof input?.headRefName === 'string' ? input.headRefName : '';
        const base = typeof input?.baseRefName === 'string' ? input.baseRefName : '';
        const created = forge.createPull(repo, title, head, base, '');
        const pull = typeof created === 'object' && 'error' in created ? null : (created as PullRequest);
        return { type: 'CreatePullRequestPayload', repo, pull } as GqlObject;
      }
      if (selection.name === 'mergePullRequest') {
        const input = argValue(selection, 'input', variables) as Record<string, unknown> | undefined;
        const decoded = typeof input?.pullRequestId === 'string' ? forge.decodeGlobalId(input.pullRequestId) : null;
        const repo = decoded !== null && decoded.kind === 'PullRequest' ? forge.getRepoById(decoded.repoId) : undefined;
        let pull: PullRequest | null = null;
        if (repo !== undefined && decoded?.number !== undefined) {
          const found = forge.getPull(repo, decoded.number);
          if (found !== undefined) {
            forge.mergePull(repo, found);
            pull = found;
          }
        }
        return { type: 'MergePullRequestPayload', repo: repo as unknown as Repo, pull } as GqlObject;
      }
      if (selection.name === 'addComment') {
        const input = argValue(selection, 'input', variables) as Record<string, unknown> | undefined;
        const decoded = typeof input?.subjectId === 'string' ? forge.decodeGlobalId(input.subjectId) : null;
        const repo = decoded !== null && decoded.kind === 'Issue' ? forge.getRepoById(decoded.repoId) : undefined;
        let comment: { id: number; body: string } | null = null;
        if (repo !== undefined && decoded?.number !== undefined && typeof input?.body === 'string') {
          const added = forge.addComment(repo, decoded.number, input.body);
          if (typeof added === 'object' && !('error' in added)) comment = { id: added.id, body: added.body };
        }
        return { type: 'AddCommentPayload', repo: repo as unknown as Repo, comment } as GqlObject;
      }
      break;
    }
    case 'Repository': {
      const repo = parent.repo;
      switch (selection.name) {
        case 'id':
          return forge.repoGlobalId(repo);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return { type: 'User', login: repo.owner } as GqlObject;
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return tip === undefined ? null : ({ type: 'BranchRef', name: repo.defaultBranch } as GqlObject);
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const number = argValue(selection, 'number', variables);
          const issue = typeof number === 'number' ? forge.getIssue(repo, number) : undefined;
          return issue === undefined ? null : ({ type: 'Issue', repo, issue } as GqlObject);
        }
        case 'issues': {
          let list = [...repo.issues];
          const states = argValue(selection, 'states', variables);
          if (Array.isArray(states) && states.length > 0) {
            const wanted = new Set(states.map((state) => String(state).toLowerCase()));
            list = list.filter((issue) => wanted.has(issue.state));
          }
          const orderBy = argValue(selection, 'orderBy', variables) as Record<string, unknown> | undefined;
          const direction = orderBy !== undefined && orderBy.direction === 'ASC' ? 'asc' : orderBy !== undefined && orderBy.direction === 'DESC' ? 'desc' : 'asc';
          list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          const afterNumber = issueNumberAfter(argValue(selection, 'after', variables));
          if (afterNumber > 0) list = list.filter((issue) => (direction === 'asc' ? issue.number > afterNumber : issue.number < afterNumber));
          const first = argValue(selection, 'first', variables);
          const limit = typeof first === 'number' ? first : list.length;
          const page = list.slice(0, limit);
          const hasNextPage = list.length > page.length;
          const endCursor = page.length > 0 ? cursorForIssue(page[page.length - 1] as Issue) : null;
          return {
            type: 'IssueConnection',
            repo,
            issues: page,
            pageInfo: { hasNextPage, endCursor },
          } as GqlObject;
        }
        case 'pullRequests': {
          const first = argValue(selection, 'first', variables);
          const limit = typeof first === 'number' ? first : repo.pulls.length;
          const pulls = [...repo.pulls].sort((a, b) => a.createdSeq - b.createdSeq).slice(0, limit);
          return { type: 'PullRequestConnection', pulls: pulls.map((pull) => ({ repo, pull })) } as GqlObject;
        }
        case 'pullRequest': {
          const number = argValue(selection, 'number', variables);
          const pull = typeof number === 'number' ? forge.getPull(repo, number) : undefined;
          return pull === undefined ? null : ({ type: 'PullRequest', repo, pull } as GqlObject);
        }
      }
      break;
    }
    case 'Issue': {
      switch (selection.name) {
        case 'id':
          return forge.issueGlobalId(parent.repo, parent.issue);
        case 'number':
          return parent.issue.number;
        case 'title':
          return parent.issue.title;
        case 'state':
          return parent.issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'body':
          return parent.issue.body;
      }
      break;
    }
    case 'PullRequest': {
      switch (selection.name) {
        case 'id':
          return forge.pullGlobalId(parent.repo, parent.pull);
        case 'number':
          return parent.pull.number;
        case 'state':
          return parent.pull.merged ? 'MERGED' : parent.pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged':
          return parent.pull.merged;
        case 'headRefName':
          return parent.pull.headRef;
        case 'baseRefName':
          return parent.pull.baseRef;
        case 'mergeable':
          return forge.pullMergeable(parent.repo, parent.pull);
        case 'files': {
          const first = argValue(selection, 'first', variables);
          const limit = typeof first === 'number' ? first : Number.POSITIVE_INFINITY;
          const files = forge.pullFiles(parent.repo, parent.pull).slice(0, limit);
          return { type: 'PullRequestFileConnection', files: files.map((file) => ({ path: file.filename })) } as GqlObject;
        }
      }
      break;
    }
    case 'User': {
      if (selection.name === 'login') return parent.login;
      break;
    }
    case 'IssueConnection': {
      if (selection.name === 'nodes') {
        return parent.issues.map((issue) => ({ type: 'Issue', repo: parent.repo, issue }) as GqlObject);
      }
      if (selection.name === 'pageInfo') {
        return { type: 'PageInfo', hasNextPage: parent.pageInfo.hasNextPage, endCursor: parent.pageInfo.endCursor } as GqlObject;
      }
      break;
    }
    case 'PullRequestConnection': {
      if (selection.name === 'nodes') return parent.pulls.map((entry) => ({ type: 'PullRequest', repo: entry.repo, pull: entry.pull }) as GqlObject);
      break;
    }
    case 'PullRequestFileConnection': {
      if (selection.name === 'nodes') return parent.files.map((file) => file);
      break;
    }
    case 'PageInfo': {
      if (selection.name === 'hasNextPage') return parent.hasNextPage;
      if (selection.name === 'endCursor') return parent.endCursor;
      break;
    }
    case 'BranchRef': {
      if (selection.name === 'name') return parent.name;
      break;
    }
    case 'Type': {
      if (selection.name === 'name') return parent.name;
      if (selection.name === 'fields') {
        const names = parent.name === 'Issue' ? ISSUE_TYPE_FIELDS : parent.name === 'PullRequest' ? PULL_REQUEST_TYPE_FIELDS : parent.name === 'Repository' ? REPOSITORY_TYPE_FIELDS : [];
        return names.map((name) => ({ type: 'Field', name }) as GqlObject);
      }
      if (selection.name === 'enumValues') {
        if (parent.name !== 'SearchType') return null;
        return SEARCH_TYPE_VALUES.map((name) => ({ type: 'EnumValue', name }) as GqlObject);
      }
      break;
    }
    case 'Field':
    case 'EnumValue': {
      if (selection.name === 'name') return parent.name;
      break;
    }
    case 'CreateIssuePayload': {
      if (selection.name === 'issue') {
        return parent.issue === null ? null : ({ type: 'Issue', repo: parent.repo, issue: parent.issue } as GqlObject);
      }
      break;
    }
    case 'CloseIssuePayload': {
      if (selection.name === 'issue') {
        return parent.issue === null ? null : ({ type: 'Issue', repo: parent.repo, issue: parent.issue } as GqlObject);
      }
      break;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (selection.name === 'pullRequest') {
        return parent.pull === null ? null : ({ type: 'PullRequest', repo: parent.repo, pull: parent.pull } as GqlObject);
      }
      break;
    }
    case 'AddCommentPayload': {
      if (selection.name === 'commentEdge') {
        return parent.comment === null
          ? null
          : ({ type: 'CommentEdge', repo: parent.repo, comment: parent.comment } as GqlObject);
      }
      break;
    }
    case 'CommentEdge': {
      if (selection.name === 'node') {
        return { type: 'IssueComment', repo: parent.repo, comment: parent.comment, issueNumber: 0 } as GqlObject;
      }
      break;
    }
    case 'IssueComment': {
      if (selection.name === 'id') return forge.commentGlobalId(parent.repo, parent.issueNumber, parent.comment.id);
      if (selection.name === 'body') return parent.comment.body;
      break;
    }
  }
  return undefined;
}

function isGqlObject(value: unknown): value is GqlObject {
  return typeof value === 'object' && value !== null && 'type' in value && typeof (value as { type: unknown }).type === 'string';
}

/** Resolve a selection set against an object, collecting GraphQL errors. */
function resolveSelections(
  exec: Executor,
  parent: GqlObject,
  selections: Selection[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.inlineFragmentOn !== null) {
      // Inline fragment: applies only when the object's type matches.
      if (selection.inlineFragmentOn === parent.type && selection.selections !== null) {
        const inner = resolveSelections(exec, parent, selection.selections);
        Object.assign(out, inner);
      }
      continue;
    }
    const value = resolveField(exec, parent, selection);
    if (value === undefined) {
      exec.errors.push({ message: `Cannot query field "${selection.name}" on type "${parent.type}".` });
      out[selection.alias] = null;
      continue;
    }
    if (value === null || typeof value !== 'object') {
      out[selection.alias] = value;
      continue;
    }
    if (Array.isArray(value)) {
      out[selection.alias] = value.map((item) => {
        if (item === null || typeof item !== 'object' || !isGqlObject(item)) return item;
        return selection.selections === null ? item : resolveSelections(exec, item, selection.selections);
      });
      continue;
    }
    if (isGqlObject(value)) {
      out[selection.alias] = selection.selections === null ? value : resolveSelections(exec, value, selection.selections);
      continue;
    }
    // Plain object (e.g. a file node {path}): resolve its scalar fields.
    if (selection.selections !== null) {
      const inner: Record<string, unknown> = {};
      for (const sub of selection.selections) {
        inner[sub.alias] = (value as Record<string, unknown>)[sub.name] ?? null;
      }
      out[selection.alias] = inner;
    } else {
      out[selection.alias] = value;
    }
  }
  return out;
}

/** Execute one GraphQL operation document. Returns the {data, errors?} envelope. */
export function executeGraphQL(
  forge: Forge,
  query: string,
  variables: Record<string, unknown>,
): { data: Record<string, unknown> | null; errors?: { message: string }[] } {
  let operations: Operation[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : 'GraphQL syntax error' }] };
  }
  const operation = operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'GraphQL: empty document' }] };
  const exec: Executor = { forge, variables, errors: [] };
  const root: GqlObject = operation.kind === 'mutation' ? { type: 'Mutation' } : { type: 'Query' };
  const data = resolveSelections(exec, root, operation.selections);
  if (exec.errors.length > 0) return { data, errors: exec.errors };
  return { data };
}

export { FIXED_NOW_ISO };
