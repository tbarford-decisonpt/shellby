import type { Register } from 'claude-code'

// The Shellby plugin's MCP server, as /mcp lists it. Its tools (say, celebrate,
// wear, status) are what a mod can ask of the crab: docs/MODS.md.
const SHELLBY = 'plugin:shellby:shellby'

// A test run at the start of one piece of a command line, after any VAR=value.
// Text in quotes can match too, and `npm test | tail` reports tail's exit code:
// good enough for a crab's mood, not for a CI gate.
const TEST_RUN = /^(\w+=\S*\s+)*(npm (run )?test|npm t|pnpm (run )?test|yarn test|npx (jest|vitest)|jest|vitest|(python3? -m )?pytest|cargo test|go test|node --test|dotnet test)\b/
// The runner never ran, so this says nothing about the tests.
const NOT_RUN = /command not found|is not recognized as/i

// Only the change of colour is news: green to red, or red back to green. One
// colour per folder, so two projects in one Claude Code don't mix theirs up.
const lastRed = new Map<string, boolean>()

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || !isTestRun(e.command)) return ran
    if (ran.result?.interrupted === true || NOT_RUN.test(`${ran.result?.stderr ?? ''}\n${ran.text ?? ''}`)) return ran

    const folder = await $.session.cwd()
    const isRed = ran.isError === true
    const wasRed = lastRed.get(folder)
    lastRed.set(folder, isRed)
    // Not awaited: Claude shouldn't wait on the crab.
    if (isRed && wasRed !== true) void tell($, 'say', { text: "Tests went red. I'll keep a claw on it.", mood: 'worried' })
    if (!isRed && wasRed === true) void tell($, 'celebrate', { reason: 'Tests are green again!' })
    return ran
  })
}

function isTestRun(command: string): boolean {
  return command.split(/&&|\|\||[;\n]/).some(part => TEST_RUN.test(part.trim()))
}

// Shellby not running, the plugin missing or the call not allowed all end
// here: the crab is a nice extra, never a reason for a tool call to fail.
async function tell($, tool: string, args: Record<string, unknown>) {
  try {
    const r = await $.mcp.call(SHELLBY, tool, args)
    if (r.isError) $.ui.log(`Shellby didn't ${tool}: ${(r.content ?? []).map(c => c.text ?? '').join(' ').slice(0, 120)}`, { to: 'debug' })
  } catch (err) {
    $.ui.log(`Shellby didn't ${tool}: ${String(err?.message ?? err).slice(0, 160)}`, { to: 'debug' })
  }
}
