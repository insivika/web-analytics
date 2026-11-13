# ROI measurements, November 2026

Read-only queries against the production Umami database (website `19a70b61-1c6c-449c-8b83-197db764884f`), run 2026-11-12 23:10 UTC; sections 3 to 5 were added from follow-up queries later the same day. All dates are UTC. Internal users: none appear in these events (`is_internal` is `false` on every one). Samples are small, so every rate has its counts beside it.

## 1. Onboarding skips (mobile app, 2026-10-08 to 2026-11-12)

**About one in four mobile signups skipped all three setup steps (23 of 93 with full step data, 25%), and about one in three started with no seeded calendar (36 of 105, 34%).**

### How a skip is recorded

`onboarding_step_completed` carries `step` (0 = starting balance, 1 = paycheck, 2 = bills) and a boolean `skipped`. From app version 1.13.0 it also carries `skip_reason`: `skip_link` (tapped Skip), `empty_continue` (tapped Continue with nothing entered) or `no_regular_paycheck` (step 1 only). So a skip can be told apart from an answer on every version. `onboarding_step_viewed` carries only `step`.

### Funnel

One row per person: `install_id` where the app sends it (from 2026-10-23), otherwise the Umami session.

| Stage | iOS | Android | Both |
|---|---|---|---|
| Saw the intro (`onboarding_intro_viewed`) | 170 | 193 | 363 |
| Tapped start (`onboarding_started`) | 112 | 69 | 181 |
| Finished step 0, balance | 103 | 60 | 163 |
| Finished step 1, paycheck | 95 | 56 | 151 |
| Finished step 2, bills | 85 | 54 | 139 |
| Signed up (`onboarding_signup_completed`), of those who tapped start | 61 | 33 | 94 |
| Signed up, all (includes people whose start was not linked) | 66 | 39 | 105 |

Finishing a step includes skipping it. Android looks far worse than iOS before the first question (69 of 193 tapped start, against 112 of 170), but about half of Android's intro views are automated test installs, not people: see section 3. The real loss is between the last question and the account: 94 of 139 (68%) signed up.

### Skips among people who signed up

Of the 105 signups, 93 have a completion event for all three steps; the other 12 could not be linked to their steps.

| Of signups with all three steps | iOS (60) | Android (33) | Both (93) |
|---|---|---|---|
| Skipped starting balance | 21 | 12 | 33 (35%) |
| Skipped paycheck | 23 | 11 | 34 (37%) |
| Skipped bills | 25 | 13 | 38 (41%) |
| Skipped all three | 15 | 8 | 23 (25%) |
| Answered all three | 26 | 16 | 42 (45%) |

### Seeded or empty

Whole period, server-side `onboarding_seed_saved` against signups (not linked person to person):

| | iOS | Android | Both |
|---|---|---|---|
| Signups | 66 | 39 | 105 |
| Got a seeded calendar | 46 | 23 | 69 (66%) |
| No seed | 20 | 16 | 36 (34%) |

Signups from 2026-10-24 on can be linked to their user id (through `install_id`), which gives the rest:

| Linked signups, 2026-10-24 to 2026-11-12 | iOS (49) | Android (28) | Both (77) |
|---|---|---|---|
| Seeded (`onboarding_seed_saved`) | 37 | 19 | 56 (73%) |
| Empty (no seed) | 12 | 9 | 21 (27%) |
| Had a seed failure (`onboarding_seed_failed`) | 1 | 1 | 2 |
| Reached `activation_complete` | 15 | 7 | 22 (29%) |

The 21 empty starts are 14 who skipped all three steps, 3 who answered something but got no seed (the 2 seed failures, both `http_400`, are among them and neither was saved later), and 4 with no step data. Nobody who skipped all three got a seed. `first_calendar_opened` agrees: 21 of 77 opened with `seeded = false`, 22 with zero items.

### Empty versus seeded: did they come back?

Linked signups made before 2026-11-11, so each has had at least one later day (70 of the 77).

