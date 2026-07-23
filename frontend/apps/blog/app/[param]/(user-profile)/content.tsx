'use client';

import ProfileGrid from '@/blog/features/account-profile/redesign/profile-grid';

// Root `/@username` page — the redesigned profile (design-handoff-v2,
// Profile.dc.html). ProfileGrid supplies its own cover/identity/stats/tabs
// and fetches its own Posts-tab data, so this no longer renders the legacy
// PostsContent('blog') directly; ProfileMain -> ProfileTabs -> ProfilePostsList
// still reuses the same `getAccountPosts('blog', ...)` bridge call.
const Content = () => <ProfileGrid />;

export default Content;
