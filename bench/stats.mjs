/**
 * Small, dependency-free statistics for the benchmarks — so a single measured
 * run is reported with its uncertainty, and a head-to-head difference is reported
 * with whether it is significant rather than asserted from a point estimate.
 */

/**
 * Wilson score interval for a binomial proportion k/n. Preferred over the normal
 * approximation because it stays inside [0,1] and behaves at the extremes (e.g.
 * 17/17), which is exactly where small benchmark samples live.
 */
export function wilson(k, n, z = 1.96) {
  if (n === 0) return [0, 0];
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/**
 * McNemar's test for two systems graded on the SAME items (paired). Only the
 * discordant pairs carry signal: b = A right & B wrong, c = A wrong & B right.
 * Uses the exact two-sided binomial p-value (params n=b+c, 0.5) — correct at any
 * count, and these benchmarks have few discordant pairs, where the chi-square
 * approximation is least reliable.
 */
export function mcnemarExact(b, c) {
  const n = b + c;
  if (n === 0) return { b, c, n, p: 1 };
  let pmf = Math.pow(0.5, n); // i = 0 term: C(n,0) * 0.5^n
  let tail = pmf;
  for (let i = 1; i <= Math.min(b, c); i++) {
    pmf *= (n - i + 1) / i; // C(n,i)/C(n,i-1) = (n-i+1)/i
    tail += pmf;
  }
  return { b, c, n, p: Math.min(1, 2 * tail) };
}

export const pct = (x) => `${(100 * x).toFixed(1)}%`;