| | Signups | Came back on a later day | Reached `activation_complete` |
|---|---|---|---|
| Seeded, both platforms | 50 | 21 (42%) | 19 (38%) |
| Empty, both platforms | 20 | 3 (15%) | 2 (10%) |
| Seeded, iOS | 33 | 16 | 13 |
| Empty, iOS | 11 | 1 | 1 |
| Seeded, Android | 17 | 5 | 6 |
| Empty, Android | 9 | 2 | 1 |

"Came back" means any event carrying the user's id with `days_since_signup` of 1 or more, leaving out `trial_ended`, `subscription_renewed` and `subscription_canceled`.

### Caveats

- The comparison is not an experiment. People who skip every question are likely less interested to begin with, so the gap (42% against 15%) is an upper bound on what seeding itself does.
- Returns are undercounted for both groups. The server records activity only on writes, and the app sends few events on a plain open, so someone who opened the app and only looked is not counted.
- 20 empty starts is a small group; 3 returns could easily have been 1 or 6.
- Before 2026-10-23 the app sent no `install_id`, so a person is a Umami session there; a network change mid-onboarding splits one person into two. That inflates the early funnel rows slightly and explains most of the 12 signups without step data.
- Outcome tables cover only signups from 2026-10-24, when `first_calendar_opened` and `install_id` arrived. The 28 earlier signups cannot be tied to a user id.
- The low Android start rate is mostly automated installs, checked in section 3. The Android "saw the intro" row above overstates real people by about half.

## 2. Measured tap-to-signup on Android

**The sample is too small to replace the assumed 0.2: Android signups first carried UTM values on 2026-11-11, there is no complete day after it yet, and the two partial days hold 2 paid Google Play taps and 1 paid Android signup.**

### Counts

Paid visits are classified as in `getRoi.ts`: first pageview of a session on `www.cashflowcalendar.app`; Google by `gclid` or source `google` with a paid medium; Meta by a paid medium with a Meta source; app paths and bot countries (SG, CN) left out.

| 2026-11-11 and 2026-11-12 (both partial days) | Google | Meta | Both |
|---|---|---|---|
| Paid visits | 24 | 13 | 37 |
| Paid sessions that tapped `google_play_button_click` | 2 | 0 | 2 |
| Android `signed_up` with paid UTM values | 1 | 0 | 1 |
| Android `signed_up`, all | | | 2 |

The first UTM-carrying Android signup arrived 2026-11-11 17:21 UTC (Google, `cpc`, campaign `clicks-usa`). The other Android signup since then carries `(not set)`, so the key is now present on every Android signup and an unpaid one can be told from a paid one. The ratio 1 of 2 means nothing at this size.

Paid Google Play taps before the UTMs existed, for the rate at which the sample will grow:

| 28 complete days, 2026-10-15 to 2026-11-11 | Google | Meta | Unpaid | All |
|---|---|---|---|---|
| Visits | 137 | 168 | 1,086 | 1,391 |
| Sessions that tapped Google Play | 10 | 16 | 19 | 45 |
| Android signups, any source | | | | 33 |

That is 26 paid taps in four weeks, about 6.5 a week, and uneven: 13 of Meta's 16 came in the single week of 2026-11-02.

### What value the data supports

None yet. Keep `DEFAULT_TAP_TO_SIGNUP = 0.2`.

- A rough first reading needs about 30 paid taps: about 5 more weeks at the current rate. A true rate of 0.2 would then show as about 6 signups, with a plausible range of roughly 0.08 to 0.38.
- A value worth putting in the model needs about 60 paid taps: about 9 more weeks, range roughly 0.11 to 0.32.
- Per channel takes about twice as long, since each channel gets about half the taps.

The 33 Android signups against 45 tapping sessions over the 28 days (0.73) is not a usable substitute: most of those signups come from Play search, which is the reason the model does not use that ratio.

### Caveats

