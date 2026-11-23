// Exact fractions for musical durations (the Python prototype used fractions.Fraction).

const gcd = (a, b) => {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a || 1;
};

export class Frac {
  constructor(n, d = 1) {
    if (!Number.isInteger(n) || !Number.isInteger(d) || d === 0) throw new RangeError(`bad fraction ${n}/${d}`);
    if (d < 0) [n, d] = [-n, -d];
    const g = gcd(n, d);
    this.n = n / g;
    this.d = d / g;
  }
  static of(x) {
    return x instanceof Frac ? x : new Frac(x, 1);
  }
  add(o) {
    o = Frac.of(o);
    return new Frac(this.n * o.d + o.n * this.d, this.d * o.d);
  }
  sub(o) {
    o = Frac.of(o);
    return new Frac(this.n * o.d - o.n * this.d, this.d * o.d);
  }
  mul(o) {
    o = Frac.of(o);
    return new Frac(this.n * o.n, this.d * o.d);
  }
  div(o) {
    o = Frac.of(o);
    return new Frac(this.n * o.d, this.d * o.n);
  }
  cmp(o) {
    o = Frac.of(o);
    return Math.sign(this.n * o.d - o.n * this.d);
  }
  eq(o) {
    return this.cmp(o) === 0;
  }
  lt(o) {
    return this.cmp(o) < 0;
  }
  gt(o) {
    return this.cmp(o) > 0;
  }
  isInt() {
    return this.d === 1;
  }
  /** Integer part, truncated toward zero (Python int()). */
  trunc() {
    return Math.trunc(this.n / this.d);
  }
  /** JSON-friendly: an integer when whole, otherwise "n/d" (the prototype's f2s). */
  toJSON() {
    return this.d === 1 ? this.n : `${this.n}/${this.d}`;
  }
  toString() {
    return String(this.toJSON());
  }
}

export const fmax = (a, b) => (Frac.of(a).cmp(b) >= 0 ? Frac.of(a) : Frac.of(b));
