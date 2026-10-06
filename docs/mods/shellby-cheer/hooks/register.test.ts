import { test, expect } from 'claude-code/testing'

type CrabCall = { server: string, tool: string, args: Record<string, unknown> }
type Outcome = { red?: boolean, interrupted?: boolean, stderr?: string }

// tell() runs after the tool has answered: wait for it to reach the crab, or
// for a quiet moment when nothing should.
async function settle(until: () => boolean = () => false) {
  for (let i = 0; i < 50 && !until(); i++) await new Promise(r => setTimeout(r, 10))
}

// Beneath the mod, the test stands in for the engine: it runs each Bash call
// as the test says, in the folder it says, and plays the Shellby MCP server.
function engine($, on, crab: CrabCall[]) {
  let outcome: Outcome = {}
  let folder = 'C:\\work\\app'
  on('session.cwd', () => ({ value: folder }))
  on('mcp.call', ($, e) => {
    crab.push(e)
    return { value: { content: [{ type: 'text', text: 'Done.' }], isError: false } }
  })
  on('tool.call', () => ({
    result: { stdout: '', stderr: outcome.stderr ?? '', interrupted: outcome.interrupted ?? false },
    isError: outcome.red ?? false,
  }))
  return {
    run: async (command: string, next: Outcome = {}) => {
      outcome = next
      const before = crab.length
      await $.tool.call({ tool: 'Bash', command })
      await settle(() => crab.length > before)
    },
    cd: (to: string) => { folder = to },
  }
}

test('frets once when tests go red, and celebrates when they are green again', async ($, on) => {
  const crab: CrabCall[] = []
  const { run } = engine($, on, crab)

  await run('npm test', { red: true })
  await run('npm test', { red: true })
  expect(crab).toHaveLength(1)
  expect(crab[0]).toMatchObject({ server: 'plugin:shellby:shellby', tool: 'say', args: { mood: 'worried' } })

  await run('npm test')
  expect(crab).toHaveLength(2)
  expect(crab[1]).toMatchObject({ tool: 'celebrate' })

  await run('npm test')
  expect(crab).toHaveLength(2)
})

test('a first run that is green is not news', async ($, on) => {
  const crab: CrabCall[] = []
  const { run } = engine($, on, crab)

  await run('pytest -q')
  expect(crab).toHaveLength(0)
})

test('knows a test run after cd, after VAR=value and through python -m', async ($, on) => {
  const crab: CrabCall[] = []
  const { run } = engine($, on, crab)

  await run('cd web && CI=1 npm test', { red: true })
  await run('python -m pytest tests/', { red: true })
  expect(crab).toHaveLength(1)
  await run('python -m pytest tests/')
  expect(crab).toHaveLength(2)
})

test('ignores commands that are not test runs', async ($, on) => {
  const crab: CrabCall[] = []
  const { run } = engine($, on, crab)

  await run('npm run build', { red: true })
  await run('git status')
  expect(crab).toHaveLength(0)
})

test('a run that was interrupted, or a runner that is not installed, says nothing about the tests', async ($, on) => {
  const crab: CrabCall[] = []
  const { run } = engine($, on, crab)

  await run('npm test', { red: true, interrupted: true })
  await run('pytest', { red: true, stderr: 'bash: pytest: command not found' })
  expect(crab).toHaveLength(0)
})

test('each folder keeps its own colour', async ($, on) => {
  const crab: CrabCall[] = []
  const { run, cd } = engine($, on, crab)

  await run('npm test', { red: true })
  cd('C:\\work\\other')
  await run('npm test')
  expect(crab).toHaveLength(1)
})

test('a crab that cannot be reached never fails the tool call', async ($, on) => {
  let tries = 0
  on('session.cwd', () => ({ value: 'C:\\work\\app' }))
  on('mcp.call', () => { tries++; throw new Error('no connected MCP tool "say"') })
  on('tool.call', () => ({ result: { stdout: '', stderr: 'boom', interrupted: false }, isError: true }))

  const ran = await $.tool.call({ tool: 'Bash', command: 'pytest -q' })
  await settle(() => tries > 0)
  expect(tries).toBe(1)
  expect(ran.isError).toBe(true)
})