- A tap and its signup are in different sessions (website, then app) and cannot be joined one to one. The ratio compares two counts over the same days.
- Installs can lag taps by days, so early taps in a window have signups outside it and early signups belong to taps before it. Use a window of several weeks and drop the last few days.
- People who install without tapping the site's button still carry paid UTMs if the Play referrer has them (for example an ad that links straight to Play), which would push the ratio up. People who tap, then find the app by searching Play, lose the referrer and push it down.
- iOS has no equivalent, so the measured value will be Android only and the model would apply it to App Store taps as well.
- 8 of the 45 Play taps in the 28 days (3 of the 26 paid ones) came from non-Android devices, which cannot install.

## 3. Android start rate (follow-up, 2026-10-23 to 2026-11-12)

**Android's low start rate is not real: 69 of the 131 Android installs that saw the intro came from Google's own data-centre regions, which is automated testing of each Play release, and among the rest Android starts the questions at least as often as iOS (48 of 62, against 76 of 115).**

One row per install (`install_id`, sent from 2026-10-23) that fired `onboarding_intro_viewed`, by the region of the session it fired in.

| | Installs | Started the questions | Logged in to an existing account | Left after the intro | Other |
|---|---|---|---|---|---|
| Android, Google data-centre regions | 69 | 2 | 33 | 33 | 1 |
| Android, everywhere else | 62 | 48 (77%) | 7 | 6 | 1 |
| iOS, everywhere else | 115 | 76 (66%) | 15 | 23 | 1 |
| iOS, Google data-centre regions | 4 | 4 | 0 | 0 | 0 |

The regions are the five US states that hold Google data centres and account for almost all Android installs that never start: Oregon, Georgia, Oklahoma, South Carolina and Iowa. One more iOS install has no region and started.

- The 33 logins from those regions are nearly all one account: 34 of the 40 Android "logged in" installs belong to a single user, who signed up more than 30 days ago. That fits the test login a Play Console pre-launch report uses. The account is not flagged `is_internal`, so its activity counts as a real user's everywhere.
- Leaving out people who logged in to an existing account, the start rate is 48 of 55 (87%) on Android and 76 of 100 (76%) on iOS.
- Only 2 of the 69 data-centre installs started the questions and 1 signed up, so the skip, seed and return figures in section 1 are not distorted by them. The funnel's Android "saw the intro" row is.

### Caveats

- Region is a proxy. A real person in one of those five states is counted as automated; the 2 that started and the 1 that signed up probably are real.
- This is inferred from where the sessions come from and from one account logging in on 34 installs, not from anything that says "test device". Confirming it means checking which account the Play Console pre-launch report is set to log in with.
- 9 of the 23 iOS installs that left after the intro are in California, which may include App Review, but that cannot be told from this data.

## 4. Other follow-up findings

**People who skip are the ones who do not sign up, and skipping takes seconds.**

Signup after the last question, by what was answered (people with all three step completions, 2026-10-08 on):

| | Finished the questions | Signed up |
|---|---|---|
| Answered all three | 52 | 42 (81%) |
| Answered some | 48 | 28 (58%) |
| Skipped all three | 41 | 23 (56%) |

Median time on a step (`ms_on_step`, from 2026-10-23):

| Step | Answered | Skipped |
|---|---|---|
| Balance | 13 s (79) | 5 s (93) |
| Paycheck | 24 s (84) | 6 s (50) |
| Bills | 107 s (71) | 3 s (63) |

- The signup screen works for people who answered: 81% of them create an account. The loss at that screen is mostly people who skipped.
- Seed failures: the Android user hit `http_400` on six separate days over 12 days (2026-10-24 to 2026-11-05), because the app resends the same answers on every launch. The iOS failure was on app 1.20.0 on 2026-11-06, so the cause is still live. Which validation rule rejects the answers is unknown: the app recorded only the status.
- The empty calendar already shows an "Add your paycheck" prompt (since app 1.13.0), and a signed-in user can reopen the questions from a push notification (since 2026-11-07). The 3 of 20 return rate was measured with the prompt live, and `onboarding_resumed_saved` has fired 0 times.

## 5. Actions

