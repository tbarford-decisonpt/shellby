// The routines the Routines page offers to start from. The dependency checkup
// is written so Shellby can read every result (checkup.js): one project per
// command, run from inside it, output not piped anywhere.

const CHECKS = [
  'Node: `npm outdated` and `npm audit` (or `pnpm outdated` / `pnpm audit`, `yarn outdated` / `yarn audit`, `bun outdated` if that is the lockfile).',
  'Python: `pip list --outdated` and `pip-audit` (`poetry show --outdated` for Poetry projects).',
  'Rust: `cargo outdated` and `cargo audit`.',
  'Go: `go list -u -m all` and `govulncheck ./...`.',
  'Ruby: `bundle outdated` and `bundle audit`. PHP: `composer outdated` and `composer audit`. .NET: `dotnet list package --outdated` and `dotnet list package --vulnerable`.',
];

/**
 * What a dependency checkup asks Claude to do.
 *   single: one project (the folder it runs in); otherwise every project in it
 */
function checkupPrompt({ single = false } = {}) {
  return [
    single
      ? 'Dependency checkup for this project.'
      : 'Dependency checkup. If this folder is a project, check it; if it holds several projects (subfolders with a package.json, requirements.txt, pyproject.toml, Cargo.toml, go.mod, Gemfile, composer.json or a .csproj), check each one.',
    `${single ? 'Run' : 'For each project, run'} the checks for its ecosystem, one command per check, ${single ? 'from this folder' : 'from inside the project (`cd <project> && npm audit`)'}. Don't pipe the output through head, tail or anything else, so Shellby can read the result:`,
    ...CHECKS.map(c => `- ${c}`),
    'Skip any tool that isn\'t installed and say so. Don\'t install, upgrade or change anything.',
    `Finish with a short table: ${single ? '' : 'project, '}outdated packages, known vulnerabilities by severity, and the one safest next step${single ? '' : ' for each'}.`,
  ].join('\n');
}

const TEMPLATES = Object.freeze([
  {
    name: 'Dependency checkup', icon: '🧼', prompt: checkupPrompt(),
    schedule: { type: 'weekly', time: '10:00', days: [1] }, mode: 'smart',
    note: 'A clean audit earns XP and the project\'s 🧼 Fresh sticker mark. Pick your projects folder as its folder.',
  },
  { name: 'Friday Downloads tidy', icon: '🧹', prompt: 'Sort my Downloads folder into subfolders by file type (Documents, Images, Archives, Installers, Other). Don\'t delete anything. Finish with a short summary of what moved.', schedule: { type: 'weekly', time: '17:00', days: [5] }, mode: 'acceptEdits' },
  { name: 'Morning briefing', icon: '☕', prompt: 'List the files in my Documents and Desktop that changed in the last 24 hours, grouped by folder, with one line on what each probably is.', schedule: { type: 'daily', time: '08:30' }, mode: 'smart' },
  { name: 'Disk space watch', icon: '💽', prompt: 'Check free space on every drive. If any drive is under 15% free, find the 10 largest folders on it and suggest what could be cleaned up. Don\'t delete anything.', schedule: { type: 'weekly', time: '12:00', days: [1] }, mode: 'smart' },
].map(t => Object.freeze(t)));

module.exports = { TEMPLATES, checkupPrompt };
