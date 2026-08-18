// AV2. Deterministic, no stored state, no drawn asset.
// Ink carries the ring and the letter. Wash is the field.
// Every pair clears 4.5:1 at 26px, which the bright tints do not.
export const PAIRS = [
  { ink: '#a83024', wash: '#fbf1ee' },
  { ink: '#a8462a', wash: '#fcf1ec' },
  { ink: '#3f4650', wash: '#f0f1f3' },
  { ink: '#22514e', wash: '#eef4f3' },
  { ink: '#2b3767', wash: '#eff1f7' },
  { ink: '#5a2747', wash: '#f7eef3' },
  { ink: '#4a5528', wash: '#f2f4ea' },
  { ink: '#524389', wash: '#f1effa' }
];

export function hash(username) {
  let sum = 0;
  for (const ch of String(username)) sum = (sum * 31 + ch.charCodeAt(0)) % 2147483647;
  return sum;
}

export function avatar(username, displayName, size = 40) {
  const { ink, wash } = PAIRS[hash(username) % PAIRS.length];
  return {
    background: wash,
    color: ink,
    border: `${Math.max(1.5, size * 0.032)}px solid ${ink}`,
    width: size,
    height: size,
    borderRadius: '50%',
    fontFamily: 'Lora, Georgia, serif',
    fontWeight: 700,
    fontSize: Math.round(size * 0.47),
    initial: (displayName || username).trim().charAt(0).toUpperCase()
  };
}
