// Syntax colours (src/renderer/shared/syntax.js): tokens that join back into
// exactly the line they came from, and the few kinds that make code readable.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/renderer/shared/syntax');

const kinds = (code, lang) => S.tokenize(code, lang).map(line => line.filter(t => t.t).map(t => `${t.t}:${t.s}`));
const joined = (code, lang) => S.tokenize(code, lang).map(l => l.map(t => t.s).join('')).join('\n');

test('every language gives back exactly the text it was handed', () => {
  const samples = {
    ts: 'const x: number = `a ${b}\n c` + 0x1F; // hi\nif (a / 2 > /re[/]x/g.test(s)) new Foo<T>(1)',
    py: 'def f(x):\n    """doc\n    more"""\n    return None  # c',
    sh: 'echo "$HOME" # c\ngrep -v a#b $1 && ls --all',
    ps: 'Get-ChildItem -Path $env:X | Where-Object { $_.Len -gt 5 } # c\n<# block\n#>',
    json: '{"a": [1, true, "s\\"q"]}',
    html: '<div class="x">hi &amp; <!-- c\n --></div>',
    css: '.a { color: #fff; margin: 0 4px !important; } /* c */',
    rust: "fn main<'a>(x: &'a str) -> Option<u8> { println!(\"{}\", 'c'); None }",
    go: 'func main() { x := `raw\nstring`; fmt.Println(x, nil) }',
    sql: "SELECT id FROM users WHERE name = 'x' -- c",
    yaml: 'name: shellby\n  - run: npm ci # x',
    c: '#include <stdio.h>\nint main(void) { return 0; }',
    md: '# Title\n- item\n> quote',
    diff: '@@ -1 +1 @@\n-a\n+b',
  };
  for (const [lang, code] of Object.entries(samples)) assert.equal(joined(code, lang), code, lang);
  // Nothing is lost on a language it doesn't know, or on a monster line.
  assert.equal(joined('<b>x</b>', 'brainfuck'), '<b>x</b>');
  const long = `const x = "${'y'.repeat(S.MAX_LINE + 50)}";`;
  assert.equal(joined(long, 'js'), long);
});

test('keywords, strings, comments and numbers in JavaScript', () => {
  const [line] = kinds('const n = 42; // the answer', 'js');
  assert.deepEqual(line, ['kw:const', 'num:42', 'com:// the answer']);
  const [call] = kinds('await fetch("x")', 'js');
  assert.deepEqual(call, ['kw:await', 'fn:fetch', 'str:"x"']);
});

test('a template string and a block comment carry on to the next line', () => {
  const lines = kinds('const s = `one\ntwo` + 1;\n/* a\nb */ x', 'js');
  assert.deepEqual(lines[1], ['str:two`', 'num:1']);
  assert.deepEqual(lines[2], ['com:/* a']);
  assert.deepEqual(lines[3], ['com:b */']);
});

test('a slash is a regex only where a value could start', () => {
  assert.deepEqual(kinds('x = a / b / c', 'js')[0], []);
  assert.deepEqual(kinds('x = /a\\/b/g', 'js')[0], ['str:/a\\/b/g']);
});

test('shell: variables, comments only at a word start, single quotes are raw', () => {
  assert.deepEqual(kinds('echo $HOME a#b # note', 'bash')[0], ['var:$HOME', 'com:# note']);
  assert.deepEqual(kinds("echo 'a\\' b", 'sh')[0], ["str:'a\\'"]);
});

test('PowerShell: cmdlets, operators and $true', () => {
  assert.deepEqual(kinds('if ($x -eq $true) { Write-Host "y" }', 'powershell')[0], ['kw:if', 'var:$x', 'kw:-eq', 'lit:$true', 'fn:Write-Host', 'str:"y"']);
});

test('JSON keys are told apart from values', () => {
  assert.deepEqual(kinds('{"name": "shellby", "n": 1}', 'json')[0], ['prop:"name"', 'str:"shellby"', 'prop:"n"', 'num:1']);
});

test('HTML: tags, attributes and comments', () => {
  assert.deepEqual(kinds('<a href="x">y</a>', 'html')[0], ['tag:<a', 'attr:href', 'str:"x"', 'tag:>', 'tag:</a>']);
});

test('a tokenizer hands its place over, for a diff\'s two sides', () => {
  const a = S.lineTokenizer('js');
  a.line('/* open');
  const b = S.lineTokenizer('js');
  b.state = a.state;
  assert.deepEqual(b.line('still */ x').map(t => t.t), ['com', null]);
});

test('languages by fence name and by file name', () => {
  assert.equal(S.langOf('TypeScript'), 'ts');
  assert.equal(S.langOf('tsx'), 'ts');
  assert.equal(S.langOf('ps1'), 'ps');
  assert.equal(S.langOf(''), null);
  assert.equal(S.langOf('nope'), null);
  assert.equal(S.langFromPath('src/a.test.MJS'), 'js');
  assert.equal(S.langFromPath('C:\\x\\Dockerfile'), 'sh');
  assert.equal(S.langFromPath('.env.local'), 'ini');
  assert.equal(S.langFromPath('README'), null);
});
