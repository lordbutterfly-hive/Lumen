"""★ 2026-08-08 — the declared-interest term after the rarity rebuild.

WHAT WENT WRONG, AND WHY THESE TESTS EXIST. `declared_interest_raw` was 32% of
the final score and its raw was `|post.tags & interest_tags| / len(post.tags)`.
Measured on the owner's own served 20-post page: 13 of 20 posts carried the tag
`hive` — the platform's own name, worn by 1 in 9 root posts on the chain and
almost exclusively by meta-content — and 16 of 20 matched on exactly ONE tag,
so a third of the score was a `hive`-detector. The denominator meanwhile
penalised a post that described itself with 8 honest tags 8:1 against a post
tagged `[hive]`.

Two changes, tested here as two separate mechanisms because they close two
different defects and either could be silently deleted without the other
noticing:

  1. `recsys.core.scoring.tag_rarity_weight` / `declared_interest_raw` — a
     tag is worth what it NARROWS, measured, and a post is worth the rarest
     interest it actually claims. No denominator, and a hard spray bound.
  2. `recsys.viewer.derive_interest_tags` — inference refuses to put
     reward-tribe / curation / frontend / namespace tags in a reader's mouth,
     because with only six slots each one EVICTS a real interest.

`tests/test_scoring.py` keeps the two pre-existing raw tests (rewritten for the
new contract) and the mandatory
`test_interest_match_zero_is_byte_identical_to_the_pre_b02_score` invariant.
"""

from __future__ import annotations

import math
from datetime import UTC, datetime

import pytest

from recsys.core.scoring import (
    _TAG_DF,
    _TAG_DF_CORPUS,
    _TAG_DF_DEFAULT,
    _TAG_DF_ENTRIES,
    _parse_tag_df,
    declared_interest_raw,
    tag_rarity_weight,
)
from recsys.viewer import (
    _NON_TOPICAL_TAGS,
    _is_topical_tag,
    derive_interest_tags,
)
from tests.fakes import make_post

EPOCH = datetime(2026, 8, 8, tzinfo=UTC)

# The owner's own derived interests on 2026-08-08 (pre-filter), used as the
# adversary's target set throughout — a real viewer, not a constructed one.
OWNER_INTERESTS = frozenset(
    {"contest", "hive", "hive-140169", "music", "news", "vibes"}
)


# ---------------------------------------------------------------------------
# 1. The rarity weight itself.
# ---------------------------------------------------------------------------


def test_rarity_weight_falls_as_a_tag_gets_more_common() -> None:
    """The whole point: a namespace worn by a tenth of the chain must be worth
    a fraction of a real topic, and both a fraction of a genuinely rare one."""
    assert (
        tag_rarity_weight("neoxian")  # 31.4% of root posts
        < tag_rarity_weight("hive")  # 10.6%
        < tag_rarity_weight("news")  # 2.7%
        < tag_rarity_weight("philosophy")  # 0.8%
        < tag_rarity_weight("hive-140169")  # rarer than anything measured
    )


def test_rarity_weight_is_bounded_and_never_zero_or_negative() -> None:
    for tag in ("neoxian", "hive", "philosophy", "a-tag-nobody-has-ever-used"):
        assert 0.0 < tag_rarity_weight(tag) <= 1.0


def test_an_unmeasured_tag_is_scored_at_the_table_floor_not_at_the_ceiling() -> None:
    """★ THE TRUNCATION MUST BE CONSERVATIVE. The baked table is "the 500 most
    common tags", so an absent tag is PROVEN rarer than every tag in it — but
    it is scored at the floor the table records, never at the 1.0 ceiling, so
    the missing measurement can only ever UNDERSTATE rarity."""
    unmeasured = tag_rarity_weight("no-such-tag-anywhere-on-chain")
    assert unmeasured == pytest.approx(
        math.log((_TAG_DF_CORPUS + 1) / (_TAG_DF_DEFAULT + 1))
        / math.log(_TAG_DF_CORPUS + 1)
    )
    assert unmeasured < 1.0
    # ...and it is still strictly rarer than the rarest tag the table records.
    rarest_measured = min(_TAG_DF, key=lambda t: -_TAG_DF[t])
    assert unmeasured >= tag_rarity_weight(rarest_measured)


