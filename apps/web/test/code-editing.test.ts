/**
 * The code editor's editing logic (components/editor/code-editing.ts): bracket matching that ignores strings and
 * comments, auto-closing of brackets and quotes (wrapping, stepping over, no pairs in strings or after a word),
 * Backspace over an empty pair, search with case, whole-word and regular-expression options, replacement with `$1`,
 * moving between matches, and the decorations drawn over the tokens.
 */
import { describe, expect, it } from 'vitest';
import { highlightCode, type CodeLanguage } from '@/components/editor/code-highlight';
import { autoCloseEdit, backspaceEdit, decorate, matchBracket, replaceAllMatches, searchMatches, stepMatch, expandReplacement } from '@/components/editor/code-editing';

const tokens = (text: string, language: CodeLanguage = 'javascript') => highlightCode(text, language);
const bracket = (text: string, caret: number, language: CodeLanguage = 'javascript') => matchBracket(text, caret, tokens(text, language));
const close = (text: string, key: string, at = text.length, end = at, language: CodeLanguage = 'javascript') => autoCloseEdit(text, at, end, key, language, tokens(text, language));
/** Apply an edit to see what typing would produce. */
const typed = (text: string, edit: ReturnType<typeof close>) => (edit ? text.slice(0, edit.from) + edit.insert + text.slice(edit.to) : undefined);

describe('matchBracket', () => {
  it('pairs the bracket before the caret, or after it, in both directions', () => {
    const text = 'f(a, [1, 2], { b })';
    expect(bracket(text, 2)).toEqual({ at: 1, partner: 18 });
    expect(bracket(text, 1)).toEqual({ at: 1, partner: 18 });
    expect(bracket(text, 19)).toEqual({ at: 18, partner: 1 });
    expect(bracket(text, 6)).toEqual({ at: 5, partner: 10 });
    expect(bracket(text, 5)).toEqual({ at: 5, partner: 10 });
    expect(bracket(text, 14)).toEqual({ at: 13, partner: 17 });
    expect(bracket(text, 0)).toBeUndefined();
    expect(bracket(text, 8)).toBeUndefined();
  });

  it('skips brackets in strings and comments', () => {
    const text = "f(')', /* ) */ x) // )";
    expect(bracket(text, 2)).toEqual({ at: 1, partner: 16 });
    expect(bracket(text, 17)).toEqual({ at: 16, partner: 1 });
    // A bracket inside a string has no partner of its own.
    expect(bracket(text, 4)).toBeUndefined();
    expect(bracket('# ( not code\nx = (1)', 18, 'python')).toEqual({ at: 17, partner: 19 });
  });

  it('reports a bracket with no partner', () => {
    expect(bracket('f(a', 2)).toEqual({ at: 1 });
    expect(bracket('a)', 2)).toEqual({ at: 1 });
  });

  it('counts only the kind of bracket it started on', () => {
    expect(bracket('( [ )', 1)).toEqual({ at: 0, partner: 4 });
  });
});

describe('autoCloseEdit', () => {
  it('closes an opening bracket before whitespace, a closer or the end, and not before a word', () => {
    expect(typed('f', close('f', '('))).toBe('f()');
    expect(close('f', '(')?.select).toEqual([2, 2]);
    expect(typed('[1, ]', close('[1, ]', '{', 4))).toBe('[1, {}]');
    expect(close('foo bar', '(', 4)).toBeUndefined();
    expect(close('foo', '(', 0)).toBeUndefined();
  });

  it('wraps a selection', () => {
    const edit = close('say hello now', '(', 4, 9);
    expect(typed('say hello now', edit)).toBe('say (hello) now');
    expect(edit?.select).toEqual([5, 10]);
    expect(typed('a b', close('a b', '"', 2, 3))).toBe('a "b"');
    expect(close('a b', ')', 2, 3)).toBeUndefined();
  });

  it('steps over a closing character that is already there', () => {
    expect(close('f()', ')', 2)).toEqual({ from: 2, to: 2, insert: '', select: [3, 3] });
    expect(close('"a"', '"', 2)).toEqual({ from: 2, to: 2, insert: '', select: [3, 3] });
    expect(close('f(a)', ')', 2)).toBeUndefined();
  });

  it('pairs quotes, but not after a word, before one, or inside strings and comments', () => {
    expect(typed('x = ', close('x = ', '"'))).toBe('x = ""');
    expect(typed('f()', close('f()', "'", 2))).toBe("f('')");
    expect(close("don", "'")).toBeUndefined();
    expect(close('a', '"', 0)).toBeUndefined();
    expect(close('"abc ', '(', 5)).toBeUndefined();
    expect(close('// it', '"')).toBeUndefined();
    expect(close('# it', '(', 4, 4, 'python')).toBeUndefined();
    // Triple quotes in Python: the third quote doesn't make a pair.
    expect(close('""', '"', 2, 2, 'python')).toBeUndefined();
  });

  it('follows the language: backticks only in JavaScript, double quotes only in JSON, nothing in plain text', () => {
    expect(typed('x = ', close('x = ', '`'))).toBe('x = ``');
    expect(close('x = ', '`', 4, 4, 'python')).toBeUndefined();
    expect(close('{"a": ', "'", 6, 6, 'json')).toBeUndefined();
    expect(typed('{"a": ', close('{"a": ', '"', 6, 6, 'json'))).toBe('{"a": ""');
    expect(close('x = ', '(', 4, 4, 'plain')).toBeUndefined();
    expect(close('x', 'a')).toBeUndefined();
  });
});

