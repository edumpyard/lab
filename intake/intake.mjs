// Submission format of the lab: parsing, limits and packing. Node stdlib only.
//
//   node intake.mjs pack <folder> <out>   writes body.md (+ part-K.md) for a page folder
//   node intake.mjs event                 handles one issue event in the intake workflow

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_CHARS = 60000;
const MAX_PARTS = 10;
export const MAX_FILES = 200;
export const MAX_BYTES = 25 * 1024 * 1024;
// File types a page may hold. Others (svg, xml, wasm, pdf, archives, programs, no extension)
// are refused at review; pack refuses them up front.
export const TYPES = new Set('html htm css js mjs json txt png jpg jpeg gif webp avif ico woff woff2 ttf otf mp3 mp4 webm'.split(' '));
export const CODES = ['TOO_BIG', 'BAD_FORMAT', 'TOO_MANY_PARTS', 'NOT_AUTHOR', 'ONE_OPEN_ONLY', 'NO_TERMS'];
export const TERMS = 'I have the right to publish this. It is public. The lab may remove it at any time.';
export const RECEIVED = 'Received. Waiting for review.';
export const closedText = (code) => `Closed: ${code}. See SUBMIT.md for the rules.`;

// github-actions[bot] writes every intake reply; 10137 is the "ghost" account of deleted users.
export const ACTIONS_BOT_ID = 41898282;
const GHOST_ID = 10137;

const HEAD = 'lab-submission v1';
const PART_RE = /^lab-submission part (\d+)\/(\d+)$/;
const FENCE = '~~~~~~';
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
// A plain file name only: a URL parser would turn ".." or "\" in it into another path on github.com.
const ZIP_URL_RE = /https:\/\/github\.com\/user-attachments\/files\/\d+\/[A-Za-z0-9._-]+\.(?:zip|ZIP)(?![^\s)\]])/g;
const MANIFEST_KEYS = ['files', 'parts', 'sha256'];
const FILE_KEYS = ['encoding', 'part', 'path'];

class Rejected extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const reject = (code) => {
  throw new Rejected(code);
};

// Why a file path cannot be used, or null. Paths are "/" separated and relative.
export function pathProblem(path) {
  if (typeof path !== 'string' || path === '') return 'empty path';
  if (Buffer.byteLength(path) > 255) return 'path longer than 255 bytes';
  if (/[\p{Cc}\\:]/u.test(path)) return 'control character, backslash or colon in a path';
  if (path.split('/').some((s) => s === '' || s.startsWith('.'))) return 'empty segment or name starting with "." in a path';
  return null;
}

// Two paths that differ only in case or Unicode form, or a file that is also a folder, would
// collide on some file systems.
export function duplicateProblem(paths) {
  const seen = new Set();
  const folders = new Set();
  for (const path of paths) {
    const key = path.normalize('NFC').toLowerCase();
    if (seen.has(key)) return 'two files with the same name';
    seen.add(key);
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
  }
  for (const key of seen) if (folders.has(key)) return 'a file has the same name as a folder';
  return null;
}

const byBytes = ([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b));
export const sortedFiles = (files) => [...files].sort(byBytes);

// The checksum of a page: every file in byte order of its path, as path NUL size NUL bytes.
export function bundleSha(files) {
  const hash = createHash('sha256');
  for (const [path, data] of sortedFiles(files)) hash.update(`${path}\0${data.length}\0`).update(data);
  return hash.digest('hex');
}

export function parseTitle(title) {
  const text = String(title ?? '').trim();
  if (text === 'New page') return { kind: 'new', name: null };
  const m = /^(Update|Remove) (\S+)$/.exec(text);
  if (!m || !NAME_RE.test(m[2]) || m[2].includes('--')) return null;
  return { kind: m[1].toLowerCase(), name: m[2] };
}

const isPerson = (user) => Number.isSafeInteger(user?.id) && user.id > 0 && user.id !== GHOST_ID && user.type === 'User';
export const isReceived = (comment) => comment.user?.id === ACTIONS_BOT_ID && comment.body === RECEIVED;