| Action | Why | Status on 2026-11-12 |
|---|---|---|
| Let people without a regular paycheck enter a rough monthly amount | 34 of 93 signups skipped the paycheck question through "I don't get a regular paycheck", the only way past it | insivika/cfc-app#218, open against `staging`, not run on a device |
| Record the server's reason when a seed is refused | The two `http_400` failures cannot be diagnosed | insivika/cfc-app#217, open against `staging`, not run on a device |
| Report the signup screen view and failed signup attempts | 45 people finished the questions and did not sign up, with no event to say where they left | Same pull request, #217 |
| Fix the seed refusal and stop resending refused answers | A user who answered still gets an empty calendar | Waiting for the first failure that carries `server_error` |
| Flag the Play test account as internal, and leave Google data-centre sessions out of funnel reports | 69 of 131 Android intro views are automated | Not started |
| Count paid Android signups directly on the ROI page instead of taps x 0.2 | Android `signed_up` now carries the ad's UTM values | Not started |
| Re-run the tap-to-signup query | About 60 paid Play taps are needed | Mid-January 2027 |
| Make the empty calendar's prompt reopen the questions | The existing prompt and push reminder are not bringing people back | Not started; decide after #218 ships |

## SQL

Run each statement inside `begin transaction read only; ... rollback;`. psql variables: `\set w '19a70b61-1c6c-449c-8b83-197db764884f'`, `\set since '2026-10-08'`, `\set from '2026-10-01'`. Each `select` below needs the `with` block of its section in front of it.

### Data keys on the onboarding events

```sql
select e.event_name, d.data_key, d.data_type, count(*) n, count(distinct d.string_value) distinct_values
from website_event e join event_data d on d.website_event_id = e.event_id
where e.website_id = :'w' and e.created_at >= :'since'
  and (e.event_name like 'onboarding%' or e.event_name in ('signed_up','first_calendar_opened','activation_complete'))
group by 1,2,3 order by 1,2;
```

### Funnel

```sql
with ev as (
 select e.event_id, e.event_name, e.session_id, e.created_at,
  max(d.string_value) filter (where d.data_key='platform') platform,
  max(d.string_value) filter (where d.data_key='install_id') iid,
  max(d.number_value) filter (where d.data_key='step') step
 from website_event e join event_data d on d.website_event_id=e.event_id
 where e.website_id=:'w' and e.created_at>=:'since' and e.event_type=2
  and e.hostname='app.cashflowcalendar.app' and e.event_name like 'onboarding%'
 group by 1,2,3,4),
m as (select *, coalesce(iid, session_id::text) person from ev where platform in ('ios','android')),
p as (
 select person, min(platform) platform,
  bool_or(event_name='onboarding_intro_viewed') intro,
  bool_or(event_name='onboarding_started') started,
  bool_or(event_name='onboarding_step_completed' and step=0) c0,
  bool_or(event_name='onboarding_step_completed' and step=1) c1,
  bool_or(event_name='onboarding_step_completed' and step=2) c2,
  bool_or(event_name='onboarding_signup_completed') signup
 from m group by 1)
select platform, count(*) filter (where intro) intro, count(*) filter (where started) started,
 count(*) filter (where started and c0) c0, count(*) filter (where started and c1) c1,
 count(*) filter (where started and c2) c2,
 count(*) filter (where started and signup) started_signup, count(*) filter (where signup) signup_any
from p group by rollup(1) order by 1;
```

### Signup cohort (skips, seed, activation, return)