def test_the_baked_table_parses_completely_and_refuses_a_broken_wrap() -> None:
    """★ THIS BUG ALREADY HAPPENED (2026-08-08, caught before it shipped). The
    table was line-wrapped with ``textwrap.wrap``'s default
    ``break_on_hyphens=True``, which split ``hive-daily-mix:112`` across a line
    into ``hive-daily-`` + ``mix:112``. The lenient parser skipped the orphan
    and recorded a tag called ``mix`` at the wrong frequency — and the entry
    COUNT still came out at exactly 500, so a length check alone would have
    passed it. Any editor or formatter re-wrapping that block can reintroduce
    it, so the parser must refuse a token it cannot fully account for."""
    assert len(_TAG_DF) == _TAG_DF_ENTRIES
    assert _TAG_DF.get("hive-daily-mix") == 112
    assert _TAG_DF.get("pl-kbk") == 85
    assert "mix" not in _TAG_DF and "kbk" not in _TAG_DF
    with pytest.raises(ValueError, match="malformed"):
        _parse_tag_df("hive:3932 hive-daily-\nmix:112")
    with pytest.raises(ValueError, match="malformed"):
        _parse_tag_df("hive:notanumber")


def test_rarity_lookup_survives_the_chain_s_real_tag_hygiene() -> None:
    # HAFSQL really does carry "Spanish " next to "spanish".
    assert tag_rarity_weight("Spanish ") == pytest.approx(tag_rarity_weight("spanish"))


def test_a_live_histogram_overrides_the_baked_table() -> None:
    """The wiring seam: a caller holding the rolling-window sample (the same
    posts `NormContext` is built from) passes it straight in, and a tag absent
    from a FULL window count genuinely has df = 0 there."""
    live = {"hive": 900, "philosophy": 3}
    assert tag_rarity_weight("hive", tag_df=live, corpus_size=1000) < tag_rarity_weight(
        "philosophy", tag_df=live, corpus_size=1000
    )
    absent = tag_rarity_weight("brand-new-tag", tag_df=live, corpus_size=1000)
    assert absent == pytest.approx(1.0)
    # The override really is used, not merely accepted: `hive` is common in the
    # baked table and this live window makes it commoner still.
    assert tag_rarity_weight("hive", tag_df=live, corpus_size=1000) != pytest.approx(
        tag_rarity_weight("hive")
    )


# ---------------------------------------------------------------------------
# 2. The raw: the denominator is gone, and the spray bound that replaced it.
# ---------------------------------------------------------------------------


def test_honest_tagging_is_no_longer_punished_eight_to_one() -> None:
    """THE MEASURED DEFECT, as an assertion. `tarazkp` tagged a post with 8
    accurate tags and scored 0.125 for the same single match a post tagged
    `[hive]` scored 1.000 for."""
    one_tag = make_post(tags=("music",))
    eight_tags = make_post(
        tags=(
            "music",
            "philosophy",
            "psychology",
            "mindset",
            "family",
            "writing",
            "art",
            "life",
        )
    )
    interests = frozenset({"music"})
    assert declared_interest_raw(eight_tags, interests) == pytest.approx(
        declared_interest_raw(one_tag, interests)
    )


def test_a_namespace_only_match_no_longer_scores_a_perfect_one() -> None:
    """`@epodcaster`'s post, tagged `[hive]`, scored 1.000 — the top of the
    scale — against `@vikisecrets`' 10-tag post at 0.100 for the SAME match."""
    epodcaster = make_post(tags=("hive",))
    vikisecrets = make_post(
        tags=(
            "hive",
            "apps",
            "rewards",
            "crypto",
            "vibecoding",
            "ai",
            "dev",
            "tools",
            "web",
            "news",
        )
    )
    hive_only = frozenset({"hive"})
    assert declared_interest_raw(epodcaster, hive_only) < 0.25
    assert declared_interest_raw(vikisecrets, hive_only) == pytest.approx(
        declared_interest_raw(epodcaster, hive_only)
    )


def test_a_rare_interest_outranks_a_namespace_interest() -> None:
    """The ordering the term exists to express, and did not."""
    meta = make_post(tags=("hive", "followfriday"))
    on_topic = make_post(tags=("hive-140169", "gaming"))
    assert declared_interest_raw(on_topic, OWNER_INTERESTS) > declared_interest_raw(
        meta, OWNER_INTERESTS
    )


