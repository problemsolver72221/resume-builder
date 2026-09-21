<div align="center">

# ✨ Tailored Resume Builder

**AI-powered resume and cover letter generation with ATS optimization**

[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org/)
[![Express](https://img.shields.io/badge/Express-4-green?logo=express)](https://expressjs.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)](https://www.typescriptlang.org/)
[![OpenAI](https://img.shields.io/badge/OpenAI-GPT--5.1-412991?logo=openai)](https://openai.com/)
[![Anthropic](https://img.shields.io/badge/Anthropic-Claude-orange)](https://anthropic.com/)

</div>

---

## 📖 Overview

Tailored Resume Builder is a full-stack application that generates tailored resumes and cover letters for job applications. Paste a job description, and the AI analyzes it to optimize your resume with relevant keywords, rewrite experience sections, and craft a professional cover letter.

### ✨ Features

| Feature | Description |
|---------|-------------|
| **Single or Batch** | Generate for one profile or all profiles at once |
| **ATS Optimization** | AI extracts keywords and tailors content for applicant tracking systems |
| **Multiple Templates** | Choose from various resume styles (one-column, two-column, etc.) |
| **Cover Letters** | Auto-generated PDF and DOCX cover letters, randomised per letter, and switchable off per run |
| **Profile Templates** | Each profile can have its own preferred template style |
| **Admin Panel** | Manage profiles, templates, and AI model settings |
| **PDF & DOCX** | Export resumes in both formats |

---

## 🏗️ Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Next.js 16    │────▶│  Express API    │────▶│  OpenAI/Claude   │
│   Frontend      │     │  Backend        │     │  AI Services     │
│   (React 19)    │     │  (Port 3001+)   │     │                  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                        │
        │                        ├── Profiles (JSON)
        │                        ├── Templates (HTML/Handlebars)
        │                        └── Generated (PDF/DOCX)
        └── Admin Panel (Profiles, Templates, Settings)
```

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** 18+
- **OpenAI API Key** (for GPT-5.1)
- **Anthropic API Key** (optional, for Claude)
- **OpenRouter API Key** (optional, for OpenRouter)
- **you.bot API Key** (optional, for you.bot — https://you.bot)
- **CheapAI API Key** (optional, for CheapAI — https://cheapai.io)

### 1. Clone & Install

```bash
git clone <repo-url>
cd ResumeBuilder

# Install backend dependencies
cd backend && npm install && cd ..

# Install frontend dependencies
cd frontend && npm install && cd ..
```

### 2. Environment Setup

Create a `.env` file in the project root:

```env
# Required for OpenAI
OPENAI_API_KEY=sk-your-openai-key

# Optional for Claude
ANTHROPIC_API_KEY=sk-ant-your-anthropic-key

# Optional for OpenRouter
OPENROUTER_API_KEY=sk-or-v1-your-openrouter-key
OPENROUTER_MODEL=openai/gpt-5.4-nano

# Optional for you.bot (https://you.bot)
YOUBOT_API_KEY=sk-live-your-youbot-key
YOUBOT_MODEL=claude-haiku-4-5,claude-sonnet-5,gpt-5-6-luna,gemini-3-7-flash,gemini-3-8-flash,gemini-3-flash

# Optional for CheapAI (https://cheapai.io) — OpenAI-compatible; model ids as listed at https://cheapai.io/models
CHEAPAI_API_KEY=sk-your-cheapai-key
CHEAPAI_MODEL=claude-haiku-4-5-20251001,claude-sonnet-5,gpt-5.6-luna,gemini-3.7-flash,gemini-3.8-flash
# CHEAPAI_REASONING_EFFORT=low   # its Claude models think at length (and time out) at anything higher

# Admin panel password
ADMIN_PASSWORD=your-secure-password

# Server config (both optional; the port is the first one tried, not a fixed one)
# PORT=3001
# FRONTEND_URL=http://localhost:3000
```

`frontend/.env.local` only matters when the frontend is started on its own; `npm run dev`
from the root sets the API URL itself (see below).

```env
NEXT_PUBLIC_API_URL=http://localhost:3001/api
```

### 3. Run

```bash
npm run dev          # from the project root: starts both halves, wired together
```

- **Frontend:** http://localhost:3000
- **Backend API:** http://localhost:3001
- **Admin Panel:** http://localhost:3000/admin

#### Several copies at once

Ports are chosen at start-up, not fixed, so the project can be copied into as many folders
as you like and every copy run at the same time. Each one takes the first free adjacent
pair — the first copy gets 3000 (frontend) and 3001 (backend), the second 3002 and 3003,
the third 3004 and 3005 — and the launcher points each frontend at the port its own backend
actually bound, so no copy ever talks to another copy's data. Copies that start at the same
instant sort themselves out: the backend walks upwards when a port is claimed under it, and
the frontend is restarted a port higher. The startup line names the pair:

```
[dev] starting this copy on 3002 (frontend) and 3003 (backend)...
```

Set `PORT_BASE` to move a copy out of the way entirely (`PORT_BASE=4000 npm run dev`).

The frontend finds its backend on **its own port + 1** whenever `NEXT_PUBLIC_API_URL` is not
set, so a copy served on 3002 calls the backend on 3003 without being told. That is why
`frontend/.env.local` ships with the variable commented out: a value there is baked into
every copy of the folder and would send them all to the same backend. Set it only when a
backend deliberately runs somewhere other than the frontend port + 1.

Starting the halves by hand still works, but Next does not pick a free port on its own, so
the second copy onwards needs one: `cd backend && npm run dev` in one terminal and
`PORT=3002 npm run dev` in `frontend/` in another. The backend still finds its own port.

---

## 📁 Project Structure

```
ResumeBuilder/
├── shared/                  # The contract between the two halves — types only
│   └── types/              # profile, jobAnalysis, resume, template (.d.ts)
├── backend/                 # Express API
│   ├── src/
│   │   ├── routes/         # API routes (profiles, templates, resume, admin)
│   │   ├── providers/      # AI provider registry + one adapter per provider
│   │   ├── services/       # AI, PDF, DOCX, cover letter generation
│   │   ├── config/         # Storage paths
│   │   └── types/          # Re-exports of shared/, plus backend-only shapes
│   ├── test/               # node:test suites, no framework
│   └── data/
│       ├── profiles/       # Profile JSON files
│       ├── templates/      # Resume templates (JSON with HTML)
│       │   └── m/          # Custom templates (e.g. one-column-clean)
│       └── config/         # AI model config
├── frontend/               # Next.js app
│   ├── src/
│   │   ├── app/            # Pages (/, /admin/*)
│   │   ├── components/     # Reusable UI components
│   │   ├── features/       # Feature logic, framework-free (see below)
│   │   │   └── builder/model/   # The batch loop, ports and messages
│   │   └── lib/            # API client, retry passes, saved-run storage
│   └── test/               # node:test suites over features/, no framework
└── generated/              # Output: resumes, cover letters (PDF/DOCX)
```

### Where logic lives

`frontend/src/features/*/model/` is deliberately free of React, of `fetch` and of any
import from `components/`. The batch loop is the most intricate code in the app — retry
passes, resumable runs, one analysis shared across a job's profiles — and it used to be a
closure over a dozen pieces of component state, which made it impossible to test. It now
runs against a `BuildPort` interface, so `npm test` drives the real loop with fakes: no
browser, no backend, and no waiting out the real retry delays.

Anything shaped like a decision (what to build next, what a run's ending means, what the
user is told) belongs in `model/`. The component keeps `useState` and JSX.

### Tests

```bash
npm test              # from the root: both halves
npm run test:backend  # tsc, then the node:test suites
npm run test:frontend # node:test over the builder model
```

Both suites use Node's built-in test runner with **no test framework and no dependency**.
The frontend suite runs TypeScript directly on Node's native type stripping; a small
resolver hook (`frontend/test/alias-hook.mjs`) teaches Node the `@/` and `@shared/` path
aliases that tsc and the bundler already understand.

---

## 📤 Output Structure

Generated files are saved in:

```
{profile}/{date}/{company}/{role}/
├── {profile}.pdf
├── {profile}.docx
├── {profile}_cover_letter.pdf
└── {profile}_cover_letter.docx
```

- **Date** uses CST (America/Chicago) timezone  
- **Example:** `john_doe/2025-02-21/acme_corp/software_engineer/`

---

## ⚙️ Admin Panel

| Section | Purpose |
|---------|---------|
| **Profiles** | Create/edit candidate profiles (experience, skills, education, preferred template) |
| **Templates** | Upload PDF templates, preview styles, enable/disable |
| **Settings** | Configure AI model providers, builder defaults, and whether cover letters are written at all |

### A note on the admin panel

The login screen is a UI convenience, not a security boundary. `validatePassword` accepts
any password and `authMiddleware` lets every request through (`backend/src/middleware/auth.ts`,
pinned by `backend/test/auth.test.js`), so every route marked "(protected)" in the source is
in fact open to anything that can reach the port. That is a deliberate choice for a
single-user tool on loopback, and worth knowing before the backend is bound to an address
other machines can reach: `PUT /api/admin/settings` can point `outputBaseDir` at any
absolute path, which `/api/generated/:filename` will then serve from. The token machinery
in `auth.ts` is complete and correct; turning it on is a two-line change documented there.

---

## 🔧 Configuration

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | Required for OpenAI (GPT) |
| `ANTHROPIC_API_KEY` | Optional for Claude |
| `OPENROUTER_API_KEY` | Optional for OpenRouter |
| `OPENROUTER_MODEL` | Optional OpenRouter model slug (default: `openai/gpt-5.4-nano`) |
| `YOUBOT_API_KEY` | Optional for you.bot |
| `YOUBOT_MODEL` | Optional you.bot model list (default: `claude-sonnet-5,claude-haiku-4-5,gpt-5-6-luna,gemini-3-7-flash,gemini-3-8-flash,gemini-3-flash`) |
| `YOUBOT_REASONING_EFFORT` | Reasoning depth for you.bot's GPT and Gemini models: `Low` (default), `Medium`, `High` or `XHigh` (Gemini 3 Flash documents only `Low` and `High`). Reasoning is billed as output tokens, so the default is the cheapest level |
| `YOUBOT_BASE_URL` | Optional you.bot API base (default: `https://you.bot/api/v1`) |
| `YOUBOT_TASK_TIMEOUT_MS` | Optional cap on one you.bot generation, in ms (default: 300000) |
| `YOUBOT_MAX_OUTPUT_TOKENS` | Output-token ceiling sent to you.bot (default: 12000). you.bot reserves the worst-case cost of this number *before* each call (about 0.55 credits per 1,000 tokens), so a ceiling larger than your balance can cover makes every call fail with "insufficient credits" |
| `CHEAPAI_API_KEY` | Optional for CheapAI (https://cheapai.io), an OpenAI-compatible gateway |
| `CHEAPAI_MODEL` | Optional CheapAI model list, ids as the catalog spells them (default: `claude-haiku-4-5-20251001,claude-sonnet-5,gpt-5.6-luna,gemini-3.7-flash,gemini-3.8-flash`) |
| `CHEAPAI_MAX_OUTPUT_TOKENS` | Output-token ceiling sent to CheapAI (default: 16000) |
| `CHEAPAI_TIMEOUT_MS` | Per-attempt cap on one CheapAI call, in ms (default: 180000); the client library's own retries are off and the dispatcher retries transient failures with backoff |
| `CHEAPAI_REASONING_EFFORT` | Reasoning depth sent to every CheapAI model as `reasoning_effort`: `none`, `minimal`, `low` (default), `medium`, `high` or `xhigh`. Its Claude models think at length at anything above `low`, which is what pushed Sonnet 5 past the gateway's two-minute limit |
| `BUILD_DEADLINE_MS` | Longest a resume route may take before it is answered with a retryable 503 and the build is retried later (default: 1800000, 30 minutes; 0 disables) |
| `OPENAI_MAX_OUTPUT_TOKENS` / `CLAUDE_MAX_OUTPUT_TOKENS` / `OPENROUTER_MAX_OUTPUT_TOKENS` | Output-token ceilings for the other providers (defaults: 16000 / 16000 / 11000) |
| `AI_RETRY_BUDGET_MS` | How long one AI call keeps retrying transient failures (overload, rate limits, timeouts, empty replies) with backoff before giving up (default: 600000, ten minutes; 0 disables) |
| `AI_KEY_DEBUG` | Set to `1` to log which (masked) API key each AI call used |
| `CLAUDE_MODEL` | Override the Claude model (default: `claude-sonnet-4-20250514`) |
| `ADMIN_PASSWORD` | Signing secret for the admin session token. **Not a credential**: the backend accepts any password and every route is served unauthenticated — see "A note on the admin panel" below |
| `PORT` | First backend port to try (default: 3001). A port another copy already holds is skipped, two at a time |
| `PORT_BASE` / `PORT_STEP` / `PORT_ATTEMPTS` | Read by `npm run dev` at the root when it picks a free frontend/backend pair (defaults: 3000, 2, 25) |
| `FRONTEND_URL` | Extra allowed CORS origins, comma-separated. Any port on localhost or 127.0.0.1 is allowed already, because the frontend port is not fixed |
| `OPENAI_MODEL` | Override default model (default: `gpt-5.1`) |

Every `*_MODEL` variable takes a comma-separated list. The first entry is that provider's default, and each entry becomes its own choice in the builder's model picker — so `YOUBOT_MODEL=claude-haiku-4-5,claude-sonnet-5` runs Haiku unless Sonnet is picked for a run. The backend reads the list at startup; a request naming a model that is not listed is refused rather than quietly run on the default.

you.bot fronts several vendors behind one endpoint, and their models do not take input the same way. Each model id is matched by prefix to a family in `backend/src/providers/adapters/youbotModels.ts` that knows what its vendor accepts, checked against the live API: Claude models get cache-marked content blocks, `thinking` and `web_search` off, and an enforced `max_tokens`; GPT models a `reasoning_effort` level, no temperature, and no `web_search` field at all, because Luna rejects it whether it is true or false; Gemini models flat text with `thinking` off plus a reasoning level, because the switch alone is ignored. you.bot applies `max_tokens` to Claude models only (Gemini wrote a full essay under a limit of 8), so the other families have no output cap and their `outputTokens` include hidden thinking, billed as output. Adding a you.bot model of a known family is therefore one more entry in `YOUBOT_MODEL`; a model from a new vendor, or one that departs from its family, is one more entry in that file. The API key must also be allowed to call the model: you.bot keys carry an allowed-models list in the dashboard, and a model outside it fails with a 403 `model_not_allowed` that names the model.

---

### Prompt caching

Every AI call is sent as ordered segments: the prompt's fixed rules first, then the data that is identical across a batch (the job analysis), then the only per-candidate text (the profile). Providers that cache identical prefixes — Anthropic, you.bot and CheapAI via `cache_control` content blocks, OpenAI automatically — bill the earlier segments at a tenth of the input rate after one cache write, which is roughly a quarter off a tailoring call and more in a multi-profile run. Output tokens are unaffected.

For this to work a prompt template must keep its `[[variables]]` at the **end**, in that order; `renderPromptSegments` warns when a template is not ordered that way. The you.bot adapter logs one line per call (`… uncached in / … out — X credits`). you.bot reports only the *uncached* input tokens and never fills its cache counters, so a cache hit shows as a small input figure and a much smaller charge, not as a "cached" count. `YOUBOT_PROMPT_CACHE=0` sends flat text instead. Only you.bot's Claude models honour the markers (its documentation says other models ignore them), so GPT and Gemini models receive the same prompt as flat text, stable part first, and any caching there is whatever their vendor applies on its own, which the app can neither request nor see. CheapAI's OpenAI-compatible chat endpoint passes the same markers through as content parts, so its Claude models get the same prefix caching (verified: a marked prefix above the minimum was written once, then read from cache on every later call); its GPT and Gemini models accept the parts and ignore the marker.

A caveat on CheapAI: its Claude models introduce themselves as "Claude Code, Anthropic's official CLI" and carry that tool's hidden system prompt, which is presumably how the service undercuts the official API. In testing, Sonnet 5 followed the tailoring prompt every time and Haiku refused it once in three tries ("I won't reproduce my setup text"), still billing the cached prefix. A request it never answers is cut off after `CHEAPAI_TIMEOUT_MS` rather than the client library's default of ten minutes times three attempts. Treat CheapAI as an unofficial resale of Claude access: fine for experiments, not something to run a large batch on without a fallback provider. Its Claude models also think before answering unless told not to: Sonnet 5 spent 6,400–8,000 hidden thinking tokens per tailoring call, about 80 s during which the gateway sends nothing (its streaming only starts once the answer does), and its Cloudflare front cut every full build off with HTTP 524 at the two-minute mark, with or without streaming, a `thinking` switch, or a smaller output budget. The adapter therefore sends `reasoning_effort` on every CheapAI call, `low` unless `CHEAPAI_REASONING_EFFORT` says otherwise: with it Sonnet 5 answers a full build in about 45 s with no thinking tokens, Haiku in about 27 s, and GPT and Gemini ids take the field as their native one. A 524, should one still happen, is reported as a permanent failure and never re-sent, because the origin usually finishes and bills the first attempt anyway.

### What a run costs

Output tokens dominate a tailored resume — after prompt caching they are roughly 88% of the bill — so the levers that matter are the ones that shorten the reply:

- **Cover letter off.** The letter is the single largest block of output in a call. The builder has a per-run toggle and Admin -> Settings has the default. Switched off, the prompt tail carries an override instead of a brief, so both modes still share one cached prefix.
- **Roles are merged, not echoed.** The model returns an `index` into the candidate profile plus only the prose it writes; employer, title, dates and location are merged back in from the profile by `backend/src/services/utils/experienceMerge.ts`. That saves the tokens the model used to spend retyping them, and means a drifting company name or date cannot reach a document.
- **Skills are mixed per candidate, not copied from the posting.** The analysis keeps a posting's 60 most important hard-skill keywords. Each resume's 45-item skills section is then composed in code (`backend/src/services/utils/skillMix.ts`): the candidate's own skills that the posting also names, then the posting's required skills, then every remaining skill the candidate's own profile evidences (nothing of theirs is dropped), and finally a random draw from the rest of the posting's keywords weighted by their priority, all in an order seeded by candidate + job. Soft skills follow the same pattern, 12 to 15 per resume. Posting keywords go on the resume whether or not the skills database knows them; the unknown ones are listed for review in the builder, and confirming one adds it to the database. The prompt asks the model to weave in only the keywords the profile honestly supports and never to answer in prose, so a posting the candidate cannot match yields an honest resume plus the keyword section, not a fabricated one and not a refusal. Nine candidates applying for the same posting never share a list, and because the mix happens after the model call, the cached job block is unchanged.

### Long batch runs

A Sheets import of many jobs against many profiles is driven from the browser tab, one build at a time, and can take hours. Things that keep it alive:

- **Failures are retried until they succeed.** Every AI call retries transient failures — a provider overloaded, rate-limiting, timing out, or answering with nothing — with backoff for up to `AI_RETRY_BUDGET_MS`. Above that, the builders make retry passes: after a pass, every build that failed for a transient reason is run again, with waits of 30 s, then 1, 2, 4, 8 and 10 minutes between passes. Builds already on disk are skipped on later passes, so a retry never pays twice. Two failures are never re-sent within a call but do get later passes, because they depend on the moment: a Cloudflare 524 (the model too slow for the request just then) and a model declining a build in prose (not deterministic; Haiku declined one posting in three, then wrote it). A build that still fails after 8 attempts is parked rather than held forever. Only failures that need a person stop the retrying at once — a bad key, no credits, a model the key may not call, a malformed request. Everything not generated stays in the saved run for Resume. **Stop after the current build** ends a run.
- **A request that never answers is abandoned, then retried.** The backend answers every resume route within `BUILD_DEADLINE_MS` (default 30 minutes) or with a retryable 503, and the browser gives up on a build after 32 minutes on its own; either way the build is retried in a later pass, and files the late build wrote are found by the skip-existing check. Chrome renders (resume and letter PDFs) are bounded too. Before this, one hung request held a batch forever ("some process is not finished").
- **Run built servers, not the dev ones.** `npm run dev` restarts the backend (`tsx watch`) and hot-reloads the frontend on any source edit, which kills a run in progress; the page shows a notice while it runs on the dev server. For a long batch use `npm run build && npm start` in both `backend/` and `frontend/`.
  Both frontend scripts pass `--webpack` on purpose: on Node 26, Turbopack's native binary
  segfaults (`next build` exits with `0xC0000005` and prints nothing at all), while the
  webpack builder compiles the same sources fine. Drop the flag once that is fixed upstream
  or the toolchain moves to a Node version Turbopack's prebuilt binding supports.
- **Every bulk run can be resumed.** A Sheets import and the manual builder's multi-profile generation are both saved in the browser as they run: the jobs, every analysis already paid for, preview edits, and the status and attempt count of each job × profile build. When a run ends with builds not generated (you stopped it, the tab closed, or failures needed a person), the page shows **Resume N build(s)** whichever builder is open. Resume reruns only those, with the model selected at that moment, reuses the saved analyses, and skips files already on disk; **Discard** forgets the run. Only the last run is kept. A run found still marked in progress after a page load was interrupted (a reload, a crash, a discarded tab): the page then resumes it by itself after a 20-second countdown, with the run's own model, unless you cancel; the browser also asks before you close or reload a tab with a run going. A run pins the date folder its first build used, so builds after midnight and resumes on later days land in the same folder as the rest. A re-imported sheet checks the disk before analysing each job, so re-running an import that was made before this feature existed only pays for the builds that are missing, provided it is re-run on the same day (the date folder) or the files are found under that date.
- **Skip builds already on disk** (on by default in the Sheets builder) makes a restarted import resume: a job whose expected files — resume PDF/DOCX and, when enabled, the cover letter — already exist under the same output path is answered from disk with no AI call. It is all-or-nothing per build, so a run that died between a resume and its letter regenerates both, and an empty file from an interrupted write does not count. Turn it off to deliberately regenerate everything.
- **Crashes are logged, not silent.** An unhandled rejection or uncaught exception is written to the backend log with a timestamp and stack, and the server keeps serving; restart it once the batch has finished if either appears.
- Splitting a batch across browser tabs is fine — split by **job rows** (each tab a different row range, all profiles) so each job is analysed once and its profiles run back-to-back for caching, not by profile.

### Adding an AI provider

Providers are declared once in `backend/src/providers/registry.ts`. Add an entry there, write an adapter in `backend/src/providers/adapters/`, and register it in `backend/src/providers/index.ts` — settings, API-key storage, and both UIs pick the new provider up automatically.

### Job families and keyword forms

Nothing in the tailoring pipeline assumes a software posting. Each posting is matched to a **job family** (`backend/src/services/jobFamilies/registry.ts`) from the analysis's title, department and industry. The family supplies the verb pool the model is offered for bullets, the headings of the skills, strengths and certifications sections, the headline printed under the candidate's name (the posting's role family with the candidate's own seniority, never an invented title), how much certifications weigh, and which words name a role rather than a skill. A posting nothing matches gets the generic family. Adding a family is one entry in the registry; no other code names a family.

Keyword spellings live in `backend/data/skills/keyword-forms.json`. An `acronym` group renders both forms in the skills section — `Infrastructure as Code (IaC)` — so a scorer matching either spelling finds it, and the prompt asks for the same pairing at first mention in prose. An `alias` group (`PostgreSQL` / `Postgres`) only makes the spellings count as one keyword when the candidate's skills are matched against the posting's. Pairs the posting itself spells out are extracted by the analysis and merged in per job. Posting keywords are otherwise kept verbatim: the model's own hard/soft classification decides what is a skill, and the only things filtered out are role names and the posting's own title. The analysis also captures the certifications and licenses a posting names; a resume mentions one only when the profile holds it, and a profile's certifications render in their own section.

---

## 🛠️ Tech Stack

| Layer | Technologies |
|-------|--------------|
| **Frontend** | Next.js 16, React 19, Tailwind CSS 4 |
| **Backend** | Express, TypeScript |
| **AI** | OpenAI SDK (GPT-5.1), Anthropic API (Claude), OpenRouter API, you.bot API, CheapAI API |
| **PDF** | Puppeteer |
| **DOCX** | html-to-docx |
| **Templates** | Handlebars |

---

## 📄 License

ISC

---

<div align="center">

**Built with ❤️ for job seekers**

</div>
#   r e s u m e - b u i l d e r  
 #   r e s u m e - b u i l d e r  
 