```sql
with ev as (
 select e.event_id, e.event_name, e.session_id, e.created_at, e.hostname,
  max(d.string_value) filter (where d.data_key='platform') platform,
  max(d.string_value) filter (where d.data_key='install_id') iid,
  max(d.string_value) filter (where d.data_key='user_id') uid,
  max(d.number_value) filter (where d.data_key='step') step,
  max(d.string_value) filter (where d.data_key='skipped') skipped,
  max(d.string_value) filter (where d.data_key='skip_reason') skip_reason,
  max(d.string_value) filter (where d.data_key='seeded') seeded,
  max(d.number_value) filter (where d.data_key='item_count') item_count,
  max(d.number_value) filter (where d.data_key='days_since_signup') dss
 from website_event e join event_data d on d.website_event_id=e.event_id
 where e.website_id=:'w' and e.created_at>=:'since' and e.event_type=2
 group by 1,2,3,4,5),
su as ( -- one row per mobile signup
 select distinct on (coalesce(iid, session_id::text)) coalesce(iid, session_id::text) person, iid, platform, created_at signup_at
 from ev where event_name='onboarding_signup_completed' and platform in ('ios','android')
 order by coalesce(iid, session_id::text), created_at),
steps as ( -- last completion of each step before signup
 select distinct on (su.person, ev.step) su.person, ev.step, ev.skipped, ev.skip_reason
 from su join ev on ev.event_name='onboarding_step_completed' and ev.platform in ('ios','android')
   and coalesce(ev.iid, ev.session_id::text)=su.person and ev.created_at <= su.signup_at + interval '1 minute'
 order by su.person, ev.step, ev.created_at desc),
sk as (
 select person,
  max(skipped) filter (where step=0) s0, max(skipped) filter (where step=1) s1, max(skipped) filter (where step=2) s2,
  max(skip_reason) filter (where step=0) r0, max(skip_reason) filter (where step=2) r2
 from steps group by 1),
idmap as (select iid, min(uid) uid from ev where iid is not null and uid is not null group by 1),
ub as ( -- per user outcomes
 select uid,
  bool_or(event_name='onboarding_seed_saved') seed_saved,
  bool_or(event_name='onboarding_seed_failed') seed_failed,
  bool_or(event_name='activation_complete') activated,
  bool_or(event_name='first_calendar_opened') fco,
  bool_or(event_name='first_calendar_opened' and seeded='true') fco_seeded,
  max(item_count) filter (where event_name='first_calendar_opened') fco_items,
  bool_or(dss >= 1 and event_name not in ('trial_ended','subscription_renewed','subscription_canceled')) returned,
  bool_or(event_name in ('paywall_purchased','subscription_started')) purchased
 from ev where uid is not null group by 1),
c as (
 select su.*, sk.s0, sk.s1, sk.s2, sk.r0, sk.r2, idmap.uid, ub.seed_saved, ub.seed_failed, ub.activated, ub.fco, ub.fco_seeded, ub.fco_items, ub.returned, ub.purchased,
  (sk.s0 is not null and sk.s1 is not null and sk.s2 is not null) full_steps,
  (sk.s0='true' and sk.s1='true' and sk.s2='true') skipped_all
 from su left join sk using (person) left join idmap on idmap.iid=su.iid left join ub on ub.uid=idmap.uid)
```

```sql
-- skips
select platform, count(*) signups, count(*) filter (where full_steps) with_all_steps,
 count(*) filter (where full_steps and s0='true') skip_balance,
 count(*) filter (where full_steps and s1='true') skip_paycheck,
 count(*) filter (where full_steps and s2='true') skip_bills,
 count(*) filter (where full_steps and skipped_all) skip_all,
 count(*) filter (where full_steps and s0='false' and s1='false' and s2='false') answered_all
from c group by rollup(1) order by 1;

-- seed, failure, activation for signups linked to a user id
select platform, count(*) signups, count(uid) linked,
 count(*) filter (where uid is not null and seed_saved) seed_saved,
 count(*) filter (where uid is not null and seed_failed) seed_failed,
 count(*) filter (where uid is not null and seed_failed and seed_saved) failed_then_saved,
 count(*) filter (where uid is not null and seed_saved is not true) no_seed,
 count(*) filter (where uid is not null and fco and not fco_seeded) first_open_unseeded,
 count(*) filter (where uid is not null and fco and fco_items=0) first_open_zero_items,
 count(*) filter (where uid is not null and activated) activated,
 count(*) filter (where uid is not null and skipped_all) linked_skip_all,
 count(*) filter (where uid is not null and skipped_all and seed_saved) skip_all_but_seeded,
 count(*) filter (where uid is not null and full_steps and not skipped_all and seed_saved is not true) answered_no_seed
from c group by rollup(1) order by 1;

-- empty versus seeded, signups with at least one later day
select platform, case when seed_saved then 'seeded' else 'empty' end grp, count(*) n,
 count(*) filter (where returned) returned, count(*) filter (where activated) activated
from c where uid is not null and signup_at < '2026-11-11'
group by grouping sets ((1,2),(2)) order by 1,2;

-- whole-period cross-check, not linked person to person
select platform, count(*) filter (where event_name='onboarding_signup_completed') signups,
 count(distinct uid) filter (where event_name='onboarding_seed_saved') seed_saved_users
from ev where platform in ('ios','android') and hostname <> 'www.cashflowcalendar.app' group by 1;
```

