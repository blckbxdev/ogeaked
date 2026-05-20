const MIRROR_PAIRS = [
  [0, 16],
  [1, 15],
  [2, 14],
  [3, 13],
  [4, 12],
  [5, 11],
  [6, 10],
  [7, 9],
  [17, 26],
  [18, 25],
  [19, 24],
  [20, 23],
  [21, 22],
  [31, 35],
  [32, 34],
  [36, 45],
  [37, 44],
  [38, 43],
  [39, 42],
  [40, 47],
  [41, 46],
  [48, 54],
  [49, 53],
  [50, 52],
  [61, 63],
  [60, 64],
  [67, 65]
];

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const centerlineX = (landmarks) => {
  const noseBridge = landmarks.slice(27, 31);
  const sum = noseBridge.reduce((acc, p) => acc + p.x, 0);
  return sum / noseBridge.length;
};

export function calculateRizzScore(landmarks) {
  if (!landmarks || landmarks.length < 68) return null;
  const center = centerlineX(landmarks);
  let symmetryError = 0;

  for (const [leftIdx, rightIdx] of MIRROR_PAIRS) {
    const left = landmarks[leftIdx];
    const right = landmarks[rightIdx];
    const leftDistance = Math.abs(center - left.x);
    const rightDistance = Math.abs(right.x - center);
    symmetryError += Math.abs(leftDistance - rightDistance);
  }

  const avgError = symmetryError / MIRROR_PAIRS.length;
  const normalized = clamp(1 - avgError / 45, 0, 1);
  const score = clamp(Number((normalized * 10).toFixed(2)), 0, 10);
  return score;
}

export function getTier(score) {
  if (score <= 3) return "mid at best";
  if (score <= 6) return "you're built different";
  if (score <= 8) return "sigma detected";
  return "oGeaked 🔥";
}
