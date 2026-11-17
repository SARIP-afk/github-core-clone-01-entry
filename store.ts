// The forge's in-memory store: repos, git objects, refs, issues, pull requests,
// labels, comments — and every operation the REST, GraphQL and MCP surfaces
// call. One process, no disk, no clock: every timestamp is a fixed constant
// (the scenario epoch), every id a counter in request order, so two runs of
// the same trial produce the same state.

import {
  buildCommit,
  buildTag,
  buildTree,
  collectReachable,
  FIXTURE_EPOCH_SEC,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
  type GitObject,
  type TreeEntry,
} from './gitutil.ts';
import { viewerUser, type ScenarioUser } from './scenario.ts';

export const FIXED_NOW_ISO = '2025-01-01T00:00:00Z';
export const VIEWER_IDENTITY = 'ada iversen <adaiversen@example.invalid>';

export interface IssueLabel {
  readonly name: string;
  readonly color: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  readonly repoId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly createdSeq: number;
  updatedSeq: number;
  closedAt: string | null;
}

export interface IssueComment {
  readonly id: number;
  readonly issueNumber: number;
  readonly body: string;
  readonly createdSeq: number;
}

export interface PullRequest {
  readonly id: number;
  readonly number: number;
  readonly repoId: number;
  title: string;
  body: string;
  readonly headRef: string;
  readonly baseRef: string;
  readonly headSha: string;
  readonly baseSha: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly createdSeq: number;
}

export interface Repo {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  description: string;
  readonly private: boolean;
  readonly defaultBranch: string;
  readonly refs: Map<string, string>;
  readonly objects: Map<string, GitObject>;
  readonly issues: Issue[];
  readonly pulls: PullRequest[];
  readonly labels: Map<string, IssueLabel>;
  readonly comments: Map<number, IssueComment[]>;
  readonly createdSeq: number;
}

export interface FileChange {
  readonly filename: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

export type StoreError = { readonly error: string; readonly detail?: string };

function isErr<T>(value: T | StoreError): value is StoreError {
  return typeof value === 'object' && value !== null && 'error' in value;
}

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function countLines(content: Buffer): number {
  if (content.length === 0) return 0;
  const text = content.toString('utf8');
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

/** Multiset line diff: lines added / removed between two contents. */
function lineDiff(oldContent: Buffer, newContent: Buffer): { additions: number; deletions: number } {
  const oldLines = oldContent.toString('utf8').split('\n');
  const newLines = newContent.toString('utf8').split('\n');
  if (oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines[newLines.length - 1] === '') newLines.pop();
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  const newCounts = new Map<string, number>();
  for (const line of newLines) newCounts.set(line, (newCounts.get(line) ?? 0) + 1);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of newCounts) {
    const had = oldCounts.get(line) ?? 0;
    if (count > had) additions += count - had;
  }
  for (const [line, count] of oldCounts) {
    const has = newCounts.get(line) ?? 0;
    if (count > has) deletions += count - has;
  }
  return { additions, deletions };
}

export class Forge {
  readonly viewer: ScenarioUser;
  private readonly reposByKey = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextPullId = 1;
  private nextCommentId = 1;
  private nextSeq = 1;

  constructor() {
    this.viewer = viewerUser();
  }

  // ---------------------------------------------------------- repos

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.reposByKey.get(this.repoKey(owner, name));
  }