### Paid visits, Google Play taps, Android signups

```sql
with fv as (
 select distinct on (e.session_id) e.session_id, e.created_at, e.url_path, e.gclid,
  lower(coalesce(e.utm_source,'')) src, lower(coalesce(e.utm_medium,'')) med, s.country, s.os
 from website_event e join session s on s.session_id=e.session_id
 where e.website_id=:'w' and e.hostname='www.cashflowcalendar.app' and e.event_type=1 and e.created_at>=:'from'
 order by e.session_id, e.created_at),
p as (
 select session_id, created_at, os,
  case when gclid is not null or (src='google' and med in ('paid','cpc','ppc','paid_social','paidsocial')) then 'google'
       when med in ('paid','cpc','ppc','paid_social','paidsocial') and src in ('fb','ig','an','th','msg','facebook','instagram','meta') then 'meta' end channel
 from fv
 where not (url_path like '/dashboard%' or url_path like '/auth%' or url_path like '/onboarding%')
  and not (coalesce(country,'') = any(array['SG','CN']))),
act as (
 select e.session_id,
  bool_or(e.event_name='google_play_button_click') play,
  bool_or(e.event_name='apple_app_store_button_click') apple,
  bool_or(e.event_name='signed_up') web_signup,
  min(e.created_at) filter (where e.event_name='google_play_button_click') play_at
 from website_event e join p on p.session_id=e.session_id
 where e.website_id=:'w' and e.event_type=2 and e.created_at>=:'from' group by 1),
asu as ( -- Android app signups and the UTMs they carry
 select e.event_id, e.created_at,
  bool_or(d.data_key='utmSource') has_utm_key,
  case when lower(max(d.string_value) filter (where d.data_key='utmSource'))='google' and lower(max(d.string_value) filter (where d.data_key='utmMedium')) in ('paid','cpc','ppc','paid_social','paidsocial') then 'google'
       when lower(max(d.string_value) filter (where d.data_key='utmMedium')) in ('paid','cpc','ppc','paid_social','paidsocial') and lower(max(d.string_value) filter (where d.data_key='utmSource')) in ('fb','ig','an','th','msg','facebook','instagram','meta') then 'meta' end channel
 from website_event e join event_data d on d.website_event_id=e.event_id
 where e.website_id=:'w' and e.event_name='signed_up' and e.created_at>=:'from'
 group by 1,2 having max(d.string_value) filter (where d.data_key='platform')='android')
```

```sql
-- first Android signup with UTM keys, and signups per day
select created_at::date d, count(*) android_signups, count(*) filter (where has_utm_key) with_utm_key,
 count(*) filter (where channel='google') paid_google, count(*) filter (where channel='meta') paid_meta
from asu where created_at >= '2026-11-01' group by 1 order by 1;

-- paid visits and Play taps since the UTMs started
select coalesce(p.channel,'(unpaid)') channel, count(*) visits, count(*) filter (where act.play) play_taps
from p left join act using (session_id) where p.created_at >= '2026-11-11' group by 1;

-- the 28 complete days before, for the rate of taps
select coalesce(p.channel,'(unpaid)') channel, count(*) visits,
 count(*) filter (where act.play) play_taps,
 count(*) filter (where act.play and p.os ilike 'android%') play_taps_on_android,
 (select count(*) from asu where created_at >= '2026-10-15' and created_at < '2026-11-12') android_signups_all
from p left join act using (session_id)
where p.created_at >= '2026-10-15' and p.created_at < '2026-11-12' group by 1;
```

### Android start rate by install and region

Variables: `\set since '2026-10-23'`.

