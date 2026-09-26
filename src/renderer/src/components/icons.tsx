const base = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, viewBox: '0 0 24 24' }

export const Mic = () => (
  <svg {...base}>
    <rect x="9" y="3" width="6" height="12" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
)

export const Eye = () => (
  <svg {...base}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)

export const Arrow = () => (
  <svg {...base}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </svg>
)

export const Square = () => (
  <svg {...base}>
    <rect x="7" y="7" width="10" height="10" rx="2" />
  </svg>
)

export const Gear = () => (
  <svg {...base}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
  </svg>
)

export const Shrink = () => (
  <svg {...base}>
    <circle cx="12" cy="12" r="4" />
    <path d="M4 4l4 4M20 4l-4 4M4 20l4-4M20 20l-4-4" />
  </svg>
)

export const Close = () => (
  <svg {...base}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
)

export const Plus = () => (
  <svg {...base}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)

export const Search = () => (
  <svg {...base}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </svg>
)

export const Bell = () => (
  <svg {...base}>
    <path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16ZM10 20.5a2.2 2.2 0 0 0 4 0" />
  </svg>
)

export const Chevron = () => (
  <svg {...base}>
    <path d="m7 10 5 5 5-5" />
  </svg>
)

export const ArrowRight = () => (
  <svg {...base}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
)

export const Person = () => (
  <svg {...base}>
    <circle cx="12" cy="8.5" r="3.5" />
    <path d="M5 20c1.2-3.5 3.8-5 7-5s5.8 1.5 7 5" />
  </svg>
)

export const Clock = () => (
  <svg {...base}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </svg>
)

export const Bars = () => (
  <svg {...base}>
    <path d="M6 20V13M12 20V5M18 20v-9" />
  </svg>
)

export const Book = () => (
  <svg {...base}>
    <path d="M3.5 5.5c2.8-.9 5.6-.6 8.5 1v13c-2.9-1.6-5.7-1.9-8.5-1v-13ZM20.5 5.5c-2.8-.9-5.6-.6-8.5 1v13c2.9-1.6 5.7-1.9 8.5-1v-13Z" />
  </svg>
)

export const Clip = () => (
  <svg {...base}>
    <path d="m19 11.5-6.8 6.8a4.5 4.5 0 0 1-6.4-6.4l7.4-7.4a3 3 0 0 1 4.2 4.2l-7.2 7.2a1.5 1.5 0 0 1-2.1-2.1l6.5-6.5" />
  </svg>
)

const speaker = 'M4 9.5h3.2L12 5.5v13l-4.8-4H4z'

export const SpeakerBrief = () => (
  <svg {...base}>
    <path d={speaker} />
    <path d="M15.5 9.5a3.5 3.5 0 0 1 0 5" />
  </svg>
)

export const SpeakerFull = () => (
  <svg {...base}>
    <path d={speaker} />
    <path d="M15.5 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10" />
  </svg>
)

export const SpeakerMute = () => (
  <svg {...base}>
    <path d={speaker} />
    <path d="m16 10 4 4m0-4-4 4" />
  </svg>
)

export const Brain = () => (
  <svg {...base}>
    <path d="M9.5 4.5a2.5 2.5 0 0 0-4.6 1.4A3 3 0 0 0 3.5 11a3 3 0 0 0 1.2 4.8A2.8 2.8 0 0 0 9.5 18V4.5ZM14.5 4.5a2.5 2.5 0 0 1 4.6 1.4 3 3 0 0 1 1.4 5.1 3 3 0 0 1-1.2 4.8 2.8 2.8 0 0 1-4.8 2.2V4.5Z" />
    <path d="M9.5 9H7.8M14.5 9h1.7M9.5 13.5H8M14.5 13.5H16" />
  </svg>
)
