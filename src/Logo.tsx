interface LogoProps {
  size?: 'small' | 'large';
}

export default function Logo({ size = 'large' }: LogoProps) {
  return (
    <div className={`logo logo-${size}`} aria-label="Murmur logo">
      <svg viewBox="0 0 128 128" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient
            id={`murmur-logo-gradient-${size}`}
            x1="15"
            y1="12"
            x2="116"
            y2="118"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#8b5cf6" />
            <stop offset="0.48" stopColor="#ec4899" />
            <stop offset="1" stopColor="#f97316" />
          </linearGradient>
        </defs>
        <path
          d="M26 61.2C26 38.9 43.6 22 65.8 22S104 38.7 104 60.2c0 22-16.7 39.8-39.9 39.8h-9.8L35.9 112c-1.9 1.2-4.4-.6-3.8-2.8l4.6-17.5C30 84.9 26 74.4 26 61.2Z"
          fill={`url(#murmur-logo-gradient-${size})`}
        />
        <path
          d="M47 67c0-11.8 6.8-21 17-21s17 9.2 17 21"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="9"
        />
        <path
          d="M45 67h38M54 81h20"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="9"
        />
      </svg>
    </div>
  );
}
