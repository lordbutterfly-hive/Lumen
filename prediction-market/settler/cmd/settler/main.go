// settler — the prediction market's round opener and settle keeper.
//
// One process, one loop. Every cycle it re-reads chain state and decides from
// scratch: open a round if none is open, settle the open round once its window
// has arrived, and fall back to voidStale if a settle attempt itself keeps
// failing past the deadline. All of that logic lives in the parent
// `scheduler` package and is unit-tested there; this file is the runner around
// it — flags, safety gates, timing, and logging.
//
// STATELESS BY DESIGN. Nothing is cached between cycles. A crash, a restart, or
// two settlers running at once all converge on the same decision from the same
// on-chain truth, and a double-submitted settle is a harmless no-op both
// off-chain (state read shows it resolved) and on-chain (the contract's own
// StateOpen gate). So there is no leader election here and none is needed.
//
// IF THIS PROCESS DIES, NOBODY LOSES MONEY. A round left unsettled past its
// window VOIDs and refunds every staker, and any staker can force that alone
// with `reclaim`. That property is why this is a bot and not a consensus feature.
//
// Usage:
//
//	# see exactly what it would broadcast, touch nothing:
//	settler --gql https://... --contract vsc1... --account settler-bot
//
//	# actually broadcast (testnet):
//	SETTLER_POSTING_WIF=5... settler --live --gql ... --node ... --contract ... --account ...
//
//	# mainnet additionally requires an explicit opt-in:
//	SETTLER_POSTING_WIF=5... settler --live --allow-mainnet ...
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"hive-price-market/scheduler"
	"hive-price-market/settler"
)

// The key is read from the environment ONLY, never a flag: command-line
// arguments are visible to every process on the box via `ps`, and a shell
// history file is not where a signing key belongs.
const wifEnv = "SETTLER_POSTING_WIF"

// Hosts that mean "this is real money". Matching the lite publisher's rule after
// an agent broadcast a real comment to Hive mainnet believing it was harmless:
// pointing at mainnet must be a deliberate, separate act, not a default.
var mainnetHosts = []string{"api.hive.blog", "api.openhive.network", "api.deathwing.me", "hive-api.arcange.eu", "api.hivekings.com", "anyx.io"}

func looksLikeMainnet(node string) bool {
	n := strings.ToLower(node)
	for _, h := range mainnetHosts {
		if strings.Contains(n, h) {
			return true
		}
	}
	return false
}

