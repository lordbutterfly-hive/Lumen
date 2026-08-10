/**
 * Days 1–7 of the week. Day 1 sets interests and leaves a baseline. Every day
 * after that is a real session as the SAME reader: read, vote, follow, comment,
 * write, check topics, scroll — varied like an actual person's week, with
 * quick days and long-sit days.
 *
 * Usage:  NODE_EXTRA_CA_CERTS=$PWD/.tls/cert.pem node qa/harness/week-run.mjs <day>
 *
 * Each day appends to /tmp/week/journal.json. Days after 1 read that journal
 * to know who has already been followed, what's already been commented, and
 * what's already been posted — so follow/comment targets never repeat and
 * later days can check persistence.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  session,
  handleInterestPicker,
  assertPopulated,
  snapshotFeed,
  readPost,
  votePost,
  voteByKeyword,
  followAuthor,
  followState,
  commentOnPost,
  commentStillThere,
  writeComposerPost,
  writeFullEditorPost,
  postStillOnProfile,
  scrollDeep,
  visitTopic,
  goHome,
  goToFollowing,
  record,
  sleep,
  OUT
} from './week.mjs';

const DAY = process.argv[2] || '1';
const KEY = '0x77aa' + 'c3'.repeat(30); // the same reader, every day
const INTERESTS = ['photography', 'food', 'travel'];
// Same three interests, used consistently everywhere a post needs to be judged
// "on-theme" — for voting, for following, and later for the report's own
// scoring of the feed.
const INTEREST_RE =
  /photo|photograph|camera|lens|monomad|snap\b|shot|picture|food|recipe|cook|cuisine|meal|dish|cake|bak|breakfast|lunch|dinner|coffee|bread|kitchen|travel|trip|trek|journey|hike|voyage|destination|explore|wander|abroad/i;

function loadJournal() {
  const p = path.join(OUT, 'journal.json');
  if (!fs.existsSync(p)) return { days: [], failures: [] };
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
const prior = loadJournal();
const followedSoFar = [...new Set(prior.days.flatMap((d) => d.followedAuthors || []))];
const commentsSoFar = prior.days.flatMap((d) => d.comments || []);
const postsSoFar = prior.days.flatMap((d) => d.postsWritten || []);

const { browser, page, username, net } = await session(KEY, `day${DAY}`);
const day = { day: DAY, username, actions: [], followedAuthors: [], comments: [], postsWritten: [] };

/** Following tab: assertPopulated once we've followed someone; honest empty-state otherwise. */
async function checkFollowingTab(expectedFollowed) {
  await goToFollowing(page);
  if (expectedFollowed.length > 0) {
    const fc = await assertPopulated(
      page,
      `day ${DAY} Following tab (should show posts from: ${expectedFollowed.join(', ')})`
    );
    const followSnap = await snapshotFeed(page, `day${DAY}-following`);
    const authors = [...new Set(followSnap.posts.map((p) => p.author))];
    day.followingTab = { count: fc, authors, expectedFollowed, matched: expectedFollowed.filter((u) => authors.includes(u)) };
  } else {
    const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
    day.followingTab = { count: 0, emptyStateText: body.slice(0, 250), expectedFollowed: [] };
  }
}

/** Visit /topics/<tag> for each interest and hard-gate on it being populated. */
async function checkTopics() {
  const topics = {};
  for (const t of INTERESTS) {
    await visitTopic(page, t);
    const c = await assertPopulated(page, `day ${DAY} topic page /topics/${t}`);
    topics[t] = c;
  }
  day.topics = topics;
}

