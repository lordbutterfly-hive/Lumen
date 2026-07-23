package sim

import (
	"encoding/json"
	"os"
)

// TraceEvent is one recorded action: block, week, actor, role, action, args,
// ok, error symbol, and any state deltas the caller wants to attach. The full
// trace is a JSON array of these, written at the end of a Run (or flushed
// immediately before a halt).
type TraceEvent struct {
	Seq       int               `json:"seq"`
	Block     uint64            `json:"block"`
	Week      int               `json:"week"`
	RoundID   uint64            `json:"round_id,omitempty"`
	Actor     string            `json:"actor"`
	Role      string            `json:"role"`
	Action    string            `json:"action"`
	Args      map[string]string `json:"args,omitempty"`
	OK        bool              `json:"ok"`
	ErrSymbol string            `json:"err_symbol,omitempty"`
	ErrMsg    string            `json:"err_msg,omitempty"`
	Deltas    map[string]string `json:"deltas,omitempty"`
}

// Tracer accumulates TraceEvents in memory and can dump them to a JSON file
// at any point (including mid-run, right before a halt, so a fatal
// invariant violation never loses the events that led up to it).
type Tracer struct {
	events []TraceEvent
	seq    int
}

func NewTracer() *Tracer { return &Tracer{} }

func (t *Tracer) Record(ev TraceEvent) {
	t.seq++
	ev.Seq = t.seq
	t.events = append(t.events, ev)
}

func (t *Tracer) Events() []TraceEvent { return t.events }

func (t *Tracer) Len() int { return len(t.events) }

// WriteJSON dumps the full trace as a JSON array to path.
func (t *Tracer) WriteJSON(path string) error {
	b, err := json.MarshalIndent(t.events, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o644)
}