describe('backspaceEdit', () => {
  it('takes an empty pair whole and nothing else', () => {
    expect(backspaceEdit('f()', 2, 2, 'javascript')).toEqual({ from: 1, to: 3, insert: '', select: [1, 1] });
    expect(backspaceEdit('x = ""', 5, 5, 'python')).toEqual({ from: 4, to: 6, insert: '', select: [4, 4] });
    expect(backspaceEdit('f(a)', 3, 3, 'javascript')).toBeUndefined();
    expect(backspaceEdit('f()', 2, 3, 'javascript')).toBeUndefined();
    expect(backspaceEdit('()', 0, 0, 'javascript')).toBeUndefined();
    expect(backspaceEdit('(]', 1, 1, 'javascript')).toBeUndefined();
  });
});

describe('search', () => {
  const text = 'const Name = name + NAME;\nreturn nameless;';

  it('finds every match, ignoring case by default', () => {
    expect(searchMatches(text, 'name').matches.map((m) => [m.from, m.to])).toEqual([[6, 10], [13, 17], [20, 24], [33, 37]]);
    expect(searchMatches(text, 'name', { caseSensitive: true }).matches.map((m) => m.from)).toEqual([13, 33]);
    expect(searchMatches(text, 'name', { wholeWord: true }).matches.map((m) => m.from)).toEqual([6, 13, 20]);
    expect(searchMatches(text, '').matches).toEqual([]);
  });

  it('treats the query as text unless regular expressions are on', () => {
    expect(searchMatches('a.b axb', 'a.b').matches).toHaveLength(1);
    expect(searchMatches('a.b axb', 'a.b', { regex: true }).matches).toHaveLength(2);
    expect(searchMatches('f(x) f(y)', 'f(').matches).toHaveLength(2);
    expect(searchMatches('a\nb\nc', '^[a-c]$', { regex: true }).matches).toHaveLength(3);
  });

  it('reports an invalid regular expression and skips empty matches', () => {
    expect(searchMatches('abc', '(', { regex: true })).toMatchObject({ matches: [], error: expect.any(String) });
    expect(searchMatches('abc', 'x*', { regex: true }).matches).toEqual([]);
  });

  it('stops at a cap', () => {
    const result = searchMatches('a'.repeat(6000), 'a');
    expect(result.matches).toHaveLength(5000);
    expect(result.truncated).toBe(true);
  });

  it('replaces with $1, $& and $<name> in regular-expression mode only', () => {
    const options = { regex: true };
    const { matches } = searchMatches('k1=v1;k2=v2', '(\\w+)=(?<value>\\w+)', options);
    expect(replaceAllMatches('k1=v1;k2=v2', matches, '$2:$1 [$&] $<value> $$ $9', options)).toBe('v1:k1 [k1=v1] v1 $ $9;v2:k2 [k2=v2] v2 $ $9');
    const plain = searchMatches('a.b a.b', 'a.b').matches;
    expect(replaceAllMatches('a.b a.b', plain, '$1', {})).toBe('$1 $1');
    expect(expandReplacement(plain[0], 'x', {})).toBe('x');
    expect(replaceAllMatches('abc', [], 'x')).toBe('abc');
  });

  it('moves between matches from the caret and wraps', () => {
    const { matches } = searchMatches('aa bb aa bb aa', 'aa');
    expect(stepMatch(matches, 0, 1)).toBe(0);
    expect(stepMatch(matches, 1, 1)).toBe(1);
    expect(stepMatch(matches, 12, 1)).toBe(2);
    expect(stepMatch(matches, 13, 1)).toBe(0);
    expect(stepMatch(matches, 0, -1, 0)).toBe(2);
    expect(stepMatch(matches, 9, -1, 6)).toBe(0);
    expect(stepMatch([], 0, 1)).toBe(-1);
  });
});

describe('decorate', () => {
  const text = "const a = f('x');";
  const joined = (pieces: ReturnType<typeof decorate>) => pieces.map((p) => p.text).join('');

  it('leaves the tokens alone without marks', () => {
    const base = tokens(text);
    expect(decorate(base, [])).toEqual(base.map((t) => ({ ...t, marks: [] })));
  });

  it('cuts tokens at the marks, keeps their kinds and the text', () => {
    const pieces = decorate(tokens(text), [
      { from: 6, to: 7, kind: 'match' },
      { from: 11, to: 12, kind: 'bracket' },
      { from: 15, to: 16, kind: 'bracket' },
      { from: 12, to: 15, kind: 'current' },
    ]);
    expect(joined(pieces)).toBe(text);
    expect(pieces.filter((p) => p.marks.length).map((p) => [p.text, p.marks])).toEqual([
      ['a', ['match']],
      ['(', ['bracket']],
      ["'x'", ['current']],
      [')', ['bracket']],
    ]);
    // The string token is one piece of kind string, even with the mark on it.
    expect(pieces.find((p) => p.text === "'x'")?.kind).toBe('string');
  });

  it('splits one token across a mark that starts and ends inside it, and handles overlapping marks', () => {
    const pieces = decorate(tokens("'hello world'"), [
      { from: 2, to: 8, kind: 'match' },
      { from: 5, to: 10, kind: 'current' },
    ]);
    expect(pieces.map((p) => [p.text, p.marks])).toEqual([
      ["'h", []],
      ['ell', ['match']],
      ['o w', ['match', 'current']],
      ['or', ['current']],
      ["ld'", []],
    ]);
  });
});