try {
  await goHome(page);
  const picker = await handleInterestPicker(page, DAY === '1' ? INTERESTS : []);
  day.picker = picker;
  if (picker.appeared) await goHome(page);

  // ★ THE HARD GATE. A reader who opens the app and sees nothing has no week.
  const n = await assertPopulated(page, `day ${DAY} home feed on arrival`);
  day.feedCount = n;

  const snap = await snapshotFeed(page, `day${DAY}`);
  day.snapshot = { count: snap.count, authors: [...new Set(snap.posts.map((p) => p.author))].length };

  if (DAY === '1') {
    // Baseline day — already run once. Kept identical so re-running is safe.
    day.actions.push({ read: await readPost(page, 0) });
    await assertPopulated(page, `day ${DAY} home feed after reading a post`);
    day.actions.push({ vote: await votePost(page, 1) });
    day.actions.push({ read2: await readPost(page, 2) });
  } else if (DAY === '2') {
    // Quick look.
    day.actions.push({ read: await readPost(page, 0) });
    await goHome(page);
    const votes = await voteByKeyword(page, INTEREST_RE, 2);
    day.actions.push({ votesByKeyword: votes });

    const candidate =
      votes.find((v) => v.author && !v.alreadyVoted && !followedSoFar.includes(v.author)) ||
      snap.posts.find((p) => INTEREST_RE.test(p.title) && !followedSoFar.includes(p.author));
    if (candidate) {
      const f = await followAuthor(page, candidate.author);
      day.actions.push({ follow: f });
      if (f.followed) day.followedAuthors.push(candidate.author);
    }

    await checkFollowingTab([...followedSoFar, ...day.followedAuthors]);
    await checkTopics();
  } else if (DAY === '3') {
    // Long sit.
    day.actions.push({ read0: await readPost(page, 0) });
    await goHome(page);
    day.actions.push({ read1: await readPost(page, 1) });
    await goHome(page);
    day.actions.push({ read2: await readPost(page, 2) });
    await goHome(page);
    await assertPopulated(page, `day ${DAY} home feed after reading 3 posts`);

    const votes = await voteByKeyword(page, INTEREST_RE, 2);
    day.actions.push({ votesByKeyword: votes });

    const snapNow = await snapshotFeed(page, `day${DAY}-precomment`);
    const commentTarget = snapNow.posts.find((p) => INTEREST_RE.test(p.title));
    if (commentTarget) {
      const path_ = `/${commentTarget.category}/@${commentTarget.author}/${commentTarget.permlink}`;
      const text = `This is lovely — ${/cake|bak|recipe|dish|cook|food/i.test(commentTarget.title) ? 'saving this recipe for the weekend, thank you for sharing' : 'really makes me want to get out and shoot more this week'}. (qa day${DAY} ${Date.now().toString(36)})`;
      const c = await commentOnPost(page, path_, text);
      day.actions.push({ comment: { ...c, path: path_, text } });
      if (c.commented && c.appeared) day.comments.push({ path: path_, text });
    }
    await goHome(page);

    const already1 = [...followedSoFar, ...day.followedAuthors];
    const followCandidates = snapNow.posts.filter((p) => INTEREST_RE.test(p.title) && !already1.includes(p.author));
    for (const cand of followCandidates.slice(0, 2)) {
      const f = await followAuthor(page, cand.author);
      day.actions.push({ follow: f });
      if (f.followed) day.followedAuthors.push(cand.author);
    }

    await checkFollowingTab([...followedSoFar, ...day.followedAuthors]);

    await goHome(page);
    const scroll1 = await scrollDeep(page, 8);
    day.actions.push({ scrollDeep1: scroll1 });
  } else if (DAY === '4') {
    // Quick persistence check.
    const followChecks = [];
    for (const u of followedSoFar) followChecks.push(await followState(page, u));
    day.followPersistence = followChecks;

    const commentChecks = [];
    for (const c of commentsSoFar) commentChecks.push({ ...c, stillThere: await commentStillThere(page, c.path, c.text) });
    day.commentPersistence = commentChecks;

    await goHome(page);
    const votes = await voteByKeyword(page, INTEREST_RE, 2);
    day.actions.push({ votesByKeyword: votes });

    await checkFollowingTab(followedSoFar);
  } else if (DAY === '5') {
    // Write day #1 (short composer).
    day.actions.push({ read: await readPost(page, 0) });
    await goHome(page);
    day.actions.push({ read2: await readPost(page, 1) });
    await goHome(page);

    const postText = `Coffee on the balcony this morning while I plan next month's trip — half tempted to build the whole itinerary around food markets and golden-hour photo walks. Anyone here shoot street or food photography while travelling? (qa day${DAY} ${Date.now().toString(36)})`;
    const w = await writeComposerPost(page, postText);
    day.actions.push({ writeComposer: w });
    const onProfile = await postStillOnProfile(page, username, postText);
    day.actions.push({ writeComposerOnProfile: onProfile });
    if (onProfile) day.postsWritten.push({ type: 'composer', text: postText });

    await goHome(page);
    const votes = await voteByKeyword(page, INTEREST_RE, 2);
    day.actions.push({ votesByKeyword: votes });

    const already2 = [...followedSoFar, ...day.followedAuthors];
    const snapNow = await snapshotFeed(page, `day${DAY}-follow-candidates`);
    const cand = snapNow.posts.find((p) => INTEREST_RE.test(p.title) && !already2.includes(p.author));
    if (cand) {
      const f = await followAuthor(page, cand.author);
      day.actions.push({ follow: f });
      if (f.followed) day.followedAuthors.push(cand.author);
    }

    await checkFollowingTab([...followedSoFar, ...day.followedAuthors]);
  } else if (DAY === '6') {
    // Comment #2 + scroll #2.
    await goHome(page);
    const snapNow = await snapshotFeed(page, `day${DAY}-precomment`);
    const already3 = [...followedSoFar, ...day.followedAuthors];
    const usedPaths = new Set(commentsSoFar.map((c) => c.path));
    const commentTarget = snapNow.posts.find(
      (p) => INTEREST_RE.test(p.title) && !usedPaths.has(`/${p.category}/@${p.author}/${p.permlink}`)
    );
    if (commentTarget) {
      const path_ = `/${commentTarget.category}/@${commentTarget.author}/${commentTarget.permlink}`;
      const text = `Second time back to this one — still one of my favourites in the feed this week. (qa day${DAY} ${Date.now().toString(36)})`;
      const c = await commentOnPost(page, path_, text);
      day.actions.push({ comment2: { ...c, path: path_, text } });
      if (c.commented && c.appeared) day.comments.push({ path: path_, text });
    }

    await goHome(page);
    const scroll2 = await scrollDeep(page, 8);
    day.actions.push({ scrollDeep2: scroll2 });

    const votes = await voteByKeyword(page, INTEREST_RE, 2);
    day.actions.push({ votesByKeyword: votes });

    const cand = snapNow.posts.find((p) => INTEREST_RE.test(p.title) && !already3.includes(p.author));
    if (cand) {
      const f = await followAuthor(page, cand.author);
      day.actions.push({ follow: f });
      if (f.followed) day.followedAuthors.push(cand.author);
    }

    const commentChecks = [];
    for (const c of commentsSoFar) commentChecks.push({ ...c, stillThere: await commentStillThere(page, c.path, c.text) });
    day.commentPersistence = commentChecks;
    const postChecks = [];
    for (const p of postsSoFar) postChecks.push({ text: p.text.slice(0, 40), still: await postStillOnProfile(page, username, p.text) });
    day.postPersistence = postChecks;

    await checkFollowingTab([...followedSoFar, ...day.followedAuthors]);
  } else if (DAY === '7') {
    // Final day: write #2 (full editor) + full persistence sweep + long sit.
    day.actions.push({ read: await readPost(page, 0) });
    await goHome(page);
    day.actions.push({ read2: await readPost(page, 2) });
    await goHome(page);

    const title = 'Three years since I picked up a camera';
    const body = `Getting into photography completely changed how I travel. Now I plan trips around golden hour, and I make a point of finding the best local food markets to shoot before I eat at them. Anyone else here shoot street or food photography while travelling — would love recommendations for next month. (qa day${DAY} ${Date.now().toString(36)})`;
    const w = await writeFullEditorPost(page, title, body);
    day.actions.push({ writeFullEditor: w });
    const onProfile = await postStillOnProfile(page, username, title);
    day.actions.push({ writeFullEditorOnProfile: onProfile });
    if (onProfile) day.postsWritten.push({ type: 'full-editor', text: title });

    await goHome(page);
    const votes = await voteByKeyword(page, INTEREST_RE, 2);
    day.actions.push({ votesByKeyword: votes });

    // One more follow, from a scrolled (deeper) snapshot — days 2/3/5 only ever
    // searched the first page, so candidates past position 30 (like daveks /
    // worldmappin, seen fresh-voted on day 6) were never reachable as follow
    // candidates. Round the week out at 4 distinct followed authors.
    const already4 = [...followedSoFar, ...day.followedAuthors];
    await scrollDeep(page, 4);
    const deepSnap = await snapshotFeed(page, `day${DAY}-follow-candidates`);
    const cand4 = deepSnap.posts.find((p) => INTEREST_RE.test(p.title) && !already4.includes(p.author));
    if (cand4) {
      const f = await followAuthor(page, cand4.author);
      day.actions.push({ follow: f });
      if (f.followed && !f.alreadyFollowing) day.followedAuthors.push(cand4.author);
    }

    const allFollowed = [...followedSoFar, ...day.followedAuthors];
    const followChecks = [];
    for (const u of allFollowed) followChecks.push(await followState(page, u));
    day.followPersistence = followChecks;

    const commentChecks = [];
    for (const c of commentsSoFar) commentChecks.push({ ...c, stillThere: await commentStillThere(page, c.path, c.text) });
    day.commentPersistence = commentChecks;

    const postChecks = [];
    for (const p of postsSoFar) postChecks.push({ text: p.text.slice(0, 40), still: await postStillOnProfile(page, username, p.text) });
    day.postPersistence = postChecks;

    await checkFollowingTab(allFollowed);
    await checkTopics();
  }

  day.ok = true;
} catch (e) {
  day.ok = false;
  day.error = String(e.message).slice(0, 2000);
  console.error('\n*** RUN HALTED ***\n' + day.error);
} finally {
  day.net = net.slice(-30);
  record(day);
  await browser.close();
}
console.log(
  `\nday ${DAY}: ${day.ok ? 'OK' : 'FAILED'}  feed=${day.feedCount ?? 0} posts  followed+=${day.followedAuthors.length}  comments+=${day.comments.length}  posts+=${day.postsWritten.length}`
);
