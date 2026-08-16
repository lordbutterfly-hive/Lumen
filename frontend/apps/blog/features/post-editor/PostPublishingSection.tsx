"use client";

import { UseFormReturn } from "react-hook-form";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@hive/ui/components/select";
import { FormControl, FormField, FormItem } from "@hive/ui/components/form";
import { Progress } from "@ui/components/progress";
import { Icons } from "@ui/components/icons";
import { withBasePath } from "@ui/lib/path-utils";
import { isCommunity } from "@ui/lib/utils";
import { DEFAULT_OBSERVER } from "@/blog/lib/utils";
import { getCommunity, getSubscriptions } from "@transaction/lib/bridge-api";
import { useTranslation } from "@/blog/i18n/client";
import { AdvancedSettingsPostForm } from "@/blog/features/post-editor/advanced-settings-post-form";
import { useLoggedUserContext } from "@/blog/features/votes/hooks/use-logged-user";
import { useUserClient } from "@smart-signer/lib/auth/use-user-client";
import { Entry } from "@hive/common-hiveio-packages/wax";
import { AccountFormValues } from "@/blog/features/post-editor/types";

/**
 * Lumen-specific copy. Follows the convention set by the other lite surfaces
 * (`user-menu.tsx`): Lumen strings live next to their component until the whole
 * lite vocabulary is translated in one pass, rather than half-populating nine
 * locale files.
 */
const LITE_REWARDS_NOTE =
  'Lumen posts decline rewards. Upgrade to a Hive account to start earning on what you write.';

/**
 * The Resource Credits gauge, in words. Same convention as LITE_REWARDS_NOTE
 * above — Lumen/newcomer copy lives beside its component until the whole
 * vocabulary is translated in one pass. `submit_page.account_stats` ("Account
 * stats:") is deliberately no longer used here: it labelled the bar without ever
 * saying what the bar measured.
 */
const RC_LABEL = 'Resource Credits';
/**
 * ★ NO DASHES IN LUMEN COPY (2026-08-10, C-7). This sentence carried an em dash,
 * which the house style does not use anywhere. Split into two sentences, which
 * also reads better out loud. Same words, same promise.
 */
const RC_EXPLAINER =
  'Your Hive account’s free allowance for posting, commenting and voting. It refills on its own over time, so you only have to wait if it runs low.';

interface PostPublishingSectionProps {
  form: UseFormReturn<AccountFormValues>;
  username: string;
  observer: string;
  editMode: boolean;
  post_s?: Entry;
  watchedValues: AccountFormValues;
  storedPost: AccountFormValues;
  storePost: (value: AccountFormValues) => void;
  categoryParam?: string;
  handleLoadTemplate: (data: AccountFormValues) => void;
}

