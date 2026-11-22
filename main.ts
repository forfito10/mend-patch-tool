// main.ts is mend, the CLI SPEC.md specifies (MIT). It does all ten sections of SPEC.md: the command line, the
// output and exit codes, files/lines/paths, format detection, line matching at three tiers, unified diffs,
// SEARCH/REPLACE blocks, V4A patches, JSON edits, and the all-or-nothing write.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function checkSafe(p: string): void {
  if (!safe(p)) throw new Fail('unsafe', p);
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- Section 3: files, lines and paths ---------------------------------------------------------------

/** A file's text as lines, its line break and whether it ends with that break. */
interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  let lines = text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

// ---- Section 5: matching lines ----------------------------------------------------------------------

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadOf = (s: string): string => /^[ \t]*/.exec(s)![0];

function lineEq(f: string, p: string, tier: number): boolean {
  if (f === p) return true;
  if (tier === 0) return false;
  if (tier === 1) return stripTrail(f) === stripTrail(p);
  return stripBoth(f) === stripBoth(p);
}

/** One piece of a chunk: a line of the old side and/or the new side; `ctx` marks a context line. */
interface Seg {
  text: string;
  ctx: boolean;
}

interface Occ {
  pos: number;
  tier: number;
}

/**
 * The occurrences of O in `lines` at the first tier that has one, at or after `from` (and, with `atEnd`, only
 * those that end at the last line). Empty O is the caller's business.
 */
