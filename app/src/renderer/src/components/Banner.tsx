import type {ReactNode} from 'react'

/** Deterministic star field (no randomness: stable renders and snapshots). */
const STARS: ReadonlyArray<readonly [number, number, number]> = Array.from({length: 46}, (_, i) => [
  (i * 97) % 1200,
  ((i * 53) % 150) + 8,
  i % 3 === 0 ? 1.6 : 1,
])

/**
 * Header illustration: layered mountains under a day sky (light theme) or a
 * starry night with a crescent moon (dark theme). Pure SVG, scales to any
 * width, ~2 KB.
 */
export function Banner({dark, children}: {readonly dark: boolean; readonly children?: ReactNode}) {
  const sky = dark ? ['#0b1a2e', '#14304d'] : ['#2aa8e0', '#9fdcf3']
  const far = dark ? '#1b2f45' : '#bfe6f6'
  const mid = dark ? '#132438' : '#dff3fb'
  const near = dark ? '#0d1a29' : '#f2fafd'
  const snow = dark ? '#2b4560' : '#ffffff'
  return (
    <div className="banner" data-theme={dark ? 'dark' : 'light'}>
      <svg viewBox="0 0 1200 220" preserveAspectRatio="xMidYMid slice" aria-hidden="true" className="banner-art">
        <defs>
          <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={sky[0]} />
            <stop offset="1" stopColor={sky[1]} />
          </linearGradient>
        </defs>
        <rect width="1200" height="220" fill="url(#sky)" />
        {dark
          ? STARS.map(([x, y, r]) => <circle key={`${x}-${y}`} cx={x} cy={y} r={r} fill="#fff6c8" opacity={0.8} />)
          : null}
        {dark ? (
          <path d="M820 92a24 24 0 1 0 20 37 19 19 0 1 1-20-37z" fill="#ffd96b" />
        ) : (
          <circle cx="830" cy="128" r="24" fill="#fff6d6" opacity={0.9} />
        )}
        <path
          d="M0 168 L120 140 L190 152 L300 112 L420 150 L520 134 L640 156 L760 118 L880 150 L1000 116 L1120 146 L1200 130 V220 H0Z"
          fill={far}
        />
        <path
          d="M300 112 L324 124 L310 123 L300 131 L290 122 L276 125Z M760 118 L784 131 L770 129 L760 137 L750 128 L736 131Z M1000 116 L1022 128 L1010 126 L1000 134 L990 125 L978 128Z"
          fill={snow}
        />
        <path
          d="M0 185 C160 160 260 182 380 168 C520 150 620 182 760 168 C900 154 1010 182 1200 160 V220 H0Z"
          fill={mid}
        />
        <path d="M0 200 C200 176 360 196 560 184 C760 172 920 198 1200 180 V220 H0Z" fill={near} />
        {/* a small cabin, warm light on at night */}
        <g transform="translate(176 158)">
          <path d="M0 14 L14 2 L28 14 V30 H0Z" fill={dark ? '#24384d' : '#ffffff'} />
          <path d="M-3 15 L14 0 L31 15" stroke={dark ? '#39536d' : '#cfe9f5'} strokeWidth="3" fill="none" />
          <rect x="6" y="18" width="6" height="6" fill={dark ? '#ffd96b' : '#9fdcf3'} />
          <rect x="16" y="18" width="6" height="6" fill={dark ? '#ffd96b' : '#9fdcf3'} />
        </g>
      </svg>
      <div className="banner-content">{children}</div>
    </div>
  )
}