const lines = (text) => text.split(/\r?\n/);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sameKeys = (object, keys) => isObject(object) && Object.keys(object).sort().join() === keys.join();

function decodeBase64(text) {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) reject('BAD_FORMAT');
  const data = Buffer.from(text, 'base64');
  if (data.toString('base64') !== text) reject('BAD_FORMAT');
  return data;
}

function readManifest(body) {
  const all = lines(body);
  let i = 1;
  while (all[i]?.trim() === '') i++;
  if (all[i] !== '```json') reject('BAD_FORMAT');
  const end = all.indexOf('```', i + 1);
  if (end < 0) reject('BAD_FORMAT');
  let manifest;
  try {
    manifest = JSON.parse(all.slice(i + 1, end).join('\n'));
  } catch {
    reject('BAD_FORMAT');
  }
  if (!sameKeys(manifest, MANIFEST_KEYS) || !Number.isSafeInteger(manifest.parts) || manifest.parts < 1) reject('BAD_FORMAT');
  if (manifest.parts > MAX_PARTS) reject('TOO_MANY_PARTS');
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) reject('BAD_FORMAT');
  if (manifest.files.length > MAX_FILES) reject('TOO_BIG');
  if (typeof manifest.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.sha256)) reject('BAD_FORMAT');
  for (const f of manifest.files) {
    const ok = sameKeys(f, FILE_KEYS) && pathProblem(f.path) === null && ['utf8', 'base64'].includes(f.encoding)
      && Number.isSafeInteger(f.part) && f.part >= 1 && f.part <= manifest.parts;
    if (!ok) reject('BAD_FORMAT');
  }
  if (duplicateProblem(manifest.files.map((f) => f.path))) reject('BAD_FORMAT');
  return { manifest, rest: all.slice(end + 1) };
}

// The blocks of one part: exactly the manifest files of that part, in manifest order.
// A utf8 block holds the file's text; the line end before the closing fence belongs to the
// fence. A base64 block is joined without line ends.
function readBlocks(rest, expected, files) {
  let i = 0;
  const skipBlank = () => {
    while (i < rest.length && rest[i].trim() === '') i++;
  };
  for (const f of expected) {
    skipBlank();
    if (rest[i] !== `${FENCE} ${f.path}`) reject('BAD_FORMAT');
    const end = rest.indexOf(FENCE, i + 1);
    if (end < 0) reject('BAD_FORMAT');
    const content = rest.slice(i + 1, end);
    files.set(f.path, f.encoding === 'utf8' ? Buffer.from(content.join('\n')) : decodeBase64(content.join('')));
    i = end + 1;
  }
  skipBlank();
  if (i < rest.length) reject('BAD_FORMAT');
}

function readText(issue, comments) {
  const { manifest, rest } = readManifest(issue.body);
  const parts = new Map([[1, rest]]);
  for (const c of comments) {
    if (c.user?.id !== issue.user.id) continue;
    const body = c.body ?? '';
    const m = PART_RE.exec(lines(body)[0]);
    if (!m) continue;
    if (body.length > MAX_CHARS) reject('TOO_BIG');
    // A part edited after posting could change content that someone already looked at.
    if (c.updated_at !== c.created_at) reject('BAD_FORMAT');
    const [k, n] = [Number(m[1]), Number(m[2])];
    if (n !== manifest.parts || k < 2 || k > n || parts.has(k)) reject(n > MAX_PARTS ? 'TOO_MANY_PARTS' : 'BAD_FORMAT');
    parts.set(k, lines(body).slice(1));
  }
  if (parts.size < manifest.parts) return null;
  const files = new Map();
  for (const [k, rest] of parts) readBlocks(rest, manifest.files.filter((f) => f.part === k), files);
  if ([...files.values()].reduce((sum, d) => sum + d.length, 0) > MAX_BYTES) reject('TOO_BIG');
  if (bundleSha(files) !== manifest.sha256) reject('BAD_FORMAT');
  return files;
}

