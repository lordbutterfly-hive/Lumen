# Charter: the social graph, end to end

## Mission
Follow people — Lumen accounts AND ordinary Hive accounts — and see whether the
Following feed, the counts, and the buttons all agree with each other. This feed
was rebuilt today and no tester has ever driven it.

## Risk oracles
- **The feed disagrees with who you follow.** Someone you followed is missing,
  someone you unfollowed is still there, or the ordering is not newest-first.
- **A count that contradicts a list.** Followers/Following numbers versus what
  the lists and feeds actually contain.
- **Follow does not survive.** A reload, a sign-out and back in, or a second tab.
- **Both kinds of author.** A Lumen author and a Hive author must both be
  followable and both appear. If only one kind shows up, say which.