export function PostPublishingSection({
  form,
  username,
  observer,
  editMode,
  post_s,
  watchedValues,
  storedPost,
  storePost,
  categoryParam,
  handleLoadTemplate,
}: PostPublishingSectionProps) {
  const { t } = useTranslation("common_blog");
  const router = useRouter();
  const { manabarsData } = useLoggedUserContext();
  const { user } = useUserClient();
  // A Lumen lite post declines all rewards on chain (decision 2026-07-23) and the
  // lite submit path forwards none of these fields, so showing payout type,
  // maximum payout or beneficiaries would collect settings that are silently
  // dropped. Resource Credits are equally meaningless: a lite account has no Hive
  // account to spend them from — the publishing account pays.
  const isLite = user?.account_tier === "lite";

  const { data: communityData } = useQuery({
    queryKey: ["community", categoryParam, observer],
    queryFn: () => getCommunity(categoryParam ?? storedPost.category, observer),
    enabled: isCommunity(categoryParam) || isCommunity(storedPost.category),
  });

  const { data: mySubsData } = useQuery({
    queryKey: ["subscriptions", observer],
    queryFn: () => getSubscriptions(observer),
    enabled: observer !== DEFAULT_OBSERVER,
  });

  const communityPosting =
    mySubsData && mySubsData?.filter((e) => e[0] === categoryParam).length > 0
      ? mySubsData?.filter((e) => e[0] === categoryParam)[0][0]
      : undefined;

  return (
    <div className="flex flex-col gap-4 rounded-[14px] border border-[#ebebeb] bg-white p-4">
      {/* Same one section-label treatment as the metadata card, which is the
          masthead eyebrow. See PostMetadataSection.tsx for the reasoning (C-14).
          ★ `ink-brand-6`, not `#c0392b` (2026-08-14). */}
      <span className="text-[12px] leading-[18px] font-semibold uppercase tracking-[0.14em] text-ink-brand-6/70 dark:text-ink-brand-6">
        {t("submit_page.publishing_section")}
      </span>

      {isLite ? (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">{t("submit_page.author_rewards")}</span>
          <span className="text-xs text-muted-foreground" data-testid="lite-rewards-description">
            {LITE_REWARDS_NOTE}
          </span>
        </div>
      ) : !editMode ? (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">{t("submit_page.post_options")}</span>

          {watchedValues.maxAcceptedPayout < 1000000 && watchedValues.maxAcceptedPayout > 0 ? (
            <span className="text-xs text-muted-foreground">
              {t("submit_page.advanced_settings_dialog.maximum_accepted_payout")}:{" "}
              {watchedValues.maxAcceptedPayout} HBD
            </span>
          ) : null}

          {watchedValues.beneficiaries.length > 0 ? (
            <span className="text-xs text-muted-foreground">
              {t("submit_page.advanced_settings_dialog.beneficiaries", {
                num: watchedValues.beneficiaries.length,
              })}
            </span>
          ) : null}

          <span className="text-xs text-muted-foreground" data-testid="author-rewards-description">
            {t("submit_page.author_rewards")}
            {watchedValues.maxAcceptedPayout === 0
              ? ` ${t("submit_page.advanced_settings_dialog.decline_payout")}`
              : watchedValues.payoutType === "100%"
                ? t("submit_page.power_up")
                : " 50% HBD / 50% HP"}
          </span>
          <AdvancedSettingsPostForm
            username={username}
            updateForm={(e) => handleLoadTemplate(e)}
            data={watchedValues}
          >
            {/* ★ A THIRD PLAIN-TEXT CONTROL (2026-08-10, alongside C-11). This
                was a bare <span>: not a button, not focusable, and inside a
                <form>, so nothing but the cursor said it could be clicked. It
                is now a real button on the house 14px radius. `type="button"`
                matters: it lives inside the post form and a default-type button
                would submit it. */}
            <button
              type="button"
              // ★ `line-brand-10` / `ink-brand-6`, not `#c0392b` (2026-08-14):
              // rgb(192,57,43), byte-identical to the literal in light mode.
              className="inline-flex w-fit items-center gap-1.5 rounded-[14px] border border-[#ebebeb] bg-white px-3 py-1.5 text-xs font-medium text-[#6b7280] transition-colors hover:border-line-brand-10 hover:text-ink-brand-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line-brand-10/40"
              title={t("submit_page.advanced_tooltip")}
              data-testid="advanced-settings-button"
            >
              <Icons.settings className="h-3.5 w-3.5" aria-hidden />
              {t("submit_page.advanced_settings")}
            </button>
          </AdvancedSettingsPostForm>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {post_s && parseFloat(post_s.max_accepted_payout) === 0 ? (
            /* ★ LOW 11 (2026-08-16) — this branch used to render the bare
               "Author rewards:" label (see the identical-looking label still
               kept below, in the sibling branch, where it labels the Select)
               above a disconnected second line giving the actual value —
               "Payout has been declined and cannot be changed". No Select
               renders when payout is already final, so nothing needed that
               label's `id`, and a label with no value beside it just read as
               broken copy. One line now carries both. */
            <span className="text-xs text-muted-foreground">
              {t("submit_page.author_rewards")} {t("submit_page.reward_options_final")}
            </span>
          ) : (
            <>
              <span className="text-sm font-medium" id="post-publishing-reward-type-label">
                {t("submit_page.author_rewards")}
              </span>
              <FormField
                control={form.control}
                name="payoutType"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <Select
                        value={field.value}
                        onValueChange={(value) => {
                          field.onChange(value);
                          if (value === "0%") {
                            form.setValue("maxAcceptedPayout", 0);
                          } else if (watchedValues.maxAcceptedPayout === 0) {
                            form.setValue(
                              "maxAcceptedPayout",
                              post_s ? Number(post_s.max_accepted_payout.split(" ")[0]) : 1000000
                            );
                          }
                        }}
                      >
                        {/* Radix's SelectTrigger is role="combobox" and does not get an
                            accessible name from its own visible content (verified via the
                            a11y tree — same class as the four Preferences comboboxes,
                            `apps/blog/features/account-settings/form.tsx`). The visible
                            "Author rewards:" label directly above already labels this
                            control for sighted users; `aria-labelledby` wires the same
                            text in for the accessibility tree instead of duplicating it. */}
                        <SelectTrigger
                          className="w-[180px]"
                          data-testid="edit-reward-type-select"
                          aria-labelledby="post-publishing-reward-type-label"
                        >
                          <SelectValue>
                            {field.value === "50%" && "50% HBD / 50% HP"}
                            {field.value === "100%" && t("submit_page.power_up")}
                            {field.value === "0%" &&
                              t("submit_page.advanced_settings_dialog.decline_payout")}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {post_s && post_s.percent_hbd === 10000 && (
                            <SelectItem value="50%">50% HBD / 50% HP</SelectItem>
                          )}
                          {post_s && post_s.percent_hbd >= 0 && (
                            <SelectItem value="100%">{t("submit_page.power_up")}</SelectItem>
                          )}
                          {(!post_s || post_s.net_rshares <= 0) && (
                            <SelectItem value="0%">
                              {t("submit_page.advanced_settings_dialog.decline_payout")}
                            </SelectItem>
                          )}
                        </SelectContent>
                      </Select>
                    </FormControl>
                  </FormItem>
                )}
              />
              <span className="text-xs text-muted-foreground">
                {t("submit_page.reward_options_restrictive")}
              </span>
            </>
          )}
        </div>
      )}

      {/* ★ NAME THE GAUGE, DON'T JUST NUMBER IT (2026-08-08, UX tester).
          This was a bare bar under "Account stats:" with "42% RC" beside it.
          "RC" is a Hive-native abbreviation a newcomer has never met, and a
          percentage with no unit and no explanation is not information — the
          tester read it as an unexplained meter next to the Publish button.
          Spelling out "Resource Credits" and saying in one line what they are
          costs two rows in a column that has room for them. Still hidden for a
          Lumen account, which has no Hive account and therefore no RC of its
          own — see LITE_REWARDS_NOTE for the same reasoning about rewards. */}
      {isLite ? null : (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">{RC_LABEL}</span>
          <div className="flex items-center gap-3">
            {/* ★ THE ONE BLUE THING IN LUMEN (2026-08-10, C-6). This bar was
                `bg-[#0088FE]`, measured live as rgb(0,136,254) — a chart blue
                inherited from somewhere else entirely. Blue appears nowhere
                else in the product, so a gauge next to the Publish button was
                the single loudest off-palette element on the page. Brand red
                brand red for the fill, #ebebeb for the track, which is the
                same pair every other bordered surface here uses.
                ★ `bg-surface-brand-12`, not `#c0392b` (2026-08-14
                token-migration pass) — rgb(192,57,43), byte-identical to the
                literal in light mode. */}
            <Progress
              value={manabarsData?.rc.percentageValue ?? 0}
              className="h-2 flex-1 bg-[#ebebeb]"
              indicatorClassName="bg-surface-brand-12"
            />
            <span
              className="text-xs tabular-nums text-muted-foreground"
              data-testid="resource-credits-description"
            >
              {manabarsData?.rc.percentageValue ?? 0}%
            </span>
          </div>
          <span className="text-xs text-muted-foreground">{RC_EXPLAINER}</span>
        </div>
      )}

      {!editMode ? (
        <FormField
          control={form.control}
          name="category"
          render={() => (
            <FormItem>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className="text-muted-foreground" id="post-publishing-posting-to-label">
                  {t("submit_page.posting_to")}
                </span>
                <FormControl>
                  <Select
                    value={
                      communityPosting
                        ? communityPosting
                        : storedPost?.category
                          ? storedPost.category
                          : "blog"
                    }
                    onValueChange={(e) => {
                      form.setValue("category", e);
                      storePost({ ...storedPost, category: e });
                      if (categoryParam) {
                        router.replace(withBasePath("/submit.html"));
                      }
                    }}
                  >
                    <FormControl>
                      {/* Same class as the reward-type SelectTrigger above: role="combobox"
                          does not get an accessible name from content (verified via the
                          a11y tree). The "Posting to:" span right beside this control
                          already labels it visibly; `aria-labelledby` wires that same text
                          in for the accessibility tree. */}
                      <SelectTrigger
                        className="w-auto min-w-[140px]"
                        data-testid="posting-to-list-trigger"
                        aria-labelledby="post-publishing-posting-to-label"
                      >
                        <SelectValue placeholder="Select category" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="blog">{t("submit_page.my_blog")}</SelectItem>
                      <SelectGroup className="py-2 ml-2">
                        {t("submit_page.my_communities")}
                      </SelectGroup>
                      {mySubsData?.map((e) => (
                        <SelectItem key={e[0]} value={e[0]}>
                          {e[1]}
                        </SelectItem>
                      ))}
                      {!mySubsData?.some((e) => e[0] === storedPost.category) &&
                      storedPost.category !== "blog" ? (
                        <>
                          <SelectGroup>{t("submit_page.others_communities")}</SelectGroup>
                          <SelectItem value={communityData?.name ?? storedPost.category}>
                            {communityData?.title}
                          </SelectItem>
                        </>
                      ) : null}
                    </SelectContent>
                  </Select>
                </FormControl>
              </div>
            </FormItem>
          )}
        />
      ) : null}
    </div>
  );
}
