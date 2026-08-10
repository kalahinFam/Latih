# LATIH — AI Personal Trainer

An AI fitness coach that runs in a phone browser. It watches your workout through
the camera, counts repetitions, and corrects your form in real time —
**all image processing happens on the device.**

Datathon 2026, Ristek Fasilkom UI — University Track. Team **Kalahin Fam**,
Universitas Indonesia.

## ▶ Try it now

**[https://latih-sable.vercel.app/](https://latih-sable.vercel.app/)**

Nothing to install and no account to create. Open the link on a phone, tap
**Mulai latihan**, pick a movement, and allow camera access. The interface is in
Indonesian, which is deliberate — see [Localization](#a-note-on-language).

That URL is the whole product. Everything described in this README is reachable
from it, including the parts a judge would want to verify: the offline
correction loop, the TKPI-grounded nutrition answers with their source rows, and
the privacy checks in [Privacy claims](#privacy-claims--how-to-verify-them-yourself).

---

## Using the deployed app

### What you need

| | |
|---|---|
| **Device** | Any Android phone. iOS works too, with the caveats below. |
| **Browser** | Chrome or Edge on Android; Safari on iOS. **Not Firefox** — it does not implement the Web Speech API, so voice input is unavailable there (a text field is provided instead). |
| **Permissions** | Camera. Notifications only if you want workout reminders. |
| **Account** | None. There is no sign-up, and no data is associated with a person. |
| **API key** | None on your side. The coach's key lives on the server. |

The camera requires **HTTPS**, which the deployed URL provides. This is a
functional requirement, not a deployment nicety: `getUserMedia` refuses to run
on an insecure origin, so an IP address on your LAN will never work.

### A five-minute walkthrough

1. **Open the URL** on your phone and complete onboarding. Six questions, each
   feeding a calculation — the closing screen shows the arithmetic rather than a
   congratulation.
2. **Start a set.** Pick push-up, squat, or plank, prop the phone against
   something at roughly 30–45° for push-ups and squats (full side-on for plank),
   and step back until your whole body is in frame. The setup screen tells you
   when it is.
3. **Train.** Repetitions are counted against a real depth standard. A
   half-repetition is shown in amber and *not* counted — that is intended, and
   the reason is in [design decision 3](#3-half-reps-are-seen-but-not-counted).
   Exactly one spoken cue per repetition.
4. **Press STOP.** The set summary goes to the coach and comes back as two or
   three sentences plus one focus for the next set.
5. **Ask something during rest.** Try *"habis ini apa?"* ("what's next?") or
   *"lutut kiriku sakit"* ("my left knee hurts"). The second one changes the next
   movement and logs the complaint.

### Install it and pull the plug

This is the single most convincing thing to try, and it takes a minute.

In Chrome on Android an **"Install app"** prompt appears; accept it. On iOS, use
**Share → Add to Home Screen**. Then **turn off mobile data and Wi-Fi** and start
a set. The repetition counter, the form rules, and the spoken cues all keep
working, because none of them need the network. Only the between-set narrative
is skipped, with a message saying so.

### What needs connectivity

Form correction and counting never do. These do: the per-set coach narrative,
nutrition answers, meal suggestions, and rest-chat replies. Each fails softly —
you get a message and the workout continues.

### iOS caveats

Push reminders reach an installed PWA only, never an ordinary Safari tab; the
app reports this rather than showing a button that quietly does nothing. Web
Speech support varies by iOS version, so the typing field next to the microphone
is not decoration.

### A note on language

The interface, the spoken cues, and the coach are in Indonesian throughout. The
food database is the Indonesian national composition table. This is the product
being localized for its users, not an unfinished translation.

---

## Running it locally

You do not need this to evaluate the product — the deployed URL above is the
complete app. Follow this if you want to read the code as it runs, or change it.

**Prerequisite:** Node.js 20 or newer.

```bash
git clone https://github.com/kalahinFam/Latih.git
cd Latih
npm install                 # OpenAI SDK for the serverless functions
cd web && npm install
npm run dev
```

For the AI coach, copy `.env.example` to `.env` in the repository root and fill
in `OPENAI_API_KEY`. **Without a key the fast loop still runs in full** — the
repetition counter and the correction cues need no network at all; only the
between-set narrative is skipped.

Open **http://localhost:5174** (or whichever port is printed), press **Mulai
latihan**, choose a movement, then allow camera access.

`npm install` does not download the models. The first `npm run dev` triggers
`setup:assets`, which copies the WASM runtime out of `node_modules` and fetches
two pose models (~48 MB total). It happens once; later runs skip it.

### Testing on a phone

The camera is only available over **HTTPS**. Opening a LAN address such as
`http://192.168.x.x:5174` will be refused by the browser. Use a tunnel:

```bash
npx cloudflared tunnel --url http://localhost:5174
```

Open the printed `https://….trycloudflare.com` URL on the phone.

### Testing PWA installation and offline mode

The service worker is deliberately active only in production builds — in dev
mode it fights with hot reload.

```bash
npm run build
npm run preview
```

Then point the tunnel at the preview port. Chrome on Android will offer
**"Install app"**. Once installed, turn off the network: the repetition counter
and the cues keep working in full.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm test` | Unit tests (627 of them) |
| `npm run gen:vapid` | Generate a Web Push key pair |
| `npm run tts:lab` | Render coach voice samples for comparison (into `tts-lab/`) |
| `npm run gen:cues -- --force` | Regenerate the cue clips after changing voice |
| `npm run typecheck` | Type check without building |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the build (for PWA testing) |
| `npm run setup:assets` | Re-fetch models + WASM |
| `npm run gen:icons` | Regenerate the PWA icons |
| `npm run bench:fastloop` | Fast-loop compute cost per frame (**not** device latency) |
| `npm run eval:reps` | Repetition-counting accuracy harness |
| `npm run eval:grounding` | TKPI grounding battery (needs `npm run dev` + an API key) |
| `npm run check:tkpi` | Validate the TKPI table (duplicate codes, bases, Atwater) |

---

## Architecture

```
┌────────── BROWSER — on-device, frames never leave ──────────────────────┐
│  Camera → MediaPipe PoseLandmarker (WASM/GPU) → 33 landmarks @ ~30fps   │
│      ↓                                                                  │
│  FAST LOOP (pure TypeScript, no DOM) — within a repetition              │
│    joint angles → rep-count state machine → form checks → cue           │
│      ↓ once a set ends: aggregate statistics as JSON                    │
│                                                                         │
│  SESSION LOOP — across sessions                                         │
│    localStorage history → next repetition target + trend                │
│    → weekly plan (days, movements, sets × reps)                         │
│                                                                         │
│  Body profile → Mifflin-St Jeor → daily calorie target                  │
│    (history and body measurements are never uploaded;                   │
│     only the derived numbers leave)                                     │
└────────────────────────────┬────────────────────────────────────────────┘
                             │  numbers only — no frames, no coordinates,
                             │  no weight/height/age
                    ┌────────▼─────────────────────┐
                     │  SLOW LOOP  /api/coach       │  per-set narrative
                     │  NUTRITION  /api/nutrition   │  TKPI + verifier
                     │  MEALS      /api/meals       │  options, totals in code
                     │  REMINDERS  /api/push        │  Web Push subscriptions
                    └────────────────────────────┬─┘
                                                 │  cron every 15 minutes
                                    ┌────────────▼──────────────┐
                                    │  /api/cron-reminders      │
                                    │  payload-free push →      │
                                    │  text composed on device  │
                                    └───────────────────────────┘
```

### Directory structure

```
web/src/
├── core/          ← PURE LOGIC. No DOM, no MediaPipe.
│   ├── angles.ts       landmarks → joint angles
│   ├── repCounter.ts   hysteresis state machine
│   ├── rules.ts        deterministic form checks
│   ├── repWindow.ts    per-repetition frame buffer
│   ├── features.ts     per-rep window → 32×12 tensor (classifier input)
│   ├── setSummary.ts   per-set aggregation + the privacy contract
│   ├── sessionLoop.ts  target adaptation from cross-session history
│   ├── plan.ts         weekly plan from target + preferences
│   ├── split.ts        movements per training day, from onboarding answers
│   ├── energy.ts       Mifflin-St Jeor → calorie & protein targets
│   ├── pantry.ts       curated foods, by TKPI code
│   ├── meals.ts        meal option validation + total computation
│   ├── metrics.ts      FPS & latency instrumentation
│   └── quality.ts      quality score, day streaks, session aggregates
├── app/           ← hash router + workout session state
├── session/       ← on-device storage: history, profile, reminders
├── pose/          ← the only file that knows MediaPipe exists
└── ui/
    ├── workoutEngine.ts  fast loop + camera, two modes
    ├── skeleton.ts       overlay
    ├── icons.ts          seven icons, hand-drawn
    └── screens/          one module per screen

web/test/          ← integration tests against real data and server code.
                     Outside src/ so that src/ stays pure browser code.
```

`core/` is kept pure on purpose: the Node evaluation scripts import **exactly
the same modules** the application runs. There is no duplicated logic, so the
numbers reported in the paper are guaranteed to come from the code the product
actually uses.

Two things make this work, and break it if changed:

- **Every relative import carries an explicit `.ts` extension.** Node's ESM
  resolver does not guess extensions the way bundlers do. Removing them makes
  the evaluation scripts fail to resolve, even though the app still runs.
- **`erasableSyntaxOnly` is on in `tsconfig.json`.** It forbids TypeScript
  syntax that emits runtime code (enums, parameter properties), so Node can
  simply strip types without compiling.

---

## Slow loop — the per-set narrative

Press **STOP** when you finish. The client posts a set summary to `/api/coach`,
which returns two or three sentences of Indonesian plus one focus for the next
set.

**That summary is all that leaves the device:** repetition counts, joint angles
in degrees, durations, and error codes. No frames, no landmark coordinates. The
endpoint rejects any payload containing pose data **before** it reaches the
model — defence in depth, since the client cannot construct such a payload from
the `SetSummary` type in the first place.

**Numeric comparison happens in code, not in the model.** `directivesFor()`
evaluates every threshold and injects unconditional `INSTRUKSI:` lines. The
reason is empirical: given raw numbers, the model invented faults in clean sets,
turned "two more repetitions" into "double", and praised progress in a session
that lost four repetitions and nine degrees of depth — all the same failure,
namely asking a language model to evaluate a numeric threshold and remember a
conditional.

Every response carries `usage` and `latencyMs`, so the cost and latency figures
in the paper come from real traffic rather than estimates.

**Failure paths** (all degrade quality; none stop the workout): offline and a
15-second timeout are skipped with a message; a missing key produces a concrete
instruction; a zero-repetition set is answered without calling the model at all.

---

## Session loop — targets that adapt

The third and slowest loop: it looks across sessions and decides what to ask for
next. `core/sessionLoop.ts` (pure logic) + `session/history.ts` (storage).

**History never leaves the device.** It lives in `localStorage`, capped at 500
sets. Only derived numbers — the target, the repetition delta, the depth delta —
travel with the `/api/coach` request. Never the log.

**Three rules shape it:**

- **Quality gates progression, not volume alone.** If the target is met but more
  than 25% of repetitions were flagged, the target holds and the narrative
  steers toward form. The naive rule — "more than last time, so raise it" —
  trains people to chase the number by cutting depth, which is the exact fault
  the fast loop exists to catch.
- **Two consecutive sessions are required**, because one good session is noise.
- **The session's best set is judged, not its last.** Fatigue makes later sets
  lower; judging the last would read every normal workout as a regression.

Sessions below 0.7 tracking quality are **skipped entirely** rather than counted
as failures — the camera had the problem, not the person.

---

## Asking the coach during rest

Between sets you can talk to the coach — *"habis ini apa?"* ("what's next?") or
*"lutut kiriku sakit"* ("my left knee hurts"). The first is answered from the
plan the device already holds. The second **changes the next movement and logs
the complaint.**

**The model reads the sentence; code decides the consequence.** The model
returns a body part from a closed set, a side, and an intent — then a table in
`core/restChat.ts` determines the replacement. A model free to choose will
eventually answer a knee complaint with a lunge, which loads the same knee and
which the camera also cannot count. The prompt forbids naming a replacement
movement at all.

**Replacements are deliberately not `MovementKind`.** A glute bridge cannot be
judged by this camera setup, so each `SubstituteMovement` carries
`tracked: false` and the screen says so plainly: *"the camera cannot count this
movement, so the set is not counted automatically"*. A product that claims to
watch owes honesty about the sets it does not watch.

**The medical boundary is structural.** Substitutions expire at midnight,
because a knee that hurt on Tuesday is not evidence about Thursday and the app
has no way to know whether it healed. The complaint itself is kept, as a record
to show someone qualified to judge it. Three complaints about the same body part
within 14 days add a fixed referral sentence, owned by code and never phrased by
the model.

**Voice is the one path that leaves the device.** The Web Speech API does not
transcribe on-device: the audio goes to the browser vendor's recognition
service. Camera frames still never leave, and that claim is intact — but the two
must not be described as though they work alike, so the sentence saying so sits
directly beside the microphone button rather than in a settings page nobody
opens. A typing field sits next to it: Firefox does not support the API at all,
and iOS varies by version.

---

## Application flow

Ten screens in a single document, with a hash router in `app/router.ts`:

```
Splash ──► Onboarding (6 steps) ──┐
                                  ▼
Home ──► Pick movement ──► Camera setup ──► Workout ──► Set feedback
  ▲                                            ▲             │
  │                                            └── another set┤
  └──────────────── Session summary ◄────── finish ───────────┘

Bottom nav: Workout · History · Nutrition        Settings from Home
```

**Why one document rather than several pages.** The camera has to survive every
one of those transitions. Separate pages tear down `getUserMedia` and
re-initialize MediaPipe on each navigation — a black screen for several seconds,
mid-workout. The `<video>` element lives in its own layer outside the screens.
Hash routing is used instead of the History API because the app is served as
static files.

**Onboarding** is six steps (`STEPS` in `ui/screens/onboardingScreen.ts`), and
every question exists because something computes with the answer: age, sex,
height, and weight feed Mifflin-St Jeor; activity supplies its multiplier; goal
sets the direction of the calorie adjustment; experience sets the first
repetition target; dietary restrictions filter the TKPI rows. The closing screen
shows the arithmetic, rendered from `core/energy.ts` at display time — no number
is written into the markup. **Restrictions are enforced, not requested:**
excluded rows are removed from the pantry *before* the prompt is built. Tested
against the live endpoint — without restrictions the model used chicken and
shrimp; with them, **zero violations across three scenarios**.

**The camera setup screen ticks only what it measures:** whole body in frame,
and approximate distance via `bodyFill`. Camera angle and height are not
measured at all, so both appear as written guidance without a checkmark — a
checkmark meaning "we assume so" would devalue the two that mean "we measured
this".

**The plank has its own machine** (`core/holdTracker.ts`): a repetition is an
event, a hold is a state. A broken hip line **stops the clock rather than ending
the set**, with a 300 ms grace. The camera angle differs too — push-ups and
squats want 30–45° oblique, the plank wants full side-on.

**The workout screen** is read from about 2 m away at floor height: one large
number with everything else at the edges; the number itself changes colour (sage
for good form, amber for a correction) so the signal and the thing being watched
are the same object; and the number sits in the lower third, because from the
floor that is where your gaze falls.

---

## Weekly plan and calorie target

The session loop decides **how many repetitions**; the weekly plan decides
**when to ask for them**. Progression moves along **one axis** — sets fixed,
repetitions moving — because raising both changes total load unpredictably and
makes the adaptation impossible to explain in one sentence. Training days are
spread rather than clustered: three sessions on Friday–Sunday are nominally the
same frequency as Monday–Wednesday–Friday, and a materially worse week.

Calorie targets use Mifflin-St Jeor (1990) in `core/energy.ts`, computed **on the
device**. `MealsRequest` has no field for weight or age — the same approach as
`SetSummary` having no field for a video frame. The result is a **range, not a
single number** (the equation is accurate within 10% for roughly 70% of people),
there are **two floors** so the app never suggests intake below basal
metabolism, and **out-of-range input is rejected rather than extrapolated**.

---

## Meal suggestions — where the verifier is not enough

This is the case the existing grounding verifier cannot catch. That verifier
checks whether a number **appears** in a retrieved row. A meal's total appears
in no row, because it is **derived** — so a wrong total assembled from
ingredients whose individual numbers are all genuine would pass.

So the division of labour shifts: **the model picks foods and portions**, and
every number after that is computed by `core/meals.ts` from the TKPI rows those
codes refer to. The pantry is curated **by TKPI code** rather than by keyword
search — searching "ayam" returns fried chicken from three restaurant chains
before it reaches plain chicken. A test asserts that every code resolves to a
real row not flagged `suspect`, so a mistyped code fails the build.

**What was measured.** Tested against `gpt-4o-mini` over twelve meal slots: five
options were rejected because their totals missed the target, **always by
falling short**, with the error growing as the target rose. One more invented a
TKPI code that does not exist, caught by the pantry check. Adding arithmetic
hints to the prompt and requesting a fourth option cut the rejection rate from
**42% to 29%**. The remainder is the honest cost of asking a language model to
satisfy an arithmetic constraint; it is absorbed rather than hidden — only
options that pass validation reach the user.

---

## Workout reminders

Real Web Push: the server wakes the service worker at the chosen time, whether
or not the app is open.

**Payload-free push.** The server sends an empty wake-up; the text is composed
in the service worker, on the device. The push service — Google or Mozilla,
depending on the browser — relays a notification whose contents it never sees.

```bash
npm run gen:vapid          # → VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY
```

Put both into `.env` and into the Environment Variables on Vercel. Without them
the reminder button hides itself and the rest of the app runs normally.

Subscriptions are stored in Upstash Redis over its REST API. If
`UPSTASH_REDIS_REST_URL` is unset, storage falls back to memory — fine locally,
lost on every redeploy, and the Plan screen says so. On iPhone, push only
reaches a PWA added to the Home Screen, and `reminderSupport()` reports the
reason instead of showing a button that quietly does nothing.

---

## TKPI nutrition — grounding you can check, not just claim

**1,144 foods**, extracted automatically from
[panganku.org](https://www.panganku.org/id-ID/view), the official TKPI database.
1,133 are citable; 11 are excluded because their numbers are inconsistent **in
the source itself** (see [`data/tkpi/README.md`](data/tkpi/README.md)).

**Nutrition Q&A** is its own screen, opened from Nutrition. Every answer appears
**together with the TKPI rows it used**, numbers and provenance included, so
anyone — a judge included — can check it without leaving the page.

You can **type or pick**, because the two fail differently. Typing reaches the
whole table but can miss — and if retrieval finds nothing, the answer is a
refusal. The offered questions cannot miss: the catalogue is in
`core/nutritionQuestions.ts`, and every question it can produce is tested
against the real TKPI table in `test/nutritionQuestions.test.ts`, so a
suggestion that cannot be answered fails the build rather than the conversation.

**The pipeline, and why each stage exists:**

1. **Retrieval** finds the foods the question names. If nothing matches, the
   model is **not called at all** — without rows there is nothing for an answer
   to be grounded in, and asking anyway is precisely how a fabricated number is
   produced. In conversation, follow-up questions often name no food at all
   ("kalau tahu?"), so retrieval is retried together with the previous question
   — only when needed, because every extra row widens the set of numbers the
   verifier will accept, and that set is the guarantee.
2. **The model sees only the retrieved rows**, explicitly forbidden to compute,
   multiply, or use its own knowledge.
3. **The verifier checks every number** in the answer against those rows.
4. **On failure → one rewrite** under stricter instructions.
5. **On failure again → the prose is discarded**, and the raw table is still
   shown.

That last step is the point. A nutrition assistant that occasionally invents a
plausible number is worse than one that occasionally refuses to write prose,
because the user cannot tell the two apart. Refusing is an honest failure.

Only **derived numbers** accompany the question: the daily energy and protein
targets already computed on the device. Weight, height, age, and sex have no
field in the request type.

**Only numbers carrying a unit are checked.** Nutrition claims always have one —
"20.8 grams of protein", "201 kcal". A bare number is a count ("two
ingredients"), not a composition claim; checking those would reject correct
answers, and the team would end up disabling the verifier. Indonesian numerals
are read by Indonesian convention — decimal comma, thousands point — since
reading "20,8" as English yields 208 and fails every check.

### Measuring it

```bash
npm run dev                    # in another terminal
npm run eval:grounding
```

The battery deliberately contains questions designed to **provoke** fabrication:
foods absent from the table, arithmetic the model is forbidden to perform, and a
health claim. A grounding score measured only on easy questions means nothing.

Results on the full 1,133-row table — 12 questions, 35 numbers checked:

| Metric | Result |
|---|---|
| Grounded answers | **100%** |
| Required a rewrite | 0% |
| Prose withheld | 0% |
| Absent foods handled without fabrication | **100%** |
| Spurious citations | **0** |
| Median latency | 1,492 ms |

Raw output is committed at [`eval/results/grounding.json`](eval/results/grounding.json).

### Retrieval uses word distinctiveness, not just matching

This came out of measurement, not initial design. On a 10-row table every metric
was green; once the full table was in, *"berapa protein daging unta"* ("how much
protein is in camel meat") cited four unrelated meat rows — because "daging"
(meat) matches hundreds of names while "unta" (camel) matches none. The answer
was still correct ("no data available"), but four irrelevant foods appeared as
its sources.

The fix: a match is accepted only if at least one matching word is
**distinctive** — appearing in at most 3% of food names. The first attempt was
instructively wrong: requiring matches to explain *most* of the question
rejected *"tempe tahu telur ayam"* outright, since with four foods named no
single row can explain a majority.

### Validating the data

```bash
npm run check:tkpi
```

Checks for duplicate codes, non-100 g bases, and Atwater consistency
(protein×4 + carbs×4 + fat×9 ≈ energy).

It found **11 rows (0.96%) whose numbers contradict themselves in the official
TKPI data** — confirmed directly against the source pages. Those rows are kept
for provenance, flagged `suspect`, and excluded from retrieval. A system
grounded in an external source still has to validate that source.

---

## Audio — correction cues, pre-rendered MP3

The set of corrective phrases is closed — seven sentences, listed in `CUE_TEXT`
in `core/rules.ts`. All are rendered to MP3 at build time by
`scripts/gen-cues.mjs` and played back with no network involved at all.

The reason: a cue that arrives a second late **is not a late cue, it is a wrong
one** — the repetition it describes is over. Calling a TTS service mid-set also
costs money on every repetition and goes silent the moment the venue Wi-Fi
misbehaves.

Filenames are hashed from **the text**. Editing a phrase produces a new name, so
the old recording stops being referenced rather than quietly playing a
correction that no longer applies. The consequence: change the voice without
`npm run gen:cues -- --force` and the old clips stay in use.

If a clip fails to play — offline, no key, quota exhausted — playback falls back
to the browser's built-in `speechSynthesis`. Which one you are hearing is
readable in the device console:

```js
latih.engine.audioSource   // 'clip' | 'browser' | null
```

The between-set narrative is shown as text on the Feedback screen, not read
aloud.

---

## Annotation tool

Open **http://localhost:5174/annotate.html** after `npm run dev`.

Flow: choose a video → extract keypoints → inspect the repetition segmentation →
label fault classes → download JSON.

**Extraction runs in the browser rather than in Python**, because the tool uses
**exactly the same** `PoseSource` and `RepCounter` as the application. MediaPipe
Python and MediaPipe JS are different implementation paths even with identical
model weights; any numerical difference would make the evaluation numbers
describe the harness rather than the product.

**Two rules keep the dataset valid:**

1. **Rule outputs are never ticked automatically.** Guesses from `rules.ts`
   appear in a separate `suggested` column and are never copied into `labels` —
   a dataset seeded from rule output teaches a classifier to imitate the rules,
   turning any later *rule-only* vs *rule+classifier* ablation into a comparison
   of something against its own copy.
2. **A subject ID is mandatory**, because the train/test split must be per
   person. If repetitions from the same person leak across both sides, F1 looks
   good for false reasons.

Export is refused when the segmented and manual counts disagree, because that
disagreement **is** the accuracy data.

---

## Evaluation

```bash
npm run eval:reps
```

With no recorded data, the script runs a **synthetic self-check** and labels the
result as *not* an accuracy figure — so a synthetic number can never be copied
into the paper as a measurement. Once annotations exist, run it with
`--input eval/data`. Output goes to
[`eval/results/rep_accuracy.json`](eval/results/rep_accuracy.json).

### Fast-loop cost, separate from inference

```bash
npm run bench:fastloop
```

Replays a squat session through **exactly the same** `core/` modules the browser
uses, in the same call order as `ui/workoutEngine.ts`: framing, joint angles,
posture gate, median filter, counter, rep window, rules. Output goes to
[`eval/results/fastloop_cost.json`](eval/results/fastloop_cost.json).

**This is not a device latency figure and must not be reported as one.** It
measures only arithmetic over 33 points; MediaPipe inference cost depends on the
GPU and thermal state and can only be measured on a real phone via
`latih.engine.performance`. Its single purpose: the cue-budget derivation in the
paper is only honest if the `core/` term is negligible against the frame period.
The script refuses to emit a number if no repetitions were counted — that would
mean it timed an early return rather than the loop.

---

## Six design decisions to know before changing the code

### 1. Do not simply average the left and right sides

`reliableMean` in `core/angles.ts`, and the most important fix to come out of
field testing.

MediaPipe **does not drop** an occluded limb — it *guesses* it, and reports a
visibility above any threshold you might sensibly set. The cost is measurable:
from an oblique angle, a push-up at the bottom hides the far arm behind the
torso and MediaPipe guesses it nearly straight. The near elbow read ~95°, the
far one ~170°, the mean ~132° — just under the 135° gate on good frames and just
over it on bad ones. The result was a counter that worked while the arms were
open and stopped exactly when the movement became meaningful: testers reported
push-ups "almost never" counting while a random hand wave counted smoothly. The
same mechanism made squats read deeper than they were.

The mean is still used when both sides are equally well observed. Otherwise,
take the side you can see.

### 2. Joint angles cannot answer "is this movement happening"

`core/posture.ts`. A knee flexing and extending reads identically whether the
person is standing or lying down — reported as "it counts anything as long as
you bend and straighten a leg". The distinguishing signal is trunk orientation,
and it is not in the joint angles at all.

The threshold is deliberately far looser than good form. This is **not** a form
rule and must not reject real repetitions: a deep squat leans the torso well
forward. Only unambiguous cases are rejected — lying down, sitting, standing
still. When it cannot be sure, it allows.

### 3. Half reps are seen, but not counted

The counter has **two** thresholds. `downEnter` answers "was a repetition
attempted"; `creditMax` answers "did it reach the bottom", and only that one
increments the count. An attempt that reverses between the two is still reported
(`counted: false`), so the app can show it in amber.

Depth used to be checked **twice, in two places**: the counter credited anything
past `downEnter`, and a rule flagged it shallow afterwards. Twelve half squats
therefore produced twelve repetitions **and** twelve corrections, while
inflating the target the session loop then used to progress.

| Movement | Attempt (`downEnter`) | Counted (`creditMax`) |
|---|---|---|
| Push-up | elbow 135° | elbow 105° |
| Squat | knee 140° | knee 90° — parallel |

`liveCue` reads the same `creditMax`, so the "go deeper" warning arrives at the
reversal, **before** the rep is rejected.

### 4. Lockout is judged relatively, not against a fixed threshold

A pose estimator **does not** read a locked joint as 180°. It reads whatever the
landmark placement gives, which depends on the person's build and the camera
angle; the same person at 30° and 45° oblique produces different peaks for
identical form. An absolute threshold therefore measures the tracker as much as
the lifter, and field testing showed exactly that: *"straighten your arms fully"*
fired on **every** repetition.

Now each rep is compared against that person's own best peak, in that set, under
that camera. The systematic offset cancels, and what remains is worth flagging:
**reps getting shorter as the set goes on.** The absolute threshold stays as a
backstop, and the cue is spoken **once per set** (`SPEAK_ONCE_PER_SET`) — lockout
is a habit across a set, and hearing it twelve times drowns out the cues that
actually change per rep.

### 5. The counter gate must be looser than the rule threshold

The counter counts **attempts**; the rules judge **quality**. The rules only ever
see repetitions the counter credited.

If `downEnter` is set equal to `depthMax` (the rule threshold), every counted
repetition automatically clears the threshold — and the `shallow_depth` rule
becomes dead code that still looks correct when read on its own. This bug
happened, and it passed the unit tests, because the tests build synthetic
windows that can contain any angle. `rules.test.ts` now checks this relationship
directly against `DEFAULT_CONFIGS`.

### 6. Angles come from world landmarks, not image coordinates

MediaPipe returns two coordinate sets. `landmarks` is normalized to [0,1]
**separately** for width and height, so equal steps in x and y are not equal
physical distances. Computing angles from those gives wrong values, and the size
of the error changes with the camera's aspect ratio. `worldLandmarks` is metric
and free of that distortion. Image coordinates are used only to draw the
overlay.

---

## Deploying your own instance

Served as static files plus serverless functions on Vercel; `vercel.json`
configures the build and the function runtime. The reminder scheduler is
deliberately **not** there — see below.

**The camera demands HTTPS.** `getUserMedia` refuses to run on an insecure
origin, so a LAN address will never be enough. A TLS domain is not a nicety; it
is a precondition for the app functioning at all.

### Functions are written in `server/`, shipped from `api/`

`npm run build:api` bundles each endpoint in `server/` into one standalone file
in `api/`. Vercel only sees the bundle; the source is what is worth reading and
reviewing.

**`api/` is committed even though it is build output.** Vercel validates the
`functions` patterns in `vercel.json` against a freshly cloned repository,
before the build command runs. A directory that only appears at build time does
not exist yet at that moment, and the deploy fails with *"doesn't match any
Serverless Functions"*. The build regenerates it every time, so what actually
ships is always built from the current `server/`.

Bundling also settles a real conflict. Every relative import writes an explicit
`.ts` extension for the sake of the evaluation harness, but Vercel compiles each
file separately and leaves the specifier alone — so the compiled `nutrition.js`
still asks for `'./_llm.ts'`, a file that no longer exists. The deploy succeeds
and every request dies with `ERR_MODULE_NOT_FOUND`. Two obvious fixes were tried
and rejected on evidence: `rewriteRelativeImportExtensions` is honoured by `tsc`
but **not by esbuild**, and esbuild is what Vercel runs; while writing `.js` in
the specifier satisfies TypeScript and Vercel and then breaks Node.

`includeFiles` in `vercel.json` pulls in `data/tkpi/**`: those paths are
computed at runtime, so dependency tracing cannot see them and the nutrition
table would vanish from the bundle without it.

### Environment variables

| Variable | Without it |
|---|---|
| `OPENAI_API_KEY` | narrative, nutrition, meal suggestions, and voice are dead; the fast loop is untouched |
| `ALLOWED_ORIGIN` | origin checking is skipped — set it in production |
| `LLM_DAILY_QUOTA` | the daily ceiling uses the default of 1500 calls |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | rate limiting and reminder subscriptions fall back to per-instance memory |
| `VAPID_PUBLIC_KEY` / `_PRIVATE_KEY` / `VAPID_SUBJECT` | the reminder button hides itself |
| `CRON_SECRET` | `/api/cron-reminders` is open to anyone |

Each variable is explained in `.env.example`.

### Spend limits on the billable endpoints

The three endpoints that call the model — `/api/coach`, `/api/nutrition`,
`/api/meals` — use no authentication, because the product has no accounts and
adding them purely to protect a key is a large feature answering a small
question. What replaces it is in `server/_ratelimit.ts`, in two layers that fail
differently:

- **Per client, per hour** stops the ordinary case: one person, one script, one
  afternoon. It is generous toward real training — one set produces exactly one
  coach call, so 30 per hour is roughly six full sessions.
- **Global per day** caps the bill, because per-client limits mean nothing when
  requests are spread across many addresses.

IP addresses are hashed before being used as keys: the limiter needs to
recognize the same visitor, not know who they are. If Redis is down, requests
are **allowed** rather than refused — losing the limiter is a cost problem,
refusing every request kills the product.

**A third layer sits outside this repository and is the decisive one:** a hard
budget limit on the OpenAI key. Code can be wrong; a provider-side ceiling
cannot be talked around.

### The reminder trigger lives outside Vercel

`vercel.json` deliberately contains **no** `crons` block: the Hobby plan limits
cron to once a day, while reminders have to hit a different hour for every user.
Leaving it in means the deploy is rejected.

Use any scheduler that can call a URL every 15 minutes —
[cron-job.org](https://cron-job.org) is free and punctual enough:

```
URL     : https://<your-domain>/api/cron-reminders
Interval: every 15 minutes
Header  : Authorization: Bearer <CRON_SECRET>
```

That header is mandatory. Without it `isAuthorized()` refuses with a 401 — and
if `CRON_SECRET` itself is unset, it lets everyone through. Fifteen minutes is
not arbitrary: `isDue()` accepts a slot missed by up to twenty minutes, so a
single late cron run does not drop a reminder entirely.

### Before sharing the URL

```bash
npm test && npm run typecheck
npm run build
grep -r "sk-" web/dist/     # must be empty
```

Then, against the real domain: temporarily remove `OPENAI_API_KEY` and confirm
that repetition counting and the cues still work in full. If the workout dies
when the model is unavailable, some path wrongly treats the network as
mandatory.

---

## Privacy claims — how to verify them yourself

Camera frames never leave the device. This is enforced by code, not promised:

1. Run the app, do one set, open **DevTools → Network**. Open the `/api/coach`
   POST that closes the set — **that is the only thing** sent out. It contains
   counts, joint angles in degrees, durations, and error codes; there is no
   field that could hold a frame.
2. In the Console, run `localStorage.getItem('latih.history.v1')` — your entire
   training history is right there, on the device, synchronized nowhere.
3. `assertNoRawPoseData()` in `core/setSummary.ts` rejects any payload
   containing `landmark`, `image`, `frame`, or `base64`. A unit test
   deliberately smuggles coordinates in and confirms it throws.
4. Turn off your internet connection — the repetition counter and the cues keep
   working in full.

The fourth is the strongest precisely because it is the simplest: it is a claim
about **where the computation happens**, and it can be checked with no laptop
and no trust in us whatsoever.

---

## Models & datasets

**We trained no model weights of our own, so there is no Hugging Face artifact
for this submission.** That is a deliberate decision, not an omission:

- **Pose estimation** uses Google's **MediaPipe Pose Landmarker (BlazePose
  GHUM)**, taken as-is as a pre-trained model and fetched automatically by
  `npm run setup:assets`. Those weights are Google's, not an artifact we
  produced or may redistribute.
- **The form classifier was not built.** The fast-loop architecture claimed in
  the paper is joint angles → deterministic rules + state machine, and that is
  what runs. A trained classifier was an extension in the implementation plan,
  not a paper claim, so leaving it undone leaves no claim without code.
  `core/features.ts` (per-rep window → 32×12 tensor) remains as its entry point
  should it ever be trained.
- **The only dataset is TKPI**, the official food composition table of the
  Indonesian Ministry of Health. It is used as a **runtime grounding source**,
  not training data — no model is trained, fine-tuned, or evaluated against its
  distribution. The table is committed at `data/tkpi/tkpi.json` so the paper's
  results can be reproduced straight from the repository with no external
  download.

What we added on top of TKPI is in the repository and runnable: the extraction
script, the extraction and exclusion notes in
[`data/tkpi/README.md`](data/tkpi/README.md), and the Atwater validation that
found 11 inconsistent rows — reproduce it with `npm run check:tkpi`.

---

## License

**Copyright © 2026 Team Kalahin Fam. All rights reserved.**

This code is published for Datathon 2026 judging — so that judges can read,
build, and verify every claim in this document themselves. No reuse license is
granted: copying, modifying, redistributing, or using it for any other purpose
requires written permission from the team.

These terms may change once judging concludes.