```sql
with ev as (
 select e.event_id, e.event_name, e.session_id, e.created_at,
  max(d.string_value) filter (where d.data_key='platform') platform,
  max(d.string_value) filter (where d.data_key='install_id') iid,
  max(d.string_value) filter (where d.data_key='user_id') uid,
  max(d.string_value) filter (where d.data_key='appVersion') ver,
  max(d.number_value) filter (where d.data_key='days_since_signup') dss
 from website_event e join event_data d on d.website_event_id=e.event_id
 where e.website_id=:'w' and e.created_at>=:'since' and e.event_type=2 and e.hostname='app.cashflowcalendar.app'
 group by 1,2,3,4),
inst as ( -- one row per install that saw the intro
 select iid, min(platform) platform,
  min(created_at) filter (where event_name='onboarding_intro_viewed') intro_at,
  min(session_id::text) filter (where event_name='onboarding_intro_viewed') intro_session,
  min(ver) filter (where event_name='onboarding_intro_viewed') ver,
  bool_or(event_name='onboarding_started') started,
  bool_or(event_name='onboarding_signup_completed') signed_up,
  bool_or(uid is not null) identified,
  count(*) events
 from ev where iid is not null and platform in ('ios','android')
 group by 1 having bool_or(event_name='onboarding_intro_viewed')),
c as (
 select inst.*, s.country, s.device, s.os, s.browser,
  case when started then 'started the questions'
       when identified and not signed_up then 'logged in to an existing account'
       when events = 1 then 'left: intro was the only event'
       else 'other' end outcome
 from inst left join session s on s.session_id::text = inst.intro_session)
select platform, (s.region in ('US-OR','US-GA','US-OK','US-SC','US-IA')) google_dc_region, count(*) installs,
 count(*) filter (where started) started,
 count(*) filter (where outcome like 'logged in%') logged_in,
 count(*) filter (where outcome like 'left%') left_only,
 count(*) filter (where signed_up) signed_up
from c left join session s on s.session_id::text = c.intro_session
group by 1,2 order by 1,2;

-- how many distinct users the "logged in" installs belong to (same `with` block, plus:)
-- , lg as (select c.iid, c.platform, min(ev.uid) uid from c join ev on ev.iid = c.iid and ev.uid is not null
--          where c.outcome like 'logged in%' group by 1,2)
-- select platform, count(*) installs, count(distinct uid) users from lg group by 1;
```

### Signup rate by skips, and time on step

Variables: `\set since '2026-10-08'`.

```sql
with ev as (
 select e.event_id, e.event_name, e.session_id, e.created_at,
  max(d.string_value) filter (where d.data_key='platform') platform,
  max(d.string_value) filter (where d.data_key='install_id') iid,
  max(d.number_value) filter (where d.data_key='step') step,
  max(d.string_value) filter (where d.data_key='skipped') skipped,
  max(d.number_value) filter (where d.data_key='ms_on_step') ms
 from website_event e join event_data d on d.website_event_id=e.event_id
 where e.website_id=:'w' and e.created_at>=:'since' and e.event_type=2
  and e.hostname='app.cashflowcalendar.app' and e.event_name like 'onboarding%'
 group by 1,2,3,4),
m as (select *, coalesce(iid, session_id::text) person from ev where platform in ('ios','android')),
last as (select distinct on (person, step) person, step, skipped from m
         where event_name='onboarding_step_completed' order by person, step, created_at desc),
p as (select person, count(*) steps, count(*) filter (where skipped='true') skips from last group by 1),
s as (select person, bool_or(event_name='onboarding_signup_completed') signup from m group by 1)
select case when skips=3 then 'skipped all' when skips=0 then 'answered all' else 'answered some' end grp,
 count(*) finished, count(*) filter (where signup) signed_up
from p join s using (person) where steps=3 group by 1 order by 1;

-- time on step: same `ev` block with since = '2026-10-23', then
-- select step, skipped, count(*), percentile_cont(0.5) within group (order by ms)/1000 median_s
-- from ev where event_name='onboarding_step_completed' and ms is not null group by 1,2 order by 1,2;
```