  getRepoById(id: number): Repo | undefined {
    for (const repo of this.reposByKey.values()) {
      if (repo.id === id) return repo;
    }
    return undefined;
  }

  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.reposByKey.values()) {
      if (repo.owner === this.viewer.login) out.push(repo);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | StoreError {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) || name.endsWith('.git')) {
      return { error: 'invalid', detail: `name '${name}' is not a valid repository name` };
    }
    if (this.getRepo(this.viewer.login, name) !== undefined) {
      return { error: 'exists', detail: 'name already exists on this account' };
    }
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: this.viewer.login,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      refs: new Map(),
      objects: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      comments: new Map(),
      createdSeq: this.nextSeq,
    };
    this.nextRepoId += 1;
    this.nextSeq += 1;
    this.reposByKey.set(this.repoKey(repo.owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.reposByKey.delete(this.repoKey(owner, name));
  }

  // ---------------------------------------------------------- git objects + refs

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  putObject(repo: Repo, object: GitObject): string {
    const oid = hashObject(object.type, object.data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    return oid;
  }

  refTip(repo: Repo, refname: string): string | undefined {
    return repo.refs.get(refname);
  }

  setRef(repo: Repo, refname: string, oid: string): void {
    repo.refs.set(refname, oid);
  }

  deleteRef(repo: Repo, refname: string): boolean {
    return repo.refs.delete(refname);
  }

  /** Peel a tag (recursively) to its commit, or return the commit itself. */
  peelToCommit(repo: Repo, oid: string): string | undefined {
    const object = repo.objects.get(oid);
    if (object === undefined) return undefined;
    if (object.type === 'commit') return oid;
    if (object.type === 'tag') return this.peelToCommit(repo, parseTag(object.data).object);
    return undefined;
  }

  /** True when `ancestor` is reachable from `descendant` (tags peeled). */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const target = this.peelToCommit(repo, descendant);
    if (target === undefined) return false;
    const seen = new Set<string>([target]);
    const queue = [target];
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (parent === ancestor) return true;
        if (!seen.has(parent)) {
          seen.add(parent);
          queue.push(parent);
        }
      }
    }
    return false;
  }

  /** Every object reachable from `roots` (used to subtract what a client has). */
  reachableSet(repo: Repo, roots: readonly string[]): Set<string> {
    const out = new Set<string>();
    for (const object of collectReachable(roots, (oid) => repo.objects.get(oid))) {
      out.add(hashObject(object.type, object.data));
    }
    return out;
  }

  /** All refs, sorted by name (deterministic). */
  listRefs(repo: Repo): { refname: string; oid: string }[] {
    return [...repo.refs.entries()]
      .map(([refname, oid]) => ({ refname, oid }))
      .sort((a, b) => (a.refname < b.refname ? -1 : a.refname > b.refname ? 1 : 0));
  }

  /** The commit history of a ref, newest first, first-parent walk. */
  commitHistory(repo: Repo, tipOid: string): { sha: string; commit: { message: string } }[] {
    const out: { sha: string; commit: { message: string } }[] = [];
    let current: string | undefined = tipOid;
    const seen = new Set<string>();
    while (current !== undefined && current !== ZERO_OID && !seen.has(current)) {
      seen.add(current);
      const object = repo.objects.get(current);
      if (object === undefined || object.type !== 'commit') break;
      const parsed = parseCommit(object.data);
      out.push({ sha: current, commit: { message: parsed.message } });
      current = parsed.parents[0];
    }
    return out;
  }

  // ---------------------------------------------------------- file trees

  /** The full file list at a commit: path -> {blob oid, mode}. */
  listFilesAt(repo: Repo, commitOid: string): Map<string, { blobOid: string; mode: string }> {
    const files = new Map<string, { blobOid: string; mode: string }>();
    const commit = repo.objects.get(commitOid);
    if (commit === undefined || commit.type !== 'commit') return files;
    const rootTree = parseCommit(commit.data).tree;
    const stack: { treeOid: string; prefix: string }[] = [{ treeOid: rootTree, prefix: '' }];
    while (stack.length > 0) {
      const { treeOid, prefix } = stack.pop() as { treeOid: string; prefix: string };
      const tree = repo.objects.get(treeOid);
      if (tree === undefined || tree.type !== 'tree') continue;
      for (const entry of parseTree(tree.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000' || entry.mode === '040000') {
          stack.push({ treeOid: entry.oid, prefix: path });
        } else if (entry.mode !== '160000') {
          files.set(path, { blobOid: entry.oid, mode: entry.mode });
        }
      }
    }
    return files;
  }

  /**
   * Build (and store) the tree for a full file set. Returns the root tree oid.
   * `files`: path -> raw content bytes. Blobs are stored as they are created.
   */
  treeFromFiles(repo: Repo, files: Map<string, Buffer>): string {
    const buildDir = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const subdirs = new Map<string, Map<string, Buffer>>();
      for (const [path, content] of files) {
        if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
        const rest = prefix === '' ? path : path.slice(prefix.length + 1);
        const slash = rest.indexOf('/');
        if (slash === -1) {
          const blobOid = this.putObject(repo, { type: 'blob', data: content });
          entries.push({ mode: '100644', name: rest, oid: blobOid });
        } else {
          const dir = rest.slice(0, slash);
          let sub = subdirs.get(dir);
          if (sub === undefined) {
            sub = new Map();
            subdirs.set(dir, sub);
          }
          sub.set(path, content);
        }
      }
      for (const [dir, sub] of [...subdirs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        entries.push({ mode: '40000', name: dir, oid: buildDir(prefix === '' ? dir : `${prefix}/${dir}`) });
      }
      const data = buildTree(entries);
      return this.putObject(repo, { type: 'tree', data });
    };
    return buildDir('');
  }

  /**
   * Create a commit on `branch` from a full file set. When the branch does not
   * exist it is created from the default branch's tip (or as the first commit
   * when the repo is unborn). Returns the new commit oid.
   */
  commitFiles(repo: Repo, branch: string, files: Map<string, Buffer>, message: string): string {
    const refname = `refs/heads/${branch}`;
    const currentTip = repo.refs.get(refname);
    const parents: string[] = [];
    if (currentTip !== undefined) {
      parents.push(currentTip);
    } else {
      const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (defaultTip !== undefined && branch !== repo.defaultBranch) parents.push(defaultTip);
    }
    const treeOid = this.treeFromFiles(repo, files);
    const commitData = buildCommit({
      tree: treeOid,
      parents,
      message,
      author: VIEWER_IDENTITY,
      committer: VIEWER_IDENTITY,
      timestamp: FIXTURE_EPOCH_SEC,
    });
    const commitOid = this.putObject(repo, { type: 'commit', data: commitData });
    repo.refs.set(refname, commitOid);
    return commitOid;
  }

  /** Read the raw bytes of every file at a commit (path -> bytes). */
  fileBytesAt(repo: Repo, commitOid: string): Map<string, Buffer> {
    const out = new Map<string, Buffer>();
    for (const [path, { blobOid }] of this.listFilesAt(repo, commitOid)) {
      const blob = repo.objects.get(blobOid);
      if (blob !== undefined && blob.type === 'blob') out.set(path, blob.data);
    }
    return out;
  }

  // ---------------------------------------------------------- contents API

  /**
   * PUT /contents: create (201) or update (200) a file on a branch. `expectedSha`
   * must match the current blob when given, else 409. A missing branch is
   * created from the default branch's tip.
   */
  putContent(
    repo: Repo,
    path: string,
    content: Buffer,
    message: string,
    branch?: string,
    expectedSha?: string,
  ): { status: 201 | 200; blobOid: string; commitOid: string } | StoreError {
    const targetBranch = branch ?? repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${targetBranch}`);
    const files = tip !== undefined ? this.fileBytesAt(repo, tip) : new Map<string, Buffer>();
    const existed = files.has(path);
    if (expectedSha !== undefined) {
      const current = tip !== undefined ? this.listFilesAt(repo, tip).get(path) : undefined;
      if (current === undefined || current.blobOid !== expectedSha) {
        return { error: 'conflict', detail: 'sha does not match the current file' };
      }
    }
    files.set(path, content);
    const commitOid = this.commitFiles(repo, targetBranch, files, message);
    const blobOid = hashObject('blob', content);
    return { status: existed ? 200 : 201, blobOid, commitOid };
  }

  /** GET /contents: a file, or a directory listing, or null when absent. */
  getContent(
    repo: Repo,
    path: string,
    ref?: string,
  ): { kind: 'file'; blobOid: string; content: Buffer } | { kind: 'dir'; entries: { type: 'file' | 'dir'; name: string; path: string; sha: string }[] } | null {
    const tip = ref !== undefined ? this.resolveRef(repo, ref) : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (tip === undefined) return null;
    const files = this.listFilesAt(repo, tip);
    if (path === '') {
      const top = new Map<string, { type: 'file' | 'dir'; sha: string }>();
      for (const [filePath, { blobOid }] of files) {
        const slash = filePath.indexOf('/');
        if (slash === -1) top.set(filePath, { type: 'file', sha: blobOid });
        else top.set(filePath.slice(0, slash), { type: 'dir', sha: '' });
      }
      return {
        kind: 'dir',
        entries: [...top.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([name, info]) => ({ type: info.type, name, path: name, sha: info.sha })),
      };
    }
    const file = files.get(path);
    if (file !== undefined) {
      const blob = repo.objects.get(file.blobOid);
      if (blob === undefined) return null;
      return { kind: 'file', blobOid: file.blobOid, content: blob.data };
    }
    const prefix = `${path}/`;
    const children = new Map<string, { type: 'file' | 'dir'; sha: string }>();
    for (const [filePath, { blobOid }] of files) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) children.set(rest, { type: 'file', sha: blobOid });
      else children.set(rest.slice(0, slash), { type: 'dir', sha: '' });
    }
    if (children.size === 0) return null;
    return {
      kind: 'dir',
      entries: [...children.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([name, info]) => ({ type: info.type, name, path: `${path}/${name}`, sha: info.sha })),
    };
  }

  /** DELETE /contents: remove a file (sha must match), creating a commit. */
  deleteContent(
    repo: Repo,
    path: string,
    message: string,
    sha: string,
    branch?: string,
  ): { commitOid: string } | StoreError {
    const targetBranch = branch ?? repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${targetBranch}`);
    if (tip === undefined) return { error: 'not_found', detail: 'file not found' };
    const files = this.listFilesAt(repo, tip);
    const current = files.get(path);
    if (current === undefined) return { error: 'not_found', detail: 'file not found' };
    if (current.blobOid !== sha) return { error: 'conflict', detail: 'sha does not match the current file' };
    const bytes = this.fileBytesAt(repo, tip);
    bytes.delete(path);
    const commitOid = this.commitFiles(repo, targetBranch, bytes, message);
    return { commitOid };
  }

  /** Resolve a ref name (branch, full ref, or commit oid) to a commit oid. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (/^[0-9a-f]{40}$/.test(ref)) {
      return repo.objects.has(ref) ? ref : undefined;
    }
    if (ref.startsWith('refs/')) return repo.refs.get(ref);
    return repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
  }

  // ---------------------------------------------------------- labels

  createLabel(repo: Repo, name: string, color: string): IssueLabel {
    const existing = repo.labels.get(name);
    if (existing !== undefined) return existing;
    const label = { name, color };
    repo.labels.set(name, label);
    return label;
  }

  // ---------------------------------------------------------- issues + comments

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue | StoreError {
    for (const label of labels) {
      if (!repo.labels.has(label)) {
        return { error: 'label', detail: `Label '${label}' does not exist` };
      }
    }
    const issue: Issue = {
      id: this.nextIssueId,
      number: repo.issues.length + 1,
      repoId: repo.id,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdSeq: this.nextSeq,
      updatedSeq: this.nextSeq,
      closedAt: null,
    };
    this.nextIssueId += 1;
    this.nextSeq += 1;
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  listIssues(
    repo: Repo,
    state: 'open' | 'closed' | 'all',
    sort: 'created',
    direction: 'asc' | 'desc',
    perPage: number,
    page: number,
  ): Issue[] {
    void sort;
    let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    list = [...list].sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
    const start = (page - 1) * perPage;
    return list.slice(start, start + perPage);
  }

  updateIssue(repo: Repo, number: number, patch: { state?: string; title?: string; body?: string }): Issue | undefined {
    const issue = this.getIssue(repo, number);
    if (issue === undefined) return undefined;
    if (patch.state === 'closed' || patch.state === 'open') {
      issue.state = patch.state;
      issue.closedAt = patch.state === 'closed' ? FIXED_NOW_ISO : null;
    }
    if (typeof patch.title === 'string') issue.title = patch.title;
    if (typeof patch.body === 'string') issue.body = patch.body;
    issue.updatedSeq = this.nextSeq;
    this.nextSeq += 1;
    return issue;
  }

  addComment(repo: Repo, issueNumber: number, body: string): IssueComment | StoreError {
    if (this.getIssue(repo, issueNumber) === undefined) return { error: 'not_found', detail: 'issue not found' };
    const comment: IssueComment = {
      id: this.nextCommentId,
      issueNumber,
      body,
      createdSeq: this.nextSeq,
    };
    this.nextCommentId += 1;
    this.nextSeq += 1;
    const list = repo.comments.get(issueNumber) ?? [];
    list.push(comment);
    repo.comments.set(issueNumber, list);
    return comment;
  }

  listComments(repo: Repo, issueNumber: number): IssueComment[] {
    return [...(repo.comments.get(issueNumber) ?? [])].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  // ---------------------------------------------------------- pull requests

  createPull(
    repo: Repo,
    title: string,
    head: string,
    base: string,
    body: string,
  ): PullRequest | StoreError {
    const headTip = repo.refs.get(`refs/heads/${head}`);
    if (headTip === undefined) return { error: 'head', detail: `head branch '${head}' does not exist` };
    const baseTip = repo.refs.get(`refs/heads/${base}`);
    if (baseTip === undefined) return { error: 'base', detail: `base branch '${base}' does not exist` };
    const openSameHead = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head);
    if (openSameHead !== undefined) {
      return { error: 'exists', detail: 'a pull request already exists for this head branch' };
    }
    const pull: PullRequest = {
      id: this.nextPullId,
      number: repo.pulls.length + 1,
      repoId: repo.id,
      title,
      body,
      headRef: head,
      baseRef: base,
      headSha: headTip,
      baseSha: baseTip,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: this.nextSeq,
    };
    this.nextPullId += 1;
    this.nextSeq += 1;
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): PullRequest | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  listPulls(repo: Repo, state: 'open' | 'closed' | 'all'): PullRequest[] {
    const list = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
    return [...list].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  /** The file diff between the PR's base (at creation) and its head. */
  pullFiles(repo: Repo, pull: PullRequest): FileChange[] {
    const baseFiles = this.listFilesAt(repo, pull.baseSha);
    const headFiles = this.listFilesAt(repo, pull.headSha);
    const out: FileChange[] = [];
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of [...paths].sort()) {
      const base = baseFiles.get(path);
      const head = headFiles.get(path);
      if (base === undefined && head !== undefined) {
        const content = repo.objects.get(head.blobOid)?.data ?? Buffer.alloc(0);
        const additions = countLines(content);
        out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (base !== undefined && head === undefined) {
        const content = repo.objects.get(base.blobOid)?.data ?? Buffer.alloc(0);
        const deletions = countLines(content);
        out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (base !== undefined && head !== undefined && base.blobOid !== head.blobOid) {
        const oldContent = repo.objects.get(base.blobOid)?.data ?? Buffer.alloc(0);
        const newContent = repo.objects.get(head.blobOid)?.data ?? Buffer.alloc(0);
        let { additions, deletions } = lineDiff(oldContent, newContent);
        if (additions === 0 && deletions === 0) additions = 1;
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  /** Three-way mergeability: clean unless the base moved under a changed file. */
  pullMergeable(repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' {
    const baseAtCreation = this.listFilesAt(repo, pull.baseSha);
    const headFiles = this.listFilesAt(repo, pull.headSha);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (baseTip === undefined) return 'CONFLICTING';
    const currentBase = this.listFilesAt(repo, baseTip);
    const paths = new Set([...baseAtCreation.keys(), ...headFiles.keys()]);
    for (const path of paths) {
      const old = baseAtCreation.get(path)?.blobOid;
      const head = headFiles.get(path)?.blobOid;
      if (old === head) continue;
      const current = currentBase.get(path)?.blobOid;
      if (current !== old && current !== head) return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }

  /**
   * Squash-merge a pull request onto its base branch: one commit whose tree
   * is the current base tree with the PR's changed files applied.
   */
  mergePull(repo: Repo, pull: PullRequest): { commitOid: string } | StoreError {
    if (pull.state === 'closed') return { error: 'merged', detail: 'pull request is already closed' };
    if (this.pullMergeable(repo, pull) === 'CONFLICTING') {
      return { error: 'conflict', detail: 'merge conflict' };
    }
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (baseTip === undefined) return { error: 'not_found', detail: 'base branch not found' };
    const files = this.fileBytesAt(repo, baseTip);
    const headFiles = this.listFilesAt(repo, pull.headSha);
    const baseAtCreation = this.listFilesAt(repo, pull.baseSha);
    const paths = new Set([...baseAtCreation.keys(), ...headFiles.keys()]);
    for (const path of paths) {
      const old = baseAtCreation.get(path)?.blobOid;
      const head = headFiles.get(path);
      if (old === head?.blobOid) continue;
      if (head === undefined) {
        files.delete(path);
      } else {
        const blob = repo.objects.get(head.blobOid);
        if (blob !== undefined && blob.type === 'blob') files.set(path, blob.data);
      }
    }
    const commitOid = this.commitFiles(
      repo,
      pull.baseRef,
      files,
      `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n`,
    );
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FIXED_NOW_ISO;
    pull.mergeCommitSha = commitOid;
    return { commitOid };
  }

  // ---------------------------------------------------------- global ids (GraphQL)

  repoGlobalId(repo: Repo): string {
    return b64(`Repository:${repo.id}`);
  }

  issueGlobalId(repo: Repo, issue: Issue): string {
    return b64(`Issue:${repo.id}:${issue.number}`);
  }

  pullGlobalId(repo: Repo, pull: PullRequest): string {
    return b64(`PullRequest:${repo.id}:${pull.number}`);
  }

  commentGlobalId(repo: Repo, issueNumber: number, commentId: number): string {
    return b64(`IssueComment:${repo.id}:${issueNumber}:${commentId}`);
  }

  decodeGlobalId(id: string): { kind: string; repoId: number; number?: number; commentId?: number } | null {
    try {
      const text = Buffer.from(id, 'base64').toString('utf8');
      const parts = text.split(':');
      if (parts[0] === 'Repository' && parts.length === 2) {
        return { kind: 'Repository', repoId: Number(parts[1]) };
      }
      if (parts[0] === 'Issue' && parts.length === 3) {
        return { kind: 'Issue', repoId: Number(parts[1]), number: Number(parts[2]) };
      }
      if (parts[0] === 'PullRequest' && parts.length === 3) {
        return { kind: 'PullRequest', repoId: Number(parts[1]), number: Number(parts[2]) };
      }
      if (parts[0] === 'IssueComment' && parts.length === 4) {
        return { kind: 'IssueComment', repoId: Number(parts[1]), number: Number(parts[2]), commentId: Number(parts[3]) };
      }
      return null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------- JSON shapes (REST + MCP)

  repoJson(repo: Repo): Record<string, unknown> {
    return {
      id: repo.id,
      node_id: this.repoGlobalId(repo),
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
      owner: { login: repo.owner, id: 1000 },
      created_at: FIXED_NOW_ISO,
      updated_at: FIXED_NOW_ISO,
      has_issues: true,
      has_projects: true,
      has_wiki: true,
    };
  }

  issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
    return {
      id: issue.id,
      node_id: this.issueGlobalId(repo, issue),
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
      user: { login: this.viewer.login, id: 1000 },
      created_at: FIXED_NOW_ISO,
      updated_at: FIXED_NOW_ISO,
      closed_at: issue.closedAt,
    };
  }

  pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
    return {
      id: pull.id,
      node_id: this.pullGlobalId(repo, pull),
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      merged: pull.merged,
      merged_at: pull.mergedAt,
      merge_commit_sha: pull.mergeCommitSha,
      head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
      base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
      user: { login: this.viewer.login, id: 1000 },
      created_at: FIXED_NOW_ISO,
      updated_at: FIXED_NOW_ISO,
    };
  }
}

export { isErr };
