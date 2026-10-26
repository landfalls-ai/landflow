/**
 * The code editor's highlighter and completions (components/editor/code-highlight.ts, code-editor.tsx): the tokens
 * always join back to the text (so the coloured layer lines up with the field), JavaScript, Python and JSON get the
 * right kinds (template `${ }` parts, regular expressions vs division, triple quotes, decorators, `{{ expressions }}`
 * in JSON), the caret inside a string or comment stops completions, and `$json.` / Python's `_json.` offer the input's
 * fields. The language comes from the parameter's typeOptions.
 */
import { describe, expect, it } from 'vitest';
import { codeEditorCompletions, highlightCode, inStringOrComment, languageOf, tokenAt, type CodeLanguage, type Token, type TokenKind } from '@/components/editor/code-highlight';
import { codeCompletionsAt, type CompletionData } from '@/components/editor/expression-completions';

const kinds = (tokens: Token[], kind: TokenKind) => tokens.filter((t) => t.kind === kind).map((t) => t.text);
const kindOf = (tokens: Token[], text: string) => tokens.find((t) => t.text === text)?.kind;
const joined = (tokens: Token[]) => tokens.map((t) => t.text).join('');

const data: CompletionData = {
  json: { name: 'Ada', email: 'ada@example.com', address: { city: 'London' } },
  nodes: [{ name: 'Fetch orders', json: { total: 3 } }],
  vars: ['region'],
};

describe('languageOf', () => {
  it('takes the language from typeOptions, JSON from the type, JavaScript by default', () => {
    expect(languageOf('javascript')).toBe('javascript');
    expect(languageOf('TypeScript')).toBe('javascript');
    expect(languageOf('python')).toBe('python');
    expect(languageOf('py')).toBe('python');
    expect(languageOf(undefined, 'json')).toBe('json');
    expect(languageOf('json', 'code')).toBe('json');
    expect(languageOf(undefined, 'code')).toBe('javascript');
    expect(languageOf('sql')).toBe('plain');
  });
});

describe('the tokens join back to the text', () => {
  const samples: Array<[CodeLanguage, string]> = [
    ['javascript', "const total = $input.all().reduce((sum, item) => sum + item.json.price, 0);\nreturn [{ json: { total } }];\n"],
    ['javascript', 'const s = `Hello ${$json.name}, ${`nested ${1 + 2}`}!`; // done\n/* block\ncomment */ let r = /a\\/b[/]+/gi;'],
    ['javascript', 'const half = total / 2 / count; const ok = (a) / 3;\n'],
    ['javascript', "'unterminated string\nnext line"],
    ['javascript', 'const t = `unterminated ${template'],
    ['python', 'from datetime import datetime\n@decorator.x\ndef run(items):\n    """Doc\n    string"""\n    return [{"json": {"n": len(items), "f": f"{_json[\'a\']}"}}]  # comment\n'],
    ['python', "r'\\d+' b\"bytes\" rb'''raw\nbytes''' 0x1F 1_000 3.5e-2 2j"],
    ['json', '{\n  "name": "{{ $json.name }}",\n  "count": 3,\n  "ok": true,\n  "nested": { "list": [1, null, -2.5e3] }\n}'],
    ['json', '{ "broken": "no end'],
    ['plain', 'SELECT * FROM t'],
  ];
  it.each(samples)('%s', (language, text) => {
    expect(joined(highlightCode(text, language))).toBe(text);
  });
  it('empty text has no tokens', () => {
    expect(highlightCode('', 'javascript')).toEqual([]);
  });
});

