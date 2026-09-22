package core

import "math/big"

// tk states a WHOLE token count in the unit the v6 API takes. Tests speak in
// tokens; every amount handed to Buy/Sell/Transfer/Refund/Ask/fixtures goes
// through this, so "buy 3 tokens" still reads as 3 in the test and the
// contract receives 300 units.
func tk(n int64) *big.Int { return big.NewInt(n * TokenScale) }