function occurrences(lines: string[], O: string[], strict: boolean, from = 0, atEnd = false): Occ[] {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const occ: Occ[] = [];
    for (let i = from; i + O.length <= lines.length; i++) {
      if (atEnd && i + O.length !== lines.length) continue;
      let ok = true;
      for (let j = 0; j < O.length; j++) {
        if (!lineEq(lines[i + j]!, O[j]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) occ.push({ pos: i, tier });
    }
    if (occ.length > 0) return occ;
  }
  return [];
}

/** N written at an occurrence: context lines are the file's own, others re-indented at tier 2 (section 5). */
function writeAt(lines: string[], occ: Occ, O: Seg[], N: Seg[]): string[] {
  // The context lines of N are the context lines of O, in order, each at its own position in O.
  const ctxPos: number[] = [];
  O.forEach((seg, k) => {
    if (seg.ctx) ctxPos.push(k);
  });
  const out = lines.slice(0, occ.pos);
  let ctxAt = 0;
  const F = leadOf(lines[occ.pos] ?? '');
  const P = leadOf(O[0]?.text ?? '');
  for (const seg of N) {
    if (seg.ctx) {
      out.push(lines[occ.pos + ctxPos[ctxAt]!]!);
      ctxAt += 1;
      continue;
    }
    if (occ.tier === 2 && seg.text.trim() !== '' && seg.text.startsWith(P)) out.push(F + seg.text.slice(P.length));
    else out.push(seg.text);
  }
  out.push(...lines.slice(occ.pos + O.length));
  return out;
}

/** Inserts N's lines at `pos`, as they are. */
function insertAt(lines: string[], pos: number, N: Seg[]): string[] {
  const out = lines.slice(0, pos);
  for (const seg of N) out.push(seg.text);
  out.push(...lines.slice(pos));
  return out;
}

// ---- Section 6: unified diffs -----------------------------------------------------------------------

interface HunkU {
  a: number;
  O: Seg[];
  N: Seg[];
  /** A `\` line follows the hunk's last context or `+` line. */
  tailSlash: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  plusSlash: boolean;
}

interface SectionU {
  oldNamed: boolean;
  oldVal: string | null;
  newNamed: boolean;
  newVal: string | null;
  /** The pair of `diff --git` paths (a/ and b/ removed), when the section starts at one. */
  diffPair: boolean;
  diffOld: string;
  diffNew: string;
  renameOld: string | null;
  renameNew: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: HunkU[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function pathOf(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return '/dev/null';
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function hunkBody(lines: string[], from: number): { body: string[]; next: number } {
  const body: string[] = [];
  let i = from;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      i += 1;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return { body, next: i };
}

function makeHunk(a: number, body: string[]): HunkU {
  const O: Seg[] = [];
  const N: Seg[] = [];
  let lastCP = -1;
  let lastPlus = -1;
  const ctxAfter: number[] = [];
  body.forEach((l, k) => {
    if (l === '') {
      O.push({ text: '', ctx: true });
      N.push({ text: '', ctx: true });
      lastCP = k;
    } else if (l[0] === ' ') {
      O.push({ text: l.slice(1), ctx: true });
      N.push({ text: l.slice(1), ctx: true });
      lastCP = k;
    } else if (l[0] === '-') {
      O.push({ text: l.slice(1), ctx: false });
    } else if (l[0] === '+') {
      N.push({ text: l.slice(1), ctx: false });
      lastCP = k;
      lastPlus = k;
    }
  });
  void ctxAfter;
  return {
    a,
    O,
    N,
    tailSlash: lastCP >= 0 && (body[lastCP + 1] ?? '').startsWith('\\'),
    plusSlash: lastPlus >= 0 && (body[lastPlus + 1] ?? '').startsWith('\\'),
  };
}

function applyHunksU(text: string, hunks: HunkU[], strict: boolean, failPath: string): string {
  const f = splitFile(text);
  let lines = f.lines;
  let final = f.final;
  let d = 0;
  for (const h of hunks) {
    const O = h.O.map((s) => s.text);
    if (O.length === 0) {
      const pos = Math.min(h.a + d, lines.length);
      const atEnd = pos === lines.length;
      lines = insertAt(lines, pos, h.N);
      if (atEnd) final = !h.tailSlash;
      d += h.N.length;
      continue;
    }
    const occs = occurrences(lines, O, strict);
    if (occs.length === 0) throw new Fail('no-match', failPath);
    const target = h.a - 1 + d;
    let best = occs[0]!;
    for (const o of occs) if (Math.abs(o.pos - target) < Math.abs(best.pos - target)) best = o;
    const atEnd = best.pos + O.length === lines.length;
    lines = writeAt(lines, best, h.O, h.N);
    if (atEnd) final = !h.tailSlash;
    d += h.N.length - h.O.length;
  }
  return joinFile(lines, f.br, final);
}

function sectionEditU(s: SectionU): Edit {
  const isCreate = s.newFile || (s.oldNamed && s.oldVal === null);
  const isDelete = s.delFile || (s.newNamed && s.newVal === null);
  const oldPath = s.oldNamed ? s.oldVal : s.renameOld ?? (s.diffPair ? s.diffOld : null);
  const newPath = s.newNamed ? s.newVal : s.renameNew ?? (s.diffPair ? s.diffNew : null);
  if (isCreate) {
    const p = newPath ?? oldPath ?? '';
    return (tree) => {
      checkSafe(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of s.hunks) for (const seg of h.N) if (!seg.ctx) plus.push(seg.text);
      const slash = s.hunks.length > 0 && s.hunks[s.hunks.length - 1]!.plusSlash;
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (slash ? '' : '\n'));
    };
  }
  if (isDelete) {
    const p = oldPath ?? newPath ?? '';
    return (tree) => {
      checkSafe(p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  if (oldPath !== null && newPath !== null && oldPath !== newPath) {
    return (tree) => {
      checkSafe(oldPath);
      checkSafe(newPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const after = applyHunksU(before, s.hunks, strictRef.v, oldPath);
      tree.now.set(newPath, after);
      tree.now.set(oldPath, null);
      tree.moves.push({ old: oldPath, new: newPath });
    };
  }
  const p = newPath ?? oldPath ?? '';
  return (tree) => {
    checkSafe(p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunksU(before, s.hunks, strictRef.v, p));
  };
}

/** `--strict` as the parsers see it (set once, before any edit is built). */
const strictRef = { v: false };

function emptySection(diffOld = '', diffNew = '', diffPair = false): SectionU {
  return {
    oldNamed: false,
    oldVal: null,
    newNamed: false,
    newVal: null,
    diffPair,
    diffOld,
    diffNew,
    renameOld: null,
    renameNew: null,
    newFile: false,
    delFile: false,
    hunks: [],
  };
}

function unifiedEdits(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let sec: SectionU | null = null;
  let i = 0;
  const close = (): void => {
    if (sec === null) return;
    edits.push(sectionEditU(sec));
    sec = null;
  };
  while (i < lines.length) {
    const l = lines[i]!;
    const next = lines[i + 1] ?? '';
    if (sec === null) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(l);
      if (m) {
        sec = emptySection(m[1]!, m[2]!, true);
        i += 1;
        continue;
      }
      if (l.startsWith('--- ') && next.startsWith('+++ ')) {
        sec = emptySection();
        sec.oldNamed = true;
        sec.oldVal = pathOf(l) === '/dev/null' ? null : pathOf(l);
        sec.newNamed = true;
        sec.newVal = pathOf(next) === '/dev/null' ? null : pathOf(next);
        i += 2;
        continue;
      }
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      if (l.startsWith('diff --git ')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    // Inside a section.
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      close();
      sec = emptySection(m[1]!, m[2]!, true);
      i += 1;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (!next.startsWith('+++ ')) {
        if (sec.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
        // Inside a hunk the body already ended; this starts a new section.
        close();
        sec = emptySection();
        sec.oldNamed = true;
        sec.oldVal = pathOf(l) === '/dev/null' ? null : pathOf(l);
        sec.newNamed = true;
        sec.newVal = pathOf(next) === '/dev/null' ? null : pathOf(next);
        i += 2;
        continue;
      }
      if (sec.hunks.length === 0) {
        // Part of this section's header: the pair names the section's old and new path.
        sec.oldNamed = true;
        sec.oldVal = pathOf(l) === '/dev/null' ? null : pathOf(l);
        sec.newNamed = true;
        sec.newVal = pathOf(next) === '/dev/null' ? null : pathOf(next);
        i += 2;
        continue;
      }
      close();
      sec = emptySection();
      sec.oldNamed = true;
      sec.oldVal = pathOf(l) === '/dev/null' ? null : pathOf(l);
      sec.newNamed = true;
      sec.newVal = pathOf(next) === '/dev/null' ? null : pathOf(next);
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = HUNK_HEAD.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const { body, next: n } = hunkBody(lines, i + 1);
      sec.hunks.push(makeHunk(Number(m[1]!), body));
      i = n;
      continue;
    }
    if (sec.hunks.length === 0) {
      if (l.startsWith('rename from ')) {
        if (!sec.oldNamed && !sec.newNamed) sec.renameOld = l.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        if (!sec.oldNamed && !sec.newNamed) sec.renameNew = l.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        sec.newFile = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        sec.delFile = true;
        i += 1;
        continue;
      }
    }
    i += 1;
  }
  close();
  return edits;
}

// ---- Section 7: SEARCH/REPLACE blocks ---------------------------------------------------------------

const SR_SEARCH = '<<<<<<< SEARCH';
const SR_SEP = '=======';
const SR_REPLACE = '>>>>>>> REPLACE';

function srEdits(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== SR_SEARCH) {
      i += 1;
      continue;
    }
    // The path: the nearest line above that is not blank and not a code fence.
    let path: string | null = null;
    for (let k = i - 1; k > prevEnd; k--) {
      const cand = lines[k]!.trim();
      if (cand === '' || cand.startsWith('```')) continue;
      path = cand;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${i + 1}`);
    // `=======` then `>>>>>>> REPLACE`.
    let sep = -1;
    let end = -1;
    for (let k = i + 1; k < lines.length; k++) {
      const t = lines[k]!.trimEnd();
      if (t === SR_SEP) {
        sep = k;
        break;
      }
      if (t === SR_REPLACE) break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${i + 1}`);
    for (let k = sep + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === SR_REPLACE) {
        end = k;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${i + 1}`);
    const oldLines = lines.slice(i + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    const p = path;
    if (oldLines.length === 0) {
      edits.push((tree) => {
        checkSafe(p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      });
    } else {
      const O: Seg[] = oldLines.map((t) => ({ text: t, ctx: false }));
      const N: Seg[] = newLines.map((t) => ({ text: t, ctx: false }));
      edits.push((tree) => {
        checkSafe(p);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        const f = splitFile(before);
        const occs = occurrences(f.lines, oldLines, strictRef.v);
        if (occs.length === 0) throw new Fail('no-match', p);
        if (occs.length > 1) throw new Fail('ambiguous', p);
        tree.now.set(p, joinFile(writeAt(f.lines, occs[0]!, O, N), f.br, f.final));
      });
    }
    prevPath = p;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

// ---- Section 8: V4A patches -------------------------------------------------------------------------

interface ChunkV {
  anchor: string | null;
  eof: boolean;
  O: Seg[];
  N: Seg[];
}

type SectionV =
  | { kind: 'add'; path: string; lines: string[]; line: number }
  | { kind: 'delete'; path: string; line: number }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: ChunkV[]; line: number };

const V_ADD = '*** Add File: ';
const V_DELETE = '*** Delete File: ';
const V_UPDATE = '*** Update File: ';
const V_MOVE = '*** Move to: ';
const V_EOF = '*** End of File';

function stripTrailingBlanks(ls: { l: string; n: number }[]): { l: string; n: number }[] {
  let end = ls.length;
  while (end > 0 && blank(ls[end - 1]!.l)) end -= 1;
  return ls.slice(0, end);
}

function updateSectionV(path: string, body: { l: string; n: number }[], line: number): SectionV {
  let idx = 0;
  let moveTo: string | null = null;
  if (body.length > 0 && body[0]!.l.startsWith(V_MOVE)) {
    moveTo = body[0]!.l.slice(V_MOVE.length).trim();
    idx = 1;
  }
  const chunks: ChunkV[] = [];
  while (idx < body.length) {
    const cur = body[idx]!;
    let anchor: string | null = null;
    let eof = false;
    if (cur.l.startsWith('@@')) {
      const a = cur.l.slice(2).trim();
      anchor = a === '' ? null : a;
      idx += 1;
    } else if (chunks.length === 0) {
      // The first chunk may start at a body line.
    } else {
      throw new Exit2(`error: parse ${cur.n}`);
    }
    const O: Seg[] = [];
    const N: Seg[] = [];
    let sawBody = idx <= body.length;
    sawBody = false;
    while (idx < body.length) {
      const bl = body[idx]!;
      const t = bl.l;
      if (t.startsWith('@@')) break;
      if (t.trim() === V_EOF) {
        eof = true;
        idx += 1;
        break;
      }
      if (t === '') {
        O.push({ text: '', ctx: true });
        N.push({ text: '', ctx: true });
        sawBody = true;
      } else if (t[0] === ' ') {
        O.push({ text: t.slice(1), ctx: true });
        N.push({ text: t.slice(1), ctx: true });
        sawBody = true;
      } else if (t[0] === '-') {
        O.push({ text: t.slice(1), ctx: false });
        sawBody = true;
      } else if (t[0] === '+') {
        N.push({ text: t.slice(1), ctx: false });
        sawBody = true;
      } else {
        throw new Exit2(`error: parse ${bl.n}`);
      }
      idx += 1;
    }
    void sawBody;
    chunks.push({ anchor, eof, O, N });
    if (eof && idx < body.length && !body[idx]!.l.startsWith('@@')) throw new Exit2(`error: parse ${body[idx]!.n}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${line}`);
  return { kind: 'update', path, moveTo, chunks, line };
}

function applyChunksV(text: string, chunks: ChunkV[], strict: boolean, failPath: string): string {
  const f = splitFile(text);
  let lines = f.lines;
  let cursor = 0;
  for (const c of chunks) {
    if (c.anchor !== null) {
      let found = -1;
      for (let tier = 0; tier <= (strict ? 0 : 2) && found < 0; tier++) {
        for (let p = cursor; p < lines.length; p++) {
          if (lineEq(lines[p]!, c.anchor, tier)) {
            found = p;
            break;
          }
        }
      }
      if (found < 0) throw new Fail('no-match', failPath);
      cursor = found + 1;
    }
    const O = c.O.map((s) => s.text);
    if (O.length === 0) {
      const pos = c.eof ? lines.length : Math.min(cursor, lines.length);
      lines = insertAt(lines, pos, c.N);
      cursor = pos + c.N.length;
      continue;
    }
    const occs = occurrences(lines, O, strict, cursor, c.eof);
    if (occs.length === 0) throw new Fail('no-match', failPath);
    const best = occs[0]!;
    lines = writeAt(lines, best, c.O, c.N);
    cursor = best.pos + c.N.length;
  }
  return joinFile(lines, f.br, f.final);
}

function sectionEditV(s: SectionV): Edit {
  if (s.kind === 'add') {
    const p = s.path;
    return (tree) => {
      checkSafe(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, s.lines.length === 0 ? '' : s.lines.join('\n') + '\n');
    };
  }
  if (s.kind === 'delete') {
    const p = s.path;
    return (tree) => {
      checkSafe(p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  const p = s.path;
  const moveTo = s.moveTo;
  if (moveTo !== null) {
    return (tree) => {
      checkSafe(p);
      checkSafe(moveTo);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      const after = applyChunksV(before, s.chunks, strictRef.v, p);
      tree.now.set(moveTo, after);
      tree.now.set(p, null);
      tree.moves.push({ old: p, new: moveTo });
    };
  }
  return (tree) => {
    checkSafe(p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyChunksV(before, s.chunks, strictRef.v, p));
  };
}

function v4aEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  if (last <= first) return [];
  const edits: Edit[] = [];
  let sec: { kind: 'add' | 'delete' | 'update'; path: string; line: number; body: { l: string; n: number }[] } | null = null;
  const close = (): void => {
    if (sec === null) return;
    const body = stripTrailingBlanks(sec.body);
    if (sec.kind === 'add') {
      const out: string[] = [];
      for (const b of body) {
        if (b.l === '') out.push('');
        else if (b.l[0] === '+') out.push(b.l.slice(1));
        else throw new Exit2(`error: parse ${b.n}`);
      }
      edits.push(sectionEditV({ kind: 'add', path: sec.path, lines: out, line: sec.line }));
    } else if (sec.kind === 'delete') {
      if (body.length > 0) throw new Exit2(`error: parse ${body[0]!.n}`);
      edits.push(sectionEditV({ kind: 'delete', path: sec.path, line: sec.line }));
    } else {
      edits.push(sectionEditV(updateSectionV(sec.path, body, sec.line)));
    }
    sec = null;
  };
  for (let i = first + 1; i < last; i++) {
    const l = lines[i]!;
    if (l.startsWith(V_ADD)) {
      close();
      sec = { kind: 'add', path: l.slice(V_ADD.length).trim(), line: i + 1, body: [] };
    } else if (l.startsWith(V_DELETE)) {
      close();
      sec = { kind: 'delete', path: l.slice(V_DELETE.length).trim(), line: i + 1, body: [] };
    } else if (l.startsWith(V_UPDATE)) {
      close();
      sec = { kind: 'update', path: l.slice(V_UPDATE.length).trim(), line: i + 1, body: [] };
    } else if (sec !== null) {
      sec.body.push({ l, n: i + 1 });
    } else if (blank(l)) {
      continue;
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  close();
  return edits;
}

// ---- Section 9: JSON edits --------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Sections 1, 2 and 10: the command line, the output, order and atomicity -------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  strictRef.v = strict;
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines) : kind === 'search-replace' ? srEdits(lines) : v4aEdits(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const moves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = moves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const moved = new Map<string, string>();
  const gone = new Set<string>();
  for (const m of tree.moves) {
    if (tree.original(m.old) === null || tree.now.get(m.old) !== null) continue;
    if (tree.original(m.new) !== null || tree.now.get(m.new) === null || tree.now.get(m.new) === undefined) continue;
    moved.set(m.new, m.old);
    gone.add(m.old);
  }
  const rows: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (gone.has(p)) {
      if (!check) rmSync(p, { force: true });
      continue;
    }
    const old = moved.get(p);
    rows.push(old !== undefined ? `R ${old} -> ${p}` : `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