function readForm(body) {
  const urls = [...new Set(body.match(ZIP_URL_RE) ?? [])];
  if (urls.length !== 1) reject('BAD_FORMAT');
  const terms = lines(body).some((l) => /^- \[[xX]\] /.test(l) && l.slice(6).trim() === TERMS);
  if (!terms) reject('NO_TERMS');
  return urls[0];
}

// Reads a submission from its issue and the issue's comments (GitHub API objects).
// Returns {state: 'waiting'} while parts are missing, {state: 'invalid', code}, or
// {state: 'complete', kind, name, author, files?: Map<path, Buffer>, zip?: url}.
// Only comments by the issue author count; every other comment is ignored.
export function evaluate(issue, comments) {
  try {
    if (!isPerson(issue.user)) reject('NOT_AUTHOR');
    const title = parseTitle(issue.title);
    if (!title) reject('BAD_FORMAT');
    const done = { state: 'complete', ...title, author: issue.user.id };
    if (title.kind === 'remove') return done;
    const body = issue.body ?? '';
    if (body.length > MAX_CHARS) reject('TOO_BIG');
    if (lines(body)[0] !== HEAD) return { ...done, zip: readForm(body) };
    const files = readText(issue, comments);
    return files ? { ...done, files } : { state: 'waiting' };
  } catch (err) {
    if (err instanceof Rejected) return { state: 'invalid', code: err.code };
    throw err;
  }
}

const isUtf8Text = (data) => {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
    return !text.includes('\r') && !lines(text).includes(FENCE);
  } catch {
    return false;
  }
};

function block(path, data) {
  if (isUtf8Text(data)) return { encoding: 'utf8', text: `${FENCE} ${path}\n${data.toString('utf8')}\n${FENCE}\n` };
  const b64 = data.toString('base64').match(/.{1,76}/g) ?? [];
  return { encoding: 'base64', text: `${FENCE} ${path}\n${b64.map((l) => `${l}\n`).join('')}${FENCE}\n` };
}

const firstHead = (manifest) => `${HEAD}\n\n\`\`\`json\n${manifest}\n\`\`\`\n\n`;
const partHead = (k, n) => `lab-submission part ${k}/${n}\n\n`;

// The issue body and comments for `files` (Map<path, Buffer>). Throws when it cannot fit.
// Each block is counted with one more character for the line end that joins it to the next.
export function pack(files) {
  const paths = sortedFiles(files).map(([p]) => p);
  const problem = paths.map(pathProblem).find(Boolean) ?? duplicateProblem(paths);
  if (problem) throw new Error(problem);
  if (paths.length === 0 || paths.length > MAX_FILES) throw new Error(`a page has 1 to ${MAX_FILES} files`);
  const refused = paths.find((p) => !TYPES.has(/\.([^./]+)$/.exec(p)?.[1].toLowerCase()));
  if (refused) throw new Error(`${refused}: file type not allowed (allowed: ${[...TYPES].join(' ')})`);
  const blocks = paths.map((p) => ({ path: p, ...block(p, files.get(p)) }));
  // Room for the manifest with every part number at its widest, so part 1 never overflows.
  const widest = JSON.stringify({ files: blocks.map((b) => ({ path: b.path, encoding: b.encoding, part: MAX_PARTS })), parts: MAX_PARTS, sha256: '0'.repeat(64) });
  const parts = [{ room: MAX_CHARS - firstHead(widest).length, blocks: [] }];
  for (const b of blocks) {
    let part = parts.at(-1);
    if (b.text.length + 1 > part.room) {
      part = { room: MAX_CHARS - partHead(MAX_PARTS, MAX_PARTS).length, blocks: [] };
      if (b.text.length + 1 > part.room) throw new Error(`${b.path} is too large to send as text; send the page as a zip with the issue form instead`);
      parts.push(part);
    }
    part.blocks.push(b);
    part.room -= b.text.length + 1;
  }
  if (parts.length > MAX_PARTS) throw new Error(`the page needs more than ${MAX_PARTS} parts as text; send it as a zip with the issue form instead`);
  const manifest = {
    files: parts.flatMap((p, i) => p.blocks.map((b) => ({ path: b.path, encoding: b.encoding, part: i + 1 }))),
    parts: parts.length,
    sha256: bundleSha(files),
  };
  return parts.map((p, i) => {
    const head = i === 0 ? firstHead(JSON.stringify(manifest)) : partHead(i + 1, parts.length);
    return `${head}${p.blocks.map((b) => b.text).join('\n')}`;
  });
}

