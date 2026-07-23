package analysis

import "math/big"

// testtrace_test.go — a tiny builder for constructing synthetic Trace values
// in tests, matching the wire convention documented in report.go's package
// doc (Args = call inputs; lowercase action names, exactly as confirmed by
// reading sim/trace.go's Event.Action comment). Every test in this package
// builds its own trace this way — sim/engine.go's real output did not exist
// yet when this package was built (see the report filed alongside it), so
// these are this package's only source of ground truth until then.

type evb struct {
	ev Event
}

func newEv(block uint64, actor, action, creator string) *evb {
	return &evb{ev: Event{
		Block: block, Actor: actor, Action: action, Creator: creator,
		Args: map[string]string{}, OK: true, Deltas: map[string]string{},
	}}
}

func (b *evb) arg(k, v string) *evb { b.ev.Args[k] = v; return b }

func (b *evb) argN(k string, v int64) *evb { b.ev.Args[k] = big.NewInt(v).String(); return b }

func (b *evb) role(r string) *evb { b.ev.Role = r; return b }

func (b *evb) day(d int) *evb { b.ev.Day = d; return b }

func (b *evb) delta(k, v string) *evb { b.ev.Deltas[k] = v; return b }

func (b *evb) fail(sym, msg string) *evb {
	b.ev.OK = false
	b.ev.ErrSym = sym
	b.ev.ErrMsg = msg
	b.ev.Deltas = map[string]string{} // sim/trace.go: empty, never nil, on a failed call
	return b
}

func (b *evb) build() Event { return b.ev }

func mustBig(s string) *big.Int {
	n, ok := new(big.Int).SetString(s, 10)
	if !ok {
		panic("bad big.Int literal: " + s)
	}
	return n
}

// registerEv builds a standard "register" event: fee paid exactly the
// RegistrationFee (10000), face/cap as given.
func registerEv(block uint64, creator string, face, cap int64) Event {
	return newEv(block, creator, "register", creator).
		argN("face", face).argN("cap", cap).argN("feePaid", 10000).build()
}

func prepayEv(block uint64, actor, creator string, hbdPaid int64) Event {
	return newEv(block, actor, "prepay", creator).argN("hbdPaid", hbdPaid).build()
}

// askEv builds a standard "ask" event. commissionHbdPaid is computed by the
// caller (tests exercise both the exact-owed and overpaid cases directly),
// deadlineBlocks defaults to a 7-day window (well inside [MinAskDeadline,
// MaxAskDeadline]). creditsSpent is echoed into Args, matching the real
// engine's own convention confirmed by reading sim/actions.go's
// doAskExecute (added after this package's initial build): Args["seq"],
// Args["rateUsed"] and Args["creditsSpent"] are all appended to Args on a
// successful ask, alongside the true call inputs.
func askEv(block uint64, actor, creator string, commissionHbdPaid int64, deadlineBlocks uint64, creditsSpent int64) Event {
	return newEv(block, actor, "ask", creator).
		argN("maxCredits", 1_000_000).
		argN("commissionHbdPaid", commissionHbdPaid).
		arg("contentHash", "hash1").
		arg("deadlineBlocks", big.NewInt(int64(deadlineBlocks)).String()).
		argN("creditsSpent", creditsSpent).
		build()
}

func answerEv(block uint64, actor, creator string, seq uint64) Event {
	return newEv(block, actor, "answer", creator).
		arg("seq", big.NewInt(int64(seq)).String()).arg("answerHash", "answerHash1").build()
}

func reclaimEv(block uint64, actor, creator string, seq uint64) Event {
	return newEv(block, actor, "reclaim", creator).arg("seq", big.NewInt(int64(seq)).String()).build()
}

func refundEv(block uint64, actor, creator string, credits int64) Event {
	return newEv(block, actor, "refund", creator).argN("credits", credits).build()
}

func refundHolderEv(block uint64, actor, creator, holder string) Event {
	return newEv(block, actor, "refundHolder", creator).arg("holder", holder).build()
}

func transferEv(block uint64, from, creator, to string, amount int64) Event {
	return newEv(block, from, "transfer", creator).arg("to", to).argN("amount", amount).build()
}

func renewEv(block uint64, actor, creator string, periods int64, paid int64) Event {
	return newEv(block, actor, "renew", creator).argN("periods", periods).argN("paid", paid).build()
}

// withdrawTreasuryEv builds a global (creator="") owner treasury withdrawal —
// the C2 exit (Upgrade 1). Args["amount"] is the base-unit amount pulled.
func withdrawTreasuryEv(block uint64, owner string, amount int64) Event {
	return newEv(block, owner, "withdrawTreasury", "").argN("amount", amount).build()
}
