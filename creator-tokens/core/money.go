package core

import (
	"math/big"
	"strings"
)

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

// parseTokens reads a token amount off the wire: a non-negative decimal
// string with at most TokenDecimals fractional digits ("2", "1.5", "0.01",
// "+3"), and returns it in state UNITS (x TokenScale). A whole number means
// whole tokens, exactly as before v6, so every pre-v6 payload keeps its
// meaning. Anything else is refused: a third decimal, an exponent, a sign
// other than a leading plus, a bare point, surrounding whitespace, or nothing.
// No floats anywhere: the digits are scaled as integers.
func parseTokens(s string) (*big.Int, error) {
	if s == "" {
		return nil, newErr(ErrInput, "empty amount")
	}
	if s[0] == '+' {
		s = s[1:]
	}
	whole, frac := s, ""
	if i := strings.IndexByte(s, '.'); i >= 0 {
		whole, frac = s[:i], s[i+1:]
	}
	if whole == "" || len(frac) > TokenDecimals || (strings.Contains(s, ".") && frac == "") {
		return nil, newErr(ErrInput, "invalid token amount: "+s)
	}
	for i := 0; i < len(whole); i++ {
		if whole[i] < '0' || whole[i] > '9' {
			return nil, newErr(ErrInput, "invalid token amount: "+s)
		}
	}
	for i := 0; i < len(frac); i++ {
		if frac[i] < '0' || frac[i] > '9' {
			return nil, newErr(ErrInput, "invalid token amount: "+s)
		}
	}
	for len(frac) < TokenDecimals {
		frac += "0"
	}
	v, ok := new(big.Int).SetString(whole+frac, 10)
	if !ok || v.Sign() < 0 {
		return nil, newErr(ErrInput, "invalid token amount: "+s)
	}
	return v, nil
}

// fmtTokens writes state UNITS as the decimal token string the wire carries:
// always TokenDecimals places ("1.50", "0.01", "2.00"), never an exponent,
// never a float. Events and read results use it for every token-denominated
// field; HBD fields stay in base units (evMoney).
func fmtTokens(units *big.Int) string {
	if units == nil || units.Sign() == 0 {
		return "0." + strings.Repeat("0", TokenDecimals)
	}
	neg := units.Sign() < 0
	digits := new(big.Int).Abs(units).String()
	for len(digits) <= TokenDecimals {
		digits = "0" + digits
	}
	cut := len(digits) - TokenDecimals
	out := digits[:cut] + "." + digits[cut:]
	if neg {
		return "-" + out
	}
	return out
}