describe('JavaScript', () => {
  it('colours keywords, literals, numbers, strings, comments, workflow globals and calls', () => {
    const tokens = highlightCode("const x = $json.price * 2; // twice\nif (x > 10) return null;\nconsole.log('big', items.length);", 'javascript');
    expect(kinds(tokens, 'keyword')).toEqual(expect.arrayContaining(['const', 'if', 'return']));
    expect(kindOf(tokens, 'null')).toBe('literal');
    expect(kinds(tokens, 'number')).toEqual(['2', '10']);
    expect(kindOf(tokens, "'big'")).toBe('string');
    expect(kindOf(tokens, '// twice')).toBe('comment');
    expect(kinds(tokens, 'variable')).toEqual(expect.arrayContaining(['$json', 'console', 'items']));
    expect(kindOf(tokens, 'log')).toBe('function');
  });

  it('a template literal is a string with its ${ } parts as code', () => {
    const tokens = highlightCode('`Hi ${$json.name}!`', 'javascript');
    expect(kindOf(tokens, '$json')).toBe('variable');
    expect(kinds(tokens, 'string').join('')).toContain('`Hi ');
    expect(kinds(tokens, 'string').join('')).toContain('!`');
  });

  it('tells a regular expression from a division', () => {
    const regex = highlightCode('const r = /ab+c/gi.test(s);', 'javascript');
    expect(kindOf(regex, '/ab+c/gi')).toBe('string');
    const division = highlightCode('const half = total / 2 / count;', 'javascript');
    expect(kinds(division, 'string')).toEqual([]);
    expect(kinds(division, 'number')).toEqual(['2']);
    const afterReturn = highlightCode('return /x/.test(a)', 'javascript');
    expect(kindOf(afterReturn, '/x/')).toBe('string');
  });

  it('a block comment spans lines', () => {
    const tokens = highlightCode('/* one\ntwo */ const a = 1;', 'javascript');
    expect(kindOf(tokens, '/* one\ntwo */')).toBe('comment');
  });
});

describe('Python', () => {
  it('colours keywords, literals, strings with prefixes, triple quotes, decorators, comments and the _ globals', () => {
    const tokens = highlightCode("@staticmethod\ndef f(x):\n    '''doc'''\n    if x is None: return True  # hi\n    return f\"{_json['a']}\" + r'\\d'\n", 'python');
    expect(kinds(tokens, 'keyword')).toEqual(expect.arrayContaining(['def', 'if', 'is', 'return']));
    expect(kindOf(tokens, 'None')).toBe('literal');
    expect(kindOf(tokens, 'True')).toBe('literal');
    expect(kindOf(tokens, "'''doc'''")).toBe('string');
    expect(kindOf(tokens, "r'\\d'")).toBe('string');
    expect(kindOf(tokens, '# hi')).toBe('comment');
    expect(kindOf(tokens, '@staticmethod')).toBe('function');
  });

  it('a # inside a string is not a comment', () => {
    const tokens = highlightCode("x = 'a # b'", 'python');
    expect(kinds(tokens, 'comment')).toEqual([]);
    expect(kindOf(tokens, "'a # b'")).toBe('string');
  });

  it('marks the workflow names', () => {
    const tokens = highlightCode('for item in _input.all():\n    item.json.x = _json.y', 'python');
    expect(kinds(tokens, 'variable')).toEqual(expect.arrayContaining(['_input', '_json']));
  });
});

describe('JSON', () => {
  it('keys, strings, numbers, literals and {{ expressions }}', () => {
    const tokens = highlightCode('{ "name": "{{ $json.name }}", "n": -2.5, "ok": false, "none": null }', 'json');
    expect(kinds(tokens, 'property')).toEqual(['"name"', '"n"', '"ok"', '"none"']);
    expect(kinds(tokens, 'number')).toEqual(['-2.5']);
    expect(kinds(tokens, 'literal')).toEqual(['false', 'null']);
    expect(kinds(tokens, 'brace')).toEqual(['{{', '}}']);
    expect(kinds(tokens, 'expression').join('')).toContain('$json.name');
  });
});