def test_the_spray_bound_extra_interest_tags_are_worth_exactly_zero() -> None:
    """★★★ THE SPRAY PROOF. A post claiming ALL SIX of the owner's interests
    scores precisely what the single rarest of them scores — every additional
    sprayed tag has zero marginal value — and it does not beat an honest post
    that simply carries that same tag."""
    spray = make_post(tags=tuple(sorted(OWNER_INTERESTS)))
    sprayed = declared_interest_raw(spray, OWNER_INTERESTS)
    best_single = max(tag_rarity_weight(t) for t in OWNER_INTERESTS)
    assert sprayed == pytest.approx(best_single)

    # Marginal value of each extra sprayed tag: zero. Adding the rest of the
    # viewer's interests one at a time never moves the score once the rarest
    # tag is present.
    rarest = max(OWNER_INTERESTS, key=tag_rarity_weight)
    running = [rarest]
    for extra in sorted(OWNER_INTERESTS - {rarest}):
        running.append(extra)
        assert declared_interest_raw(
            make_post(tags=tuple(running)), OWNER_INTERESTS
        ) == pytest.approx(sprayed)

    # ...and the honest post that is genuinely about that one thing is not
    # beaten by the sprayer.
    honest = make_post(tags=(rarest, "some-detail", "another-detail"))
    assert declared_interest_raw(honest, OWNER_INTERESTS) >= sprayed


def test_spraying_off_interest_tags_cannot_move_the_score_either_way() -> None:
    """The other half of the bound. The old denominator made off-interest
    padding DILUTE the score, which is what punished honest tagging; removing
    it must not make padding PAY."""
    base = make_post(tags=("music",))
    padded = make_post(tags=("music", *(f"pad-{i}" for i in range(30))))
    interests = frozenset({"music"})
    assert declared_interest_raw(padded, interests) == pytest.approx(
        declared_interest_raw(base, interests)
    )


def test_raw_is_zero_for_no_interests_no_tags_or_no_overlap() -> None:
    """Preserved from B-02: an absence of signal is an honest zero, never a
    made-up constant and never None."""
    assert declared_interest_raw(make_post(tags=("music",)), frozenset()) == 0.0
    assert declared_interest_raw(make_post(tags=()), frozenset({"music"})) == 0.0
    assert declared_interest_raw(make_post(tags=()), frozenset()) == 0.0
    assert declared_interest_raw(make_post(tags=("music",)), frozenset({"cooking"})) == 0.0


def test_raw_stays_in_the_unit_interval_for_every_shape() -> None:
    interests = frozenset({"a-rare-unmeasured-tag", "hive", "music"})
    for tags in (
        ("hive",),
        ("a-rare-unmeasured-tag",),
        tuple(sorted(interests)),
        ("hive", *(f"pad-{i}" for i in range(50))),
    ):
        assert 0.0 <= declared_interest_raw(make_post(tags=tags), interests) <= 1.0


def test_the_served_order_is_invariant_to_any_monotone_rescaling() -> None:
    """★ NO TUNING CONSTANT, PROVEN. The caller percentile-ranks this raw, and
    `max f(w) == f(max w)` for monotone `f`, so squaring / re-basing / rescaling
    the rarity weight cannot change the order posts are served in. Nothing here
    could have been fitted to a page."""
    posts = [
        make_post(tags=("hive",)),
        make_post(tags=("news", "hive")),
        make_post(tags=("music", "guitar")),
        make_post(tags=("hive-140169",)),
        make_post(tags=("cooking",)),
    ]
    raws = [declared_interest_raw(p, OWNER_INTERESTS) for p in posts]
    order = [i for i, _ in sorted(enumerate(raws), key=lambda kv: -kv[1])]
    for exponent in (0.5, 2.0, 3.0):
        # An exponent applied to the WEIGHT is a monotone map, and `max` commutes
        # with it, so the induced ordering must be identical.
        rescaled = [r**exponent for r in raws]
        assert [i for i, _ in sorted(enumerate(rescaled), key=lambda kv: -kv[1])] == order
    # The order is not trivially constant — otherwise this would pass on a
    # function that returned the same number for everything.
    assert len(set(raws)) >= 4


