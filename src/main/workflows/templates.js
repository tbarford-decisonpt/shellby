// The starter gallery on the Automate page. Each one is an ordinary workflow
// (the tests run every template through validateWorkflow), chosen to show off
// a different part of the engine: typed Claude output driving a branch, a
// loop, a web check, an approval gate, a folder trigger.
const path = require('path');

function templates({ home = '' } = {}) {
  const downloads = home ? path.join(home, 'Downloads') : '';
  return [
    {
      key: 'red-build',
      icon: '🔴',
      name: 'Red build fixer',
      description: 'When a pull request goes red, Claude finds out why. If it can fix it, it does, runs the tests, and asks you before pushing.',
      workflow: {
        name: 'Red build fixer',
        description: 'Diagnose a failing build, fix it if it is simple, and ask before pushing.',
        when: [{ type: 'ci', on: 'failed', repo: '' }],
        steps: [
          {
            id: 'diagnose', type: 'claude', mode: 'plan', label: 'Find out why it failed',
            prompt: 'The pull request {{ trigger.title }} ({{ trigger.url }}) on branch {{ trigger.branch }} has failing checks: {{ trigger.failing | join ", " }}. Find the cause from the code and, if you can, the logs (gh run view --log-failed). Do not change anything yet.',
            output: {
              cause: { type: 'string', description: 'The cause in one or two sentences' },
              fixable: { type: 'boolean', description: 'True if a small, safe code change fixes it' },
            },
          },
          {
            type: 'if', test: 'diagnose.fixable',
            then: [
              { id: 'fix', type: 'claude', mode: 'acceptEdits', label: 'Fix it', prompt: 'Fix it: {{ diagnose.cause }}. Keep the change small. Then run the project\'s tests.' },
              { type: 'ask', question: 'Claude fixed “{{ trigger.title }}”: {{ diagnose.cause }}. Commit and push the fix?' },
              { type: 'claude', mode: 'smart', label: 'Push it', prompt: 'Commit the fix with a clear message and push it to the branch {{ trigger.branch }}.' },
            ],
            else: [
              { type: 'tell', to: 'phone', title: 'Build needs you', text: '{{ trigger.repo }}#{{ trigger.number }}: {{ diagnose.cause }}' },
            ],
          },
        ],
      },
    },
    {
      key: 'morning-brief',
      icon: '☀️',
      name: 'Morning brief',
      description: 'Every weekday at 8:30, a short summary of what changed in your projects yesterday, on your phone.',
      workflow: {
        name: 'Morning brief',
        description: 'A short summary of yesterday\'s work, sent to your phone.',
        when: [{ type: 'schedule', schedule: { type: 'weekly', time: '08:30', days: [1, 2, 3, 4, 5] } }],
        steps: [
          {
            id: 'brief', type: 'claude', mode: 'plan', label: 'Write the brief',
            prompt: 'Look at the git repositories under {{ inputs.folder }} (one level down). For each one with commits since yesterday morning, list what changed in one line. Finish with anything that looks unfinished. Keep it under 120 words.',
          },
          { type: 'tell', to: 'phone', title: 'Morning brief', text: '{{ brief.reply | slice 0 900 }}' },
        ],
        inputs: [{ name: 'folder', label: 'Projects folder', default: home ? path.join(home, 'Documents', 'GitHub') : '' }],
      },
    },
    {
      key: 'uptime',
      icon: '🌐',
      name: 'Site watch',
      description: 'Every 15 minutes, check a web page answers. If it doesn\'t, you hear about it right away.',
      workflow: {
        name: 'Site watch',
        description: 'Checks a page every 15 minutes and tells you when it is down.',
        when: [{ type: 'schedule', schedule: { type: 'minutes', every: 15 } }],
        inputs: [{ name: 'url', label: 'Address to check', default: 'https://example.com' }],
        steps: [
          { id: 'check', type: 'http', method: 'GET', url: '{{ inputs.url }}', allowFail: true, retry: { times: 1, delaySec: 30 } },
          { type: 'if', test: 'not check.ok', then: [{ type: 'tell', to: 'phone', title: 'Site down', text: '{{ inputs.url }} answered {{ check.status }} at {{ now }}' }] },
        ],
      },
    },
    {
      key: 'downloads',
      icon: '📥',
      name: 'Downloads sorter',
      description: 'When new files land in Downloads, Claude moves each into a sensible subfolder and tells you where they went.',
      workflow: {
        name: 'Downloads sorter',
        description: 'Sorts new downloads into subfolders by type.',
        when: downloads ? [{ type: 'folder', path: downloads, pattern: '', events: 'added' }] : [],
        cwd: downloads,
        steps: [
          {
            id: 'sort', type: 'claude', mode: 'acceptEdits', label: 'Sort the new files',
            prompt: 'These files just arrived: {{ trigger.files | join ", " }}. Move each into a subfolder of this folder by type (Documents, Images, Archives, Installers, Other), creating the folder if needed. Never delete anything.',
            output: { moved: { type: 'list', description: 'One "file → folder" line per file moved' } },
          },
          { type: 'tell', to: 'notification', title: 'Downloads sorted', text: '{{ sort.moved | join "\n" }}' },
        ],
      },
    },
    {
      key: 'release-notes',
      icon: '🏷️',
      name: 'Release notes',
      description: 'When you cut a release, Claude drafts the notes from the commits since the last one and saves them next to the project.',
      workflow: {
        name: 'Release notes',
        description: 'Drafts release notes for every release.',
        when: [{ type: 'shipped', kind: 'release', project: '' }],
        steps: [
          {
            id: 'notes', type: 'claude', mode: 'plan', label: 'Draft the notes',
            prompt: 'Project {{ trigger.project }} just released {{ trigger.version | default "a new version" }}. Read the commits since the previous tag and write user-facing release notes in Markdown: New, Changed, Fixed. Reply with only the notes.',
          },
          { type: 'tell', to: 'notification', title: 'Release notes ready', text: '{{ notes.reply | slice 0 300 }}' },
        ],
      },
    },
    {
      key: 'disk-guard',
      icon: '💾',
      name: 'Disk space guard',
      description: 'Every day at noon, check every drive. Any under 10% free, and Claude finds what\'s taking the room.',
      workflow: {
        name: 'Disk space guard',
        description: 'Warns when a drive is nearly full and finds what is using it.',
        when: [{ type: 'schedule', schedule: { type: 'daily', time: '12:00' } }],
        steps: [
          {
            id: 'drives', type: 'run', label: 'Check free space',
            command: 'Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -gt 0 } | ForEach-Object { [pscustomobject]@{ name = $_.Name; pct = [math]::Round(100 * $_.Free / ($_.Used + $_.Free)) } } | Where-Object { $_.pct -lt 10 } | ForEach-Object { "$($_.name): $($_.pct)% free" }',
          },
          {
            type: 'if', test: 'drives.output',
            then: [
              { id: 'look', type: 'claude', mode: 'plan', label: 'Find what is using it', prompt: 'These drives are nearly full: {{ drives.output }}. Find the 10 largest folders on each and suggest what could safely be cleaned up. Don\'t delete anything.' },
              { type: 'tell', to: 'notification', title: 'A drive is nearly full', text: '{{ drives.output }}' },
            ],
          },
        ],
      },
    },
  ];
}

module.exports = { templates };
