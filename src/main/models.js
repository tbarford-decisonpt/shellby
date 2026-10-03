// The models the Settings picker offers, passed straight to `claude --model`.
// The bare aliases follow whatever Claude Code currently maps them to; the
// full ids pin a specific release. Retired and deprecated models are left out,
// and so is Mythos (Project Glasswing only). main.js only accepts ids listed
// here, so add new releases to this list.

const MODELS = [
  { group: 'Latest', id: 'opus', label: 'Opus (latest)' },
  { group: 'Latest', id: 'sonnet', label: 'Sonnet (latest)' },
  { group: 'Latest', id: 'haiku', label: 'Haiku (latest)' },
  { group: 'Fable', id: 'claude-fable-5-1', label: 'Fable 5.1' },
  { group: 'Fable', id: 'claude-fable-5', label: 'Fable 5' },
  { group: 'Opus', id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { group: 'Opus', id: 'claude-opus-5', label: 'Opus 5' },
  { group: 'Opus', id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { group: 'Opus', id: 'claude-opus-4-7', label: 'Opus 4.7' },
  { group: 'Opus', id: 'claude-opus-4-6', label: 'Opus 4.6' },
  { group: 'Opus', id: 'claude-opus-4-5', label: 'Opus 4.5' },
  { group: 'Sonnet', id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { group: 'Sonnet', id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { group: 'Sonnet', id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { group: 'Sonnet', id: 'claude-sonnet-4-5', label: 'Sonnet 4.5' },
  { group: 'Haiku', id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

// '' means "let Claude Code pick", which is always allowed.
const isModel = id => id === '' || MODELS.some(m => m.id === id);

module.exports = { MODELS, isModel };
