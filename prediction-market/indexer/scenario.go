package indexer

// BuildCanonicalScenario returns a MockEventSource seeded with the exact
// event sequence the build spec calls for: "a round_created; 5 accounts bet;
// resolved; 3 of the winners claim, 2 don't." Shared by demo.go (RunDemo)
// and index_test.go so the numbers pasted in the build report are exactly
// what the tests assert — nothing up a sleeve.
//
// All 5 accounts bet the SAME winning outcome (2 == "flat" in this
// deployment's 5-bucket convention, see api.go's BucketIDs) so that all 5
// are genuinely winners, matching "3 of the winners claim, 2 don't"
// literally: alice/bob/carol claim, dave/erin don't.
//
// Amounts are plain decimal base-unit strings (see events.go's Amount doc) —
// arbitrary but deliberately distinct per account so a bug that mixed up
// WHICH account's stake got recorded would show up as a wrong total, not
// coincidentally cancel out.
func BuildCanonicalScenario() *MockEventSource {
	src := NewMockEventSource()

	src.Push(`{"ev":"round_created","roundId":1,"by":"hive:lordbutterfly"}`)

	src.Push(`{"ev":"bet","roundId":1,"outcome":2,"acct":"hive:alice","amount":"5000"}`)
	src.Push(`{"ev":"bet","roundId":1,"outcome":2,"acct":"hive:bob","amount":"3000"}`)
	src.Push(`{"ev":"bet","roundId":1,"outcome":2,"acct":"hive:carol","amount":"2000"}`)
	src.Push(`{"ev":"bet","roundId":1,"outcome":2,"acct":"hive:dave","amount":"1000"}`)
	src.Push(`{"ev":"bet","roundId":1,"outcome":2,"acct":"hive:erin","amount":"4000"}`)
	// pool = 5000+3000+2000+1000+4000 = 15000

	src.Push(`{"ev":"resolved","roundId":1,"state":"settled","winner":2,"reason":""}`)

	// 3 winners claim (alice, bob, carol); dave and erin do not.
	src.Push(`{"ev":"claim","roundId":1,"acct":"hive:alice","payout":"4900","asset":"hive"}`)
	src.Push(`{"ev":"claim","roundId":1,"acct":"hive:bob","payout":"2940","asset":"hive"}`)
	src.Push(`{"ev":"claim","roundId":1,"acct":"hive:carol","payout":"1960","asset":"hive"}`)

	// Two separate withdrawFees sweeps, to prove HouseTaken SUMS across
	// events rather than just passing one through: 300 + 50 = 350.
	src.Push(`{"ev":"house_paid","asset":"hive","amount":"300","house":"hive:lordbutterfly"}`)
	src.Push(`{"ev":"house_paid","asset":"hive","amount":"50","house":"hive:lordbutterfly"}`)

	return src
}