func main() {
	var (
		gqlURL       = flag.String("gql", "", "Magi GraphQL endpoint (contract state, oracle peek, block height). Required.")
		hiveNode     = flag.String("node", "", "Hive L1 RPC endpoint for broadcasting. Required with --live.")
		account      = flag.String("account", "", "the bot's own Hive account (bare, no 'hive:'). Required.")
		contractID   = flag.String("contract", "", "deployed prediction-market contract id (vsc1...). Required.")
		netID        = flag.String("net-id", "", "Hive custom_json net_id for this deployment. Required.")
		rcLimit      = flag.Uint64("rc-limit", 5000, "rc_limit attached to every op")
		interval     = flag.Duration("interval", 60*time.Second, "how often to poll and decide")
		live         = flag.Bool("live", false, "actually broadcast. Without this, every op is printed and discarded.")
		allowMainnet = flag.Bool("allow-mainnet", false, "required in addition to --live when --node points at Hive mainnet")
		once         = flag.Bool("once", false, "run a single cycle and exit (for cron, or for checking a deployment)")
		doRoll       = flag.Bool("roll", true, "open a new round when none is open")
	)
	flag.Parse()

	if *gqlURL == "" || *account == "" || *contractID == "" || *netID == "" {
		fmt.Fprintln(os.Stderr, "settler: --gql, --account, --contract and --net-id are all required")
		flag.Usage()
		os.Exit(2)
	}

	cfg := scheduler.Config{
		NetID:      *netID,
		ContractID: *contractID,
		RCLimit:    *rcLimit,
		// NOT configurable: RollRound hardcodes the round asset, and letting a
		// flag disagree with it would make the overlap guard and round discovery
		// silently watch a state key that never fills. See Config.Asset's doc.
		Asset: scheduler.DefaultConfig(*contractID).Asset,
	}

	var broadcaster scheduler.Broadcaster
	if *live {
		if *hiveNode == "" {
			fmt.Fprintln(os.Stderr, "settler: --live needs --node (a Hive L1 RPC endpoint)")
			os.Exit(2)
		}
		if looksLikeMainnet(*hiveNode) && !*allowMainnet {
			fmt.Fprintf(os.Stderr,
				"settler: REFUSING to run against what looks like Hive MAINNET (%s) without --allow-mainnet.\n"+
					"         Rounds opened and settled here move real user funds. If that is what you\n"+
					"         intend, pass --allow-mainnet explicitly.\n", *hiveNode)
			os.Exit(2)
		}
		wif := os.Getenv(wifEnv)
		if wif == "" {
			fmt.Fprintf(os.Stderr, "settler: --live needs the posting key in $%s (never pass a key as a flag)\n", wifEnv)
			os.Exit(2)
		}
		// Verifies at startup that this key really is a posting key of this
		// account, and that the authority is not multisig. A wrong key otherwise
		// looks healthy and silently never settles anything.
		hb, err := settler.NewHiveBroadcaster(*hiveNode, *account, wif)
		if err != nil {
			fmt.Fprintf(os.Stderr, "%v\n", err)
			os.Exit(1)
		}
		broadcaster = hb
		log.Printf("settler: LIVE — signing as @%s via %s", hb.Account, hb.Node)
	} else {
		broadcaster = &scheduler.DryRunBroadcaster{Out: os.Stdout}
		log.Printf("settler: DRY RUN — nothing will be broadcast (pass --live to arm)")
	}

	s := &scheduler.Scheduler{
		Cfg:         cfg,
		Price:       &scheduler.GQLPriceSource{Endpoint: *gqlURL, ContractID: *contractID, RCLimit: *rcLimit},
		Block:       &scheduler.GQLBlockSource{Endpoint: *gqlURL},
		State:       &scheduler.GQLStateReader{Endpoint: *gqlURL},
		Broadcaster: broadcaster,
		Caller:      "hive:" + strings.TrimPrefix(*account, "hive:"),
	}

	if *once {
		if err := cycle(s, *doRoll); err != nil {
			log.Printf("settler: cycle error: %v", err)
			os.Exit(1)
		}
		return
	}

	// Clean shutdown so a container stop does not look like a crash in the logs.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)

	ticker := time.NewTicker(*interval)
	defer ticker.Stop()
	log.Printf("settler: polling every %s (contract %s, asset %s)", *interval, cfg.ContractID, cfg.Asset)

	// Run immediately rather than waiting a full interval on boot.
	if err := cycle(s, *doRoll); err != nil {
		log.Printf("settler: cycle error: %v", err)
	}
	for {
		select {
		case <-ticker.C:
			// A cycle error is logged and dropped, never fatal: the next poll
			// re-reads everything from chain and decides again. Exiting on a
			// transient RPC failure would be strictly worse than retrying.
			if err := cycle(s, *doRoll); err != nil {
				log.Printf("settler: cycle error: %v", err)
			}
		case <-stop:
			log.Printf("settler: shutting down")
			return
		}
	}
}

// cycle is one full decision pass: settle the open round if it is due, otherwise
// consider opening one. Order matters — an open round is resolved before a new
// one is opened, because the contract permits only one open round per asset and
// opening is pointless until the previous one is terminal.
func cycle(s *scheduler.Scheduler, doRoll bool) error {
	round, found, err := scheduler.ReadActiveRoundSchedule(s.State, s.Cfg.ContractID, s.Cfg.Asset)
	if err != nil {
		return fmt.Errorf("read active round: %w", err)
	}

	if found {
		res, err := s.RunKeeperCycle(round)
		if err != nil {
			return fmt.Errorf("keeper cycle: %w", err)
		}
		switch {
		case res.Skipped:
			log.Printf("settler: round %d — %s (%s)", res.RoundID, res.Action, res.SkipReason)
		case res.Err != nil && res.FallbackTxID != "":
			// The settle broadcast failed but the round was past its full
			// deadline, so voidStale ran as a second line of defence. Funds are
			// safe; this still needs an operator's eyes.
			log.Printf("settler: round %d — settle FAILED (%v) but fallback %s broadcast as %s",
				res.RoundID, res.Err, res.Fallback, res.FallbackTxID)
		case res.Err != nil:
			log.Printf("settler: round %d — settle failed, will retry next poll: %v", res.RoundID, res.Err)
		case res.TxID != "":
			log.Printf("settler: round %d — %s broadcast as %s", res.RoundID, res.Action, res.TxID)
		default:
			log.Printf("settler: round %d — %s", res.RoundID, res.Action)
		}
		// A round that is still open is not a reason to try opening another.
		return nil
	}

	if !doRoll {
		log.Printf("settler: no open round, and --roll=false — nothing to do")
		return nil
	}

	block, err := s.Block.CurrentHeight()
	if err != nil {
		return fmt.Errorf("block height: %w", err)
	}
	planned, err := s.RunRollCycle(block)
	if err != nil {
		return fmt.Errorf("roll cycle: %w", err)
	}
	if planned.Skipped {
		log.Printf("settler: roll skipped — %s", planned.SkipReason)
		return nil
	}
	log.Printf("settler: opened a round — tx %s (oracle price %d bps, feed ok=%t)",
		planned.TxID, planned.ObservedPriceBps, planned.ObservedFeedOK)
	return nil
}
