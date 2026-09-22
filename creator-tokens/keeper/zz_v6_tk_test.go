package keeper

import (
	"math/big"

	"creator-tokens/core"
)

// tk expresses a whole-token count in v6 units (0.01 token = 1 unit), so the
// scenarios below keep speaking in tokens.
func tk(n int64) *big.Int { return big.NewInt(n * core.TokenScale) }
