// Mermaid diagrams (src/renderer/shared/mermaid.js, mermaid-draw.js): what
// parses, where things land, and that drawing only ever sets text as text.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/renderer/shared/mermaid');
const { draw } = require('../src/renderer/shared/mermaid-draw');

const FLOW = `flowchart TD
  A[Start] --> B{Is it ok?}
  B -- Yes --> C(Done)
  B -->|No| D[[Retry]]
  D -.-> A
  C & D --> E((End))`;

test('a flowchart: nodes with their shapes and labels, edges with theirs', () => {
  const g = M.parse(FLOW);
  assert.equal(g.kind, 'flowchart');
  assert.deepEqual(g.nodes.map(n => [n.id, n.shape, n.label]), [
    ['A', 'rect', 'Start'], ['B', 'diamond', 'Is it ok?'], ['C', 'round', 'Done'], ['D', 'subroutine', 'Retry'], ['E', 'circle', 'End'],
  ]);
  assert.deepEqual(g.edges.map(e => `${e.from}>${e.to}:${e.label}:${e.style}`), [
    'A>B::solid', 'B>C:Yes:solid', 'B>D:No:solid', 'D>A::dotted', 'C>E::solid', 'D>E::solid',
  ]);
});

test('top-down puts each rank below the last, and a loop back still draws', () => {
  const s = M.layout(M.parse(FLOW));
  const at = Object.fromEntries(s.nodes.map(n => [n.id, n]));
  assert.ok(at.A.y < at.B.y && at.B.y < at.C.y && at.C.y < at.E.y);
  assert.equal(at.C.y, at.D.y, 'C and D share a rank');
  assert.ok(Math.abs(at.C.x - at.D.x) >= (at.C.w + at.D.w) / 2, 'and they don\'t overlap');
  assert.equal(s.edges.length, 6);
  for (const n of s.nodes) {
    assert.ok(n.x - n.w / 2 >= 0 && n.x + n.w / 2 <= s.width && n.y - n.h / 2 >= 0 && n.y + n.h / 2 <= s.height, `${n.id} fits`);
  }
});

test('left-to-right runs along x instead', () => {
  const s = M.layout(M.parse('graph LR\n a --> b --> c'));
  const [a, b, c] = s.nodes;
  assert.ok(a.x < b.x && b.x < c.x);
  assert.equal(a.y, c.y);
});

test('subgraphs, quoted labels, <br> and comments', () => {
  const g = M.parse('flowchart TD\n%% note\n subgraph S [Group one]\n  a["Say &quot;hi&quot;<br>twice"]\n end\n a --> b');
  assert.equal(g.groups[0].title, 'Group one');
  assert.deepEqual(g.groups[0].members, ['a']);
  assert.equal(g.nodes[0].label, 'Say "hi"\ntwice');
});

test('a state diagram: start and end dots, labelled transitions', () => {
  const s = M.layout(M.parse('stateDiagram-v2\n [*] --> Idle\n Idle --> Busy : start\n Busy --> Idle : done\n Busy --> [*]'));
  assert.deepEqual(s.nodes.map(n => n.shape), ['start', 'round', 'round', 'end']);
  assert.deepEqual(s.edges.map(e => e.label), ['', 'start', 'done', '']);
});

test('a sequence diagram: participants, messages, notes and frames', () => {
  const g = M.parse(`sequenceDiagram
  autonumber
  participant U as User
  actor C as Claude
  U->>C: Hi
  loop Every turn
    C-->>U: reply
  end
  Note over U,C: fine
  C->>C: think`);
  assert.deepEqual(g.parts.map(p => [p.id, p.label, p.actor]), [['U', 'User', false], ['C', 'Claude', true]]);
  const s = M.layout(g);
  assert.deepEqual(s.msgs.map(m => m.lines[0]), ['1. Hi', '2. reply', '3. think']);
  assert.equal(s.msgs[1].points[0][0] > s.msgs[1].points[1][0], true, 'a reply goes right to left');
  assert.equal(s.frames.length, 1);
  assert.equal(s.notes.length, 1);
  assert.equal(s.msgs[2].self, true);
});

test('what it doesn\'t draw stays a code block: other kinds, nonsense, too much', () => {
  assert.equal(M.parse('pie\n "a": 1'), null);
  assert.equal(M.parse('classDiagram\n A <|-- B'), null);
  assert.equal(M.parse(''), null);
  assert.equal(M.parse('graph TD'), null);
  const huge = `graph TD\n${Array.from({ length: M.MAX_NODES + 5 }, (_, i) => `n${i} --> n${i + 1}`).join('\n')}`;
  assert.equal(M.parse(huge), null);
});

// Just enough of a document to watch what drawing does with text.
function fakeDoc() {
  const made = [];
  const node = tag => {
    const n = {
      tag, attrs: {}, kids: [], textContent: '',
      setAttribute(k, v) { this.attrs[k] = String(v); },
      appendChild(c) { this.kids.push(c); return c; },
    };
    Object.defineProperty(n, 'innerHTML', { set() { throw new Error('innerHTML used'); } });
    made.push(n);
    return n;
  };
  return { made, createElementNS: (_ns, tag) => node(tag) };
}

test('drawing puts labels in as text, never as markup', () => {
  const doc = fakeDoc();
  const svg = draw(M.layout(M.parse('graph TD\n a["<img src=x onerror=alert(1)>"] --> b')), doc);
  assert.equal(svg.tag, 'svg');
  const texts = doc.made.filter(n => n.tag === 'tspan').map(n => n.textContent);
  assert.ok(texts.length && texts.every(t => !t.includes('<')), 'tags are taken out of a label');
  assert.ok(doc.made.every(n => Object.keys(n.attrs).every(k => !/^on/i.test(k))), 'no event attributes');
  const doc2 = fakeDoc();
  draw(M.layout(M.parse('sequenceDiagram\n A->>B: 1 < 2 & "x"')), doc2);
  assert.ok(doc2.made.some(n => n.tag === 'tspan' && n.textContent === '1 < 2 & "x"'));
});
