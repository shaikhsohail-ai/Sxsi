/**
 * Site-wide constants. Edit these to update copy, dates and integrations
 * without touching section code.
 */
export const SITE = {
  name: 'SXSI',
  domain: 'sxsi.ai',
  url: 'https://www.sxsi.ai/',
  tagline: 'Super Intelligence. Launched.',
  motto: 'For the sky.',
}

/** The mission the hero countdown and boarding passes point at. */
export const NEXT_MISSION = {
  number: '002',
  name: 'IGNITION',
  // ISO 8601, UTC. The hero countdown and boarding passes count down to this.
  launchAt: '2027-01-01T00:00:00Z',
  pad: 'LC-01',
}

/** Launch site "coordinates" used in HUD readouts (brand fiction). */
export const COORDINATES = { lat: 28.4858, lon: -80.5444, label: '28.4858° N  80.5444° W' }

/**
 * Optional waitlist endpoint. When set, the Join form POSTs JSON
 * `{ name, email, source: 'sxsi.ai' }` here (e.g. a Formspree / Basin /
 * serverless URL that accepts CORS). Leave empty to disable sign-ups — the
 * site will then only issue boarding passes and never claim a sign-up.
 */
export const WAITLIST_ENDPOINT = ''

/** Public contact address (used for mailto links). */
export const CONTACT_EMAIL = 'hello@sxsi.ai'

/** Social profiles — leave a value empty to hide that link. */
export const SOCIAL = {
  x: '',
  linkedin: '',
  github: '',
}

/** Text used when visitors share the site. */
export const SHARE = {
  text: 'I just boarded SXSI — Super Intelligence. Launched. 🚀 For the sky.',
  url: 'https://www.sxsi.ai/',
}
