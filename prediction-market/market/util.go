package market

import (
	"strconv"
	"strings"
)

func joinU64(xs []uint64) string {
	parts := make([]string, len(xs))
	for i, x := range xs {
		parts[i] = strconv.FormatUint(x, 10)
	}
	return strings.Join(parts, ",")
}
