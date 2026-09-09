package core

import "math/big"

// Integer money helpers — every amount is a non-negative *big.Int serialized as
// a base-10 string in state. No floats anywhere. HIVE/HBD carry 3 decimals, so
// 1.000 HBD == 1000 base units.
//
// Rounding convention, applied everywhere and relied on by the solvency proof:
// division ALWAYS rounds in the reserve's favour. A holder is never paid a unit
// the reserve does not hold.

func parseMoney(s string) (*big.Int, error) {
	if s == "" {
		return nil, newErr(ErrInput, "empty amount")
	}
	v, ok := new(big.Int).SetString(s, 10)
	if !ok || v.Sign() < 0 {
		return nil, newErr(ErrInput, "invalid amount: "+s)
	}
	return v, nil
}

func mZero() *big.Int { return big.NewInt(0) }

func mAdd(a, b *big.Int) *big.Int { return new(big.Int).Add(a, b) }

// mSub returns a-b, or an error on underflow (never a negative money value).
func mSub(a, b *big.Int) (*big.Int, error) {
	if a.Cmp(b) < 0 {
		return nil, newErr(ErrArith, "amount underflow")
	}
	return new(big.Int).Sub(a, b), nil
}

// mMulBpsDiv = floor(total * bps / 10000).
func mMulBpsDiv(total *big.Int, bps uint64) *big.Int {
	p := new(big.Int).Mul(total, new(big.Int).SetUint64(bps))
	return p.Div(p, big.NewInt(10000))
}

// mMulDiv = floor(a * b / c). c must be > 0 (caller guarantees).
func mMulDiv(a, b, c *big.Int) *big.Int {
	p := new(big.Int).Mul(a, b)
	return p.Div(p, c)
}

// mMulDivCeil = ceil(a * b / c). Used where rounding must favour the reserve
// (i.e. what a buyer PAYS), never where it favours a payout.
func mMulDivCeil(a, b, c *big.Int) *big.Int {
	p := new(big.Int).Mul(a, b)
	p.Add(p, new(big.Int).Sub(c, big.NewInt(1)))
	return p.Div(p, c)
}

func mLt(a, b *big.Int) bool  { return a.Cmp(b) < 0 }
func mGt(a, b *big.Int) bool  { return a.Cmp(b) > 0 }
func mIsZero(a *big.Int) bool { return a.Sign() == 0 }

// mMin returns the smaller of a and b (a new value; neither input is mutated).
func mMin(a, b *big.Int) *big.Int {
	if a.Cmp(b) <= 0 {
		return new(big.Int).Set(a)
	}
	return new(big.Int).Set(b)
}

// mMedian3 returns the median of three values (a new value; no input mutated).
// The median is robust to a SINGLE manipulated or lagging arm: shifting one of
// the three inputs cannot move the median past the other two, so steering it
// takes TWO corrupted arms -- unlike min(), which follows any single low arm.
// Ties are handled by (a+b+c - max - min): two equal values collapse to that
// value. settlement.go uses min(spot, mMedian3(short,long,spot)) so the rate
// stays <= spot (no-arbitrage) yet no lone walked/stale TWAP arm can set it.
func mMedian3(a, b, c *big.Int) *big.Int {
	hi, lo := a, a
	if b.Cmp(hi) > 0 {
		hi = b
	}
	if c.Cmp(hi) > 0 {
		hi = c
	}
	if b.Cmp(lo) < 0 {
		lo = b
	}
	if c.Cmp(lo) < 0 {
		lo = c
	}
	med := new(big.Int).Add(a, b)
	med.Add(med, c)
	med.Sub(med, hi)
	med.Sub(med, lo)
	return med
}
