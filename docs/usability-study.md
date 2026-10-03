# Does Attune help people finish the work?

This is a protocol for a small formative study, not a report of measured
benefit. The project has software tests and model evaluations; it does not yet
have evidence that adaptation improves task completion or reduces effort.

## Question and participants

Test one question first: does bringing related records into one workspace
help someone resolve a client request without losing their place?

Start with 6–8 people who regularly handle client requests, invoices and task
lists. Use these sessions to find failures and decide what to measure in a
larger study. Do not treat this sample as proof of a population-wide speedup.

## Conditions

Use the same build, viewport, fixture data, Comfortable density and starting
panels. Use a fresh browser context for each condition so saved pins, habits,
settings and welcome state do not carry over. Record the build and model
version, request latency, and whether any response fell back to demo rules.

| Condition | Setup | What it isolates |
| --- | --- | --- |
| Fixed | Focus → Fixed workspace | Manual navigation through the same panels and data |
| Rules | Start the API with both model keys empty; Full adaptation; header says Demo rules | The contribution of deterministic adaptation |
| Model | API connected to the model; Full adaptation; verify source in Inspector | The additional contribution of model judgments |
| Suggestions only (follow-up study) | Same connected model; Suggestions only | Whether suggestions provide the benefit with less movement |

To run without a model locally:

```sh
JEV_API_KEY='' TYPESAFE_API_KEY='' pnpm dev
```

The setting `frozen` in Inspector is a diagnostic pause, not the fixed
condition. Keep other Focus aids identical across the adaptive conditions.

Counterbalance the order of the first three conditions across participants:
Fixed–Rules–Model, Rules–Model–Fixed, Model–Fixed–Rules, and their reverses.
Record trial order because seeing the same invoice again creates a learning
effect. Do not pool repeat attempts as if they were independent participants.

## Session script

1. Let the participant read the introduction and use Guide me once. Explain
   that the studio is fictional. Record onboarding problems separately; do
   not include the walkthrough in task timing.
2. Start a fresh context and configure the assigned condition. Hide Inspector
   during the task. Give this task without naming navigation controls:
   “Priya says the Harbor invoice email bounced. Find the request, resend the
   right invoice, and record that the follow-up is finished.”
3. Start the timer when the participant begins. End it when INV-1042 has a
   resend timestamp and task t-1 is complete. A different invoice, a premature
   completed task, or marking an invoice paid counts as an error. Record any
   facilitator help. No real email or payment occurs in the demo.
4. In a separate interruption task, ask them to inspect Meridian's install
   request, then return to Harbor and identify what they had just completed.
   Measure return time and whether filters and selections need rebuilding.
5. Ask: “What changed, and why?” “Did anything move when you did not want it
   to?” “How much control did you feel you had, from 1 to 7?” “How much effort
   did that take, from 1 to 7?” Ask which condition they would use daily and why.
6. Repeat with the other assigned conditions. On a later day, repeat the
   comparison to separate first-visit appeal from a usable daily workflow.

## Record and compare

Capture one row per participant, condition and task, using anonymous IDs:

```csv
participant,session,trial_order,condition,build,model,task,completed,seconds,errors,assisted,return_seconds,control_1_to_7,effort_1_to_7,manual_opens,layout_changes,undos,fallback_rounds,notes
```

Use Inspector → Metrics for supporting counts: manual navigation, layout
changes, Undo, and accepted suggestions. These counters describe interaction;
they do not measure task correctness, time saved or cognitive load. Record
task outcomes and participant ratings separately. No study data is uploaded
by the guide.

Compare each participant's completion and errors before comparing median
times. Report the range, trial order and assisted attempts. Look for movement
that interrupts reading or causes a wrong click. Separate trials with model
failures instead of calling them model successes.

## Decision after the pilot

Keep a broader adaptive default only if the observed task benefit survives
repeat use and participants can explain and control the changes. If assistance
helps but movement causes errors or loss of control, test Suggestions only as
the default next. If rules perform similarly to the model, prefer the simpler
behavior for that workflow and investigate where semantic judgments add value.

Publish the task, sample size, conditions and limitations alongside any
result. Do not translate prediction accuracy or lower click counts directly
into claims about productivity or accessibility.
