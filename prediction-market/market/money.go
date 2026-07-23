package market

import "math/big"

// Integer money helpers — every amount is a non-negative *big.Int, serialized as
// a base-10 string in state. No floats anywhere (mirrors magi-market/money.go).

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

func mLt(a, b *big.Int) bool  { return a.Cmp(b) < 0 }
func mIsZero(a *big.Int) bool { return a.Sign() == 0 }
