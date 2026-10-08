// The crab's tools, served from inside the app to Shellby's own conversations.
//
// The plugin's MCP server (claude-plugin/mcp/server.js) is a separate process
// that reaches the app over a local port, for Claude Code running anywhere.
// Shellby's own `claude -p` processes don't need that: Claude Code can host an
// MCP server in the app that started it, over the same stdin/stdout control
// channel permission prompts use (an `mcp_message` control request carrying the
// JSON-RPC). So there is no extra process, no port, and every call arrives
// knowing which conversation made it.
//
// Every tool schema is sent to the model on every turn, so descriptions are as
// short as they can be and still be used well.
//
// Pure: handle() takes the JSON-RPC message and a `call` callback that does the
// work; see test/crabmcp.test.js.

const { MOODS, MAX_TEXT, MAX_ITEM } = require('./crabtools');
const { FEATURE_IDS, FOCUS_MINUTES } = require('./selfaware');

const SERVER = 'shellby';
const VERSION = '1.0.0';
const PROTOCOL = '2025-06-18';

const obj = (properties, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });

const CRAB_TOOLS = [
  {
    name: 'say',
    description: "Put one short line in the crab's speech bubble on the desktop.",
    inputSchema: obj({ text: { type: 'string', maxLength: MAX_TEXT }, mood: { type: 'string', enum: MOODS } }, ['text']),
  },
  {
    name: 'celebrate',
    description: 'Confetti on the desktop for a real milestone: a release out, a red build green, a long job done.',
    inputSchema: obj({ reason: { type: 'string', maxLength: MAX_TEXT } }),
  },
  {
    name: 'wear',
    description: 'Put an unlocked accessory on the crab by name, like "party hat".',
    inputSchema: obj({ item: { type: 'string', maxLength: MAX_ITEM } }, ['item']),
  },
  {
    name: 'status',
    description: "The crab's level and what he's doing, plus this PC's temperatures, memory and disk space if Health is on. Worth a look before a heavy build.",
    inputSchema: obj({}),
  },
];

const SUGGEST_TOOL = {
  name: 'suggest',
  description: 'Offer the user a Shellby feature as a card they can tap. Nothing happens unless they tap it. The reply says whether it was shown.',
  inputSchema: obj({
    feature: { type: 'string', enum: FEATURE_IDS },
    why: { type: 'string', maxLength: 120, description: 'Why it helps here, in a few words.' },
    name: { type: 'string', description: 'routine: a short name' },
    prompt: { type: 'string', description: 'routine: the task it runs' },
    schedule: { type: 'string', description: 'routine: "daily 08:30", "weekly mon,fri 17:00" or "every 4h"' },
    minutes: { type: 'integer', enum: FOCUS_MINUTES, description: 'focus' },
  }, ['feature', 'why']),
};

/** The tools a conversation gets: the crab's, plus `suggest` when suggestions are on. */
function toolsFor({ suggestions = true } = {}) {
  return suggestions ? [...CRAB_TOOLS, SUGGEST_TOOL] : CRAB_TOOLS;
}

/** --mcp-config for a conversation: one server, hosted by Shellby itself. */
function mcpConfig() {
  return JSON.stringify({ mcpServers: { [SERVER]: { type: 'sdk', name: SERVER } } });
}

const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

/**
 * One JSON-RPC message from Claude Code -> the response to send back.
 *   tools: what tools/list answers with
 *   call(name, args) -> Promise<{ text, isError? }>; only ever called with a listed tool
 * Notifications have no id and get an empty result, which is what Claude Code
 * expects in the control response that carries them.
 */
async function handle(message, { tools, call }) {
  const m = message && typeof message === 'object' ? message : {};
  const id = m.id ?? null;
  switch (m.method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: typeof m.params?.protocolVersion === 'string' ? m.params.protocolVersion : PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER, version: VERSION },
      });
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools });
    case 'tools/call': {
      const name = m.params?.name;
      if (!tools.some(t => t.name === name)) return reply(id, { content: [{ type: 'text', text: `Unknown tool: ${String(name).slice(0, 40)}` }], isError: true });
      const args = m.params?.arguments && typeof m.params.arguments === 'object' ? m.params.arguments : {};
      let out;
      try { out = await call(name, args); } catch (err) { out = { text: `Shellby couldn't do that: ${err.message}`, isError: true }; }
      return reply(id, { content: [{ type: 'text', text: String(out?.text || 'Done.') }], ...(out?.isError ? { isError: true } : {}) });
    }
    default:
      if (id === null) return { jsonrpc: '2.0', id: 0, result: {} };  // a notification
      return fail(id, -32601, `Method not found: ${String(m.method).slice(0, 40)}`);
  }
}

module.exports = { SERVER, toolsFor, mcpConfig, handle };