function readFolder(dir) {
  const files = new Map();
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const path = relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/');
    if (path.split('/').some((s) => s.startsWith('.'))) continue;
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new Error(`${path}: only regular files and folders can be sent`);
    if (entry.isFile()) files.set(path, readFileSync(join(dir, path)));
  }
  return files;
}

function packCommand(dir, out) {
  const parts = pack(readFolder(resolve(dir)));
  mkdirSync(out, { recursive: true });
  const names = parts.map((_, i) => (i === 0 ? 'body.md' : `part-${i + 1}.md`));
  parts.forEach((text, i) => writeFileSync(join(out, names[i]), text));
  const lines = [`Wrote ${names.map((n) => join(out, n)).join(', ')}`, '', 'Open the issue (use "Update <name>" as the title to replace your page):', `gh issue create --repo edumpyard/lab --title "New page" --body-file ${join(out, 'body.md')}`];
  if (parts.length > 1) {
    lines.push('', 'Then add each part as a comment on that issue, in order, a few seconds apart:');
    for (const n of names.slice(1)) lines.push(`gh issue comment <issue number> --repo edumpyard/lab --body-file ${join(out, n)}`);
  }
  console.log(lines.join('\n'));
}

// The intake workflow: the event text is read here, never in a shell step.
async function eventCommand(env) {
  const repo = env.GITHUB_REPOSITORY;
  const api = async (method, path, body) => {
    const res = await fetch(`${env.GITHUB_API_URL || 'https://api.github.com'}/repos/${repo}${path}`, {
      method,
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${env.GH_TOKEN}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'lab-intake' },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`GitHub API ${method} ${path.split('?')[0]} failed with ${res.status}`);
    return res.status === 204 ? null : res.json();
  };
  const all = async (path) => {
    const out = [];
    for (let page = 1; ; page++) {
      const items = await api('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      out.push(...items);
      if (items.length < 100) return out;
    }
  };

  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const number = event.issue.number;
  if (event.issue.pull_request || event.issue.state !== 'open') return 'not an open issue';
  if (event.comment && event.comment.user?.id !== event.issue.user?.id) return 'comment by someone else';
  const issue = await api('GET', `/issues/${number}`);
  const comments = await all(`/issues/${number}/comments`);
  if (issue.state !== 'open' || comments.some((c) => c.user?.id === ACTIONS_BOT_ID)) return 'already answered';

  const close = async (code) => {
    await api('POST', `/issues/${number}/comments`, { body: closedText(code) });
    await api('PATCH', `/issues/${number}`, { state: 'closed', state_reason: 'not_planned' });
    return `closed: ${code}`;
  };
  if (!isPerson(issue.user)) return close('NOT_AUTHOR');
  const open = await all(`/issues?state=open&creator=${encodeURIComponent(issue.user.login)}`);
  if (open.some((i) => !i.pull_request && i.user?.id === issue.user.id && i.number < number)) return close('ONE_OPEN_ONLY');
  const result = evaluate(issue, comments);
  if (result.state === 'waiting') return 'waiting for parts';
  if (result.state === 'invalid') return close(result.code);
  await api('POST', `/issues/${number}/comments`, { body: RECEIVED });
  await api('PUT', `/issues/${number}/lock`, {});
  return 'received';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === 'pack' && args.length === 2) packCommand(...args);
    else if (command === 'event' && args.length === 0) console.log(await eventCommand(process.env));
    else {
      console.error('usage: node intake.mjs pack <folder> <out> | node intake.mjs event');
      process.exitCode = 2;
    }
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  }
}
