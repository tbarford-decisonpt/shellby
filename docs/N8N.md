# n8n

[n8n](https://n8n.io) connects hundreds of apps. Shellby connects to n8n with
web hooks: no plugin to install, no account, and no server of ours in the middle.
It works both ways:

- **Shellby → n8n.** A workflow step sends something to an n8n workflow, which
  passes it on to any of n8n's apps.
- **n8n → Shellby.** An n8n workflow hands Shellby something to look at. Claude
  reads it, and the answer goes back to n8n.

Two templates on the Automate page set this up, and the two n8n workflows in
[docs/n8n](n8n) import straight into n8n (**⋯ → Import from file**).

> **n8n has to run on this PC** for the n8n → Shellby direction (`npx n8n`, or
> n8n's desktop app). Shellby's port only answers programs on this PC, so
> n8n Cloud and n8n in Docker can't reach it. That's deliberate: anything that
> can reach the port could start Claude on your PC. Shellby → n8n works with
> any n8n, cloud included, since it's only Shellby sending.

## Shellby → n8n

1. In n8n, import [from-shellby.json](n8n/from-shellby.json). It's a
   **Webhook** node listening on `POST /webhook/shellby`, followed by a
   placeholder for whatever should happen next (post to Slack, add a row to a
   sheet…).
2. Activate it. (While you're building it, n8n's test address is
   `/webhook-test/shellby` instead, and only listens after **Listen for test
   event**.)
3. In Shellby, start from the **Tell n8n when a task finishes** template. Its
   one step posts each finished task to `http://localhost:5678/webhook/shellby`.
   Change the address if your n8n runs elsewhere (n8n Cloud gives you an
   `https://….app.n8n.cloud/webhook/…` one).

What n8n receives:

```json
{ "event": "task", "title": "Fix the login redirect", "outcome": "ok", "folder": "C:\\Users\\you\\code\\site", "error": "" }
```

Any workflow can do the same with a **Web request** step. A run's result, a
Claude summary or a failing build can all go to n8n.

## n8n → Shellby

1. In Shellby, start from the **Look at what n8n sends** template and save it.
   Open its **Web hook** trigger and copy the token. (Web hooks need
   **Settings → Claude Code everywhere** turned on, since that's what opens
   Shellby's local port.) Items that arrive while one is being read wait their
   turn.
2. In n8n, import [ask-shellby.json](n8n/ask-shellby.json) and paste the token
   over `PASTE_THE_TOKEN_FROM_SHELLBY` in **Send to Shellby**.
3. Press **Execute workflow**. n8n sends the item and pauses at **Wait for
   Shellby's answer**. Claude reads the item in Plan mode (it can look, but it
   can't change anything) and posts back:

```json
{ "summary": "Checkout shows a blank page for customers since this morning.", "urgent": true }
```

What n8n sends Shellby:

```http
POST http://127.0.0.1:47913/v1/flow
X-Shellby: 1
Content-Type: application/json

{ "hook": "<token>", "data": { "item": "…", "resume_url": "{{ $execution.resumeUrl }}" } }
```

Every field in `data` arrives as `{{ trigger.* }}`, and fields named like the
workflow's inputs (`item`, `resume_url`) fill them. `resume_url` is n8n's own
address for the paused run. The workflow's last step posts the answer there,
and n8n carries on. Leave it out and the run just ends in Shellby.

The answer only goes to `http://localhost:5678/webhook-waiting/…`, n8n's
waiting address on this PC, whatever `resume_url` says, so whoever sends an
item can't send the answer somewhere else. If your n8n uses another port, change
the address in the template's **If** step, and the `38` (the address's length)
in the step before it.

### What n8n can and can't make Claude do

What arrives from n8n goes into Claude's prompt marked as data, with a note
saying it's data, not instructions, like everything else from outside a
workflow. So the instructions are always the ones you wrote in Shellby: "sum
this up", "triage this ticket", "draft a reply". n8n supplies the thing to work
on. To have n8n hand Claude open-ended tasks, start a Claude Code session from
n8n instead.

In Plan mode Claude can't change anything, but it can still read files, and
its summary goes back to n8n. If the items come from strangers (a public form,
an inbox), keep the workflow's folder somewhere with nothing private in it, and
read what n8n passes on before it goes anywhere public.

## Ideas

- **New support email → summary in Slack:** n8n's Gmail trigger → Ask Shellby
  → Slack, posting the summary when `urgent` is true.
- **Every pull request merged → changelog line:** a GitHub trigger in n8n,
  Claude writes the line, and n8n adds it to a Notion page.
- **Shellby's red build → PagerDuty:** a **CI** trigger in Shellby, then a
  **Web request** step to an n8n webhook that pages whoever's on call.