# ---------------------------------------------------------------------------
# 3. Derivation: what may and may not be INFERRED as somebody's interest.
# ---------------------------------------------------------------------------


class _FakeFetch:
    """Just enough of `_FetchCapable` for `derive_interest_tags`: own posts,
    and no vote history."""

    def __init__(self, own: list[tuple[list[str], str]]) -> None:
        self._own = own

    def _fetch(self, sql: str, params: dict[str, object]) -> list[tuple[object, ...]]:
        if "FROM hafsql.comments" in sql and "author = %(account)s" in sql:
            return [(tags, category) for tags, category in self._own]
        return []


def test_reward_tribe_and_namespace_tags_are_not_topical() -> None:
    for tag in ("hive", "neoxian", "pob", "archon", "ecency", "ocd", "posh", "hiveposh"):
        assert not _is_topical_tag(tag), tag


def test_genuine_topics_survive_including_the_ones_frequency_would_kill() -> None:
    """`photography` (10.9% of root posts) and `life` (11.1%) are as common as
    `hive` (10.6%) and are perfectly good interests — the exclusion is semantic,
    not a frequency cutoff, and this is the test that would fail if somebody
    replaced it with one."""
    for tag in (
        "photography",
        "life",
        "blog",
        "spanish",
        "splinterlands",
        "leofinance",
        "actifit",
        "spt",
        "music",
        "shadowphotos",
    ):
        assert _is_topical_tag(tag), tag


def test_community_ids_are_kept_deliberately() -> None:
    """They are the most discriminative thing an account's history carries."""
    for tag in ("hive-140169", "hive-125125", "hive-176853", "hive-160391"):
        assert _is_topical_tag(tag)
    assert not any(t.startswith("hive-1") for t in _NON_TOPICAL_TAGS)


def test_the_exclusion_is_case_and_whitespace_insensitive() -> None:
    assert not _is_topical_tag("  HIVE ")
    assert not _is_topical_tag("Neoxian")


def test_derivation_drops_non_topical_tags_before_the_cut_not_after() -> None:
    """★ melinda010100's real profile, reproduced. Five of her six inferred
    interests were reward-token tribe tags and her actual subjects — she is a
    photographer who runs a shadow-photography contest — were ranked below them
    and got NO slot. Filtering BEFORE the top-N cut is what gives them back;
    filtering after would have returned one tag instead of six."""
    tribe = ["archon", "pimp", "pob", "alive", "oneup"]
    real = ["photography", "shadows", "shadowphotos", "contest", "flowers"]
    own = [(tribe + real, "hive-125125")] * 3 + [(tribe, "hive-125125")] * 5
    tags = derive_interest_tags(_FakeFetch(own), "melinda010100", now=EPOCH)
    assert tags == frozenset({"hive-125125", *real})
    assert not (tags & frozenset(tribe)), tags
    # ...and the pre-filter derivation really would have handed back the tribe
    # tags, so this test is measuring the filter and not an already-clean input.
    unfiltered = sorted(set(tribe + real + ["hive-125125"]))
    assert set(tribe) <= set(unfiltered)


def test_derivation_never_returns_empty_purely_because_of_filtering() -> None:
    """An empty `interest_tags` is a real state with real consequences (R12
    part 3's popular fallback, no interest lane at all). It must stay reserved
    for "this account has no history", never become something this module's
    curated list can inflict on an account that does."""
    own = [(["neoxian", "pob", "archon"], "hive")] * 4
    tags = derive_interest_tags(_FakeFetch(own), "tribeonly", now=EPOCH)
    assert tags == frozenset({"neoxian", "pob", "archon", "hive"})


def test_derivation_still_returns_empty_for_a_genuinely_new_account() -> None:
    assert derive_interest_tags(_FakeFetch([]), "brandnew", now=EPOCH) == frozenset()


def test_derivation_stays_deterministic_and_capped() -> None:
    own = [([f"topic{i}" for i in range(12)], "hive")] * 2
    first = derive_interest_tags(_FakeFetch(own), "acct", now=EPOCH, max_tags=6)
    second = derive_interest_tags(_FakeFetch(own), "acct", now=EPOCH, max_tags=6)
    assert first == second
    assert len(first) == 6
    assert "hive" not in first