describe('where the caret is', () => {
  const tokens = highlightCode("const a = 'text'; // note\nconst b = $json.", 'javascript');
  const text = tokens.map((t) => t.text).join('');
  it('tokenAt finds the token ending at or around the caret', () => {
    expect(tokenAt(tokens, text.indexOf('text'))?.token.text).toBe("'text'");
    expect(tokenAt(tokens, 0)).toBeUndefined();
  });
  it('inside a string or comment, but not right after a closed string', () => {
    expect(inStringOrComment(tokens, text.indexOf('text') + 2)).toBe(true);
    expect(inStringOrComment(tokens, text.indexOf("';") + 1)).toBe(false);
    expect(inStringOrComment(tokens, text.indexOf('note') + 2)).toBe(true);
    expect(inStringOrComment(tokens, text.length)).toBe(false);
  });
  it('an unclosed string is still a string at its end', () => {
    const open = highlightCode("const a = 'tex", 'javascript');
    expect(inStringOrComment(open, 'const a = \'tex'.length)).toBe(true);
  });
});

describe('completions in code', () => {
  const labels = (result: ReturnType<typeof codeCompletionsAt>) => result?.items.map((i) => i.label) ?? [];

  it('codeCompletionsAt: $json. on the current line offers the input fields', () => {
    const text = 'const a = 1;\nconst name = $json.';
    expect(labels(codeCompletionsAt(text, text.length, data))).toEqual(expect.arrayContaining(['name', 'email', 'address']));
  });

  it('codeCompletionsAt: a nested field', () => {
    const text = 'return $json.address.';
    expect(labels(codeCompletionsAt(text, text.length, data))).toContain('city');
  });

  it('codeCompletionsAt: only $ names, not every identifier', () => {
    const text = 'const total = items.';
    expect(codeCompletionsAt(text, text.length, data)).toBeUndefined();
    const plain = 'const tot';
    expect(codeCompletionsAt(plain, plain.length, data)).toBeUndefined();
  });

  it('codeCompletionsAt: $ starts the root names', () => {
    const text = 'const x = $js';
    const result = codeCompletionsAt(text, text.length, data);
    expect(labels(result)).toContain('$json');
    expect(result?.from).toBe(text.indexOf('$js'));
  });

  it('codeEditorCompletions: JavaScript, nothing inside strings or comments', () => {
    const text = "const a = '$json.";
    expect(codeEditorCompletions(text, text.length, 'javascript', data, highlightCode(text, 'javascript'))).toBeUndefined();
    const comment = '// $json.';
    expect(codeEditorCompletions(comment, comment.length, 'javascript', data, highlightCode(comment, 'javascript'))).toBeUndefined();
    const code = 'const a = $json.';
    expect(labels(codeEditorCompletions(code, code.length, 'javascript', data, highlightCode(code, 'javascript')))).toContain('email');
  });

  it('codeEditorCompletions: Python reads _json. as $json. and answers in _ names', () => {
    const text = 'x = 1\nname = _json.';
    const result = codeEditorCompletions(text, text.length, 'python', data, highlightCode(text, 'python'));
    expect(labels(result)).toEqual(expect.arrayContaining(['name', 'email']));
    expect(result?.from).toBe(text.length);
    expect(result?.to).toBe(text.length);
    const root = 'y = _js';
    const roots = codeEditorCompletions(root, root.length, 'python', data, highlightCode(root, 'python'));
    expect(labels(roots)).toContain('_json');
    expect(labels(roots).some((l) => l.startsWith('$'))).toBe(false);
    expect(roots?.from).toBe(root.indexOf('_js'));
  });

  it('codeEditorCompletions: Python leaves out JavaScript-only methods', () => {
    const text = 'n = _json.name.';
    const result = codeEditorCompletions(text, text.length, 'python', data, highlightCode(text, 'python'));
    expect(labels(result)).not.toContain('length');
    expect(labels(result).filter((l) => l.endsWith(')'))).toEqual([]);
  });

  it('codeEditorCompletions: JSON and plain text have none', () => {
    const text = '{ "a": "$json.';
    expect(codeEditorCompletions(text, text.length, 'json', data, highlightCode(text, 'json'))).toBeUndefined();
    expect(codeEditorCompletions('$json.', 6, 'plain', data, highlightCode('$json.', 'plain'))).toBeUndefined();
  });
});
