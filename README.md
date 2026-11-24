# Trail

Trail is a local web app for reviewing pull requests, built for changes written by AI
coding agents. It runs on your own machine, reads pull requests through your GitHub login,
and has Claude Code next to the diff to explain code and make changes.

It helps with the three things that make AI-written pull requests tiring to review:

| Problem | What Trail does |
| --- | --- |
| The change is spread over many files, listed alphabetically. | Claude writes a **walkthrough**: the hunks grouped into chapters, in the order the logic runs. |
| Small methods were moved between files, shown as a deletion and an addition. | **Moved code is folded** into one line that links to where it went. |
| You have to leave the diff to see what a function does. | **Click any name** in the diff to see its definition and usages. |

## Quick start

You need [Bun](https://bun.sh), `git`, [Claude Code](https://claude.com/claude-code) and the
[GitHub CLI](https://cli.github.com). Check that the last two are logged in:

```sh
claude --version
gh auth status
```

Then, in this folder:

```sh
bun install
bun run build
cp .env.example .env
```

Open `.env` and set `TRAIL_OWNER` to the GitHub user or organisation that owns your
repositories. Now review a pull request by repository name and number:

```sh
bun trail my-repo 123
```

The first time you open a repository, Trail clones it, which can take a minute. Your
browser then opens the review at http://localhost:4477.

## Commands

Run these from this folder.

### Opening one pull request or a local repository

| Command | What it reviews |
| --- | --- |
| `bun trail my-repo 123` | Pull request 123 of `<TRAIL_OWNER>/my-repo` |
| `bun trail my-repo 123 --owner other-org` | The same, under another owner, for this command only |
| `bun trail other-org/my-repo 123` | The owner can also be written with the repository |
| `bun trail other-org/my-repo/123` | The same in one word |
| `bun trail https://github.com/owner/repo/pull/123` | A pull request by its GitHub address |
| `bun trail github.com/owner/repo/pull/123/files` | Any pasted form of that address works: without `https://`, or with `/files`, `?diff=split`, `#discussion…` after the number |
| `bun trail ~/code/app` | A local repository: its current branch against the base branch, uncommitted changes included. A local path starts with `.`, `/` or `~` |
| `bun trail ~/code/app --base develop` | The same, against a base branch you choose |

### Choosing from a list

Leave out the number and Trail lists the pull requests for you to pick one, so you never
have to look the number up on GitHub.

| Command | What it lists |
| --- | --- |
| `bun trail my-repo` | Open pull requests of `<TRAIL_OWNER>/my-repo` |
| `bun trail other-org/my-repo` | The same for any repository. Its address (`github.com/other-org/my-repo`) works too |
| `bun trail --list` | Open pull requests waiting for your review, across `TRAIL_OWNER` (across all of GitHub when no owner is set) |

In the list, use the arrow keys and press Enter to open the pull request in Trail. Start
typing to narrow the list by title, number, author or branch; `author:name`,
`reviewer:name` and `label:name` look in one field. Tab switches between all pull
requests, those waiting for your review, and your own. Esc leaves.

Each row shows the size of the change, its age, and its review state: draft, approved,
changes requested, or whose review is requested. Pull requests you have already opened in
Trail show how far you got.

Lists across repositories (`--list`) come from GitHub's search, which reports less: no
sizes and no review state. There, a row says nothing about reviews, which does not mean none
is needed, and the "waiting for my review" tab is only offered when that is what was asked for.

To fetch a narrower list from GitHub in the first place, add filters:

| Filter | Meaning |
| --- | --- |
| `--mine` or `--author <login>` | Written by you, or by someone else |
| `--for-me` or `--reviewer <login>` | Review requested from you, from someone else, or from a team (`org/team`) |
| `--label <name>` | Carrying a label |
| `--state open\|closed\|merged\|all` | Default is `open` |
| `--search "<words>"` | Anything in GitHub's search syntax. Write `--search=-label:wip`, with `=`, when it starts with a dash |
| `--limit <n>` | How many to fetch. Default is 50 |

For example, `bun trail my-repo --for-me` lists what is waiting for you in one repository,
and `bun trail --list --mine` lists your own open pull requests across `TRAIL_OWNER`.
Across repositories, giving any filter replaces the default "waiting for your review".

When the output is piped instead of shown in a terminal, the list is printed one pull
request per line. Leaving the list with Ctrl-C ends with exit status 130.

### Other commands

| Command | What it does |
| --- | --- |
| `bun trail` | Opens the list of your reviews |
| `bun trail stop` | Stops Trail's background server |
| `bun trail --help` | Lists all commands |

Add `--no-open` to any command to print the address without opening the browser.

Quote an address that contains `?` or `#` so your shell passes it through unchanged. Only
github.com is supported.

How Trail tells a folder from a GitHub name:

- Anything starting with `.`, `/` or `~` is a folder. Write a folder in the current
  directory as `./my-folder`.
- Any other word is read as a GitHub repository or pull request.
- When such a word also exists on disk, Trail stops and asks which one you mean, instead of
  guessing. Two exceptions, where only one reading is possible: with `--base` it is the
  folder, and a single name with no owner configured is the folder. The box
on the home page accepts the same forms.

To use `trail` from any folder, run `bun link` here once. After that `trail my-repo 123`
and `trail .` (review the repository you are standing in) work everywhere.

## The review page

The page has three columns.

**Left: where you are.** Two tabs. *Walkthrough* lists the chapters once you have generated
one; *Files* lists the changed files. Each entry shows how many of its hunks you have viewed.

**Middle: the diff.**

- Press **Generate walkthrough** on the overview to have Claude order the change into
  chapters. Each chapter explains what that step does and what to check. Every hunk appears
  in exactly one chapter; anything Claude did not place gets its own chapter, so nothing is
  hidden.
- Code that only moved shows as one folded line, such as *12 lines moved unchanged to
  src/validation.ts:4*. Click the path to see the other side, or *show lines* to unfold it.
- Underlined names are links. Click one to see its definition and usages in the right-hand
  column, and keep clicking there to follow the chain.
- Tick **Viewed** on a hunk when you are done with it. It collapses, and the progress bar
  at the top advances.
- Hover a line and press **+** to leave a note on it.
- Select some code to get **Explain**, **Ask Claude** and **Find problems** buttons.

**Right: Claude, Navigate, Notes.**

- *Claude* is a chat with Claude Code, which reads the repository to answer. In **Ask**
  mode it can only read. In **Edit** mode it can change files; you see the resulting diff
  and decide whether to discard it or commit and push it.
- *Navigate* shows the definition or usages you clicked on.
- *Notes* lists your notes. From there you can post them to GitHub as a review, or turn
  them into a change request for Claude.

The **Model** and **Effort** selectors are in the top bar and under the chat box. They
start at Opus and Medium, and your choice is remembered.

### Keyboard

| Key | Action |
| --- | --- |
| `j` / `k` | Next / previous hunk |
| `v` | Mark the hunk viewed and move to the next |
| `n` / `p` | Next / previous chapter |
| `x` | Explain the focused hunk |
| `a` | Ask about the focused hunk |
| `/` | Go to the chat box |
| `m` / `e` | Next model / next effort level |
| `f` | Fold or unfold moved code |
| `1` `2` `3` | Claude, Navigate, Notes |
| `?` | Show all shortcuts |

## Settings

Settings live in `.env` in this folder. Only names starting with `TRAIL_` are read.

| Setting | Default | Meaning |
| --- | --- | --- |
| `TRAIL_OWNER` | none | GitHub user or organisation used when you give only a repository name |
| `TRAIL_PORT` | `4477` | Port of the local web page |
| `TRAIL_HOME` | `~/.trail` | Where Trail keeps its database, clones and checkouts |

The owner for a command is taken from the first of these that is present: an owner written
with the repository, `--owner`, `TRAIL_OWNER` in your shell environment, `TRAIL_OWNER` in `.env`.
Writing two different owners in one command is refused.

To change the starting model and effort for everyone using this copy, edit
`DEFAULT_SETTINGS` in `shared/types.ts`.

## What Trail does on your machine and on GitHub

- **GitHub, read:** pull requests are fetched with your `gh` login and cloned into
  `~/.trail/repos`.
- **GitHub, write:** only when you press a button and confirm. **Submit to GitHub** posts
  your notes as one review. **Commit and push** pushes Claude's edits to the pull request
  branch. Nothing else is ever sent.
- **Claude:** questions and walkthroughs use your own Claude Code login, as if you had run
  `claude` in a terminal. Trail has no API key of its own.
- **Your repositories:** for a pull request, Claude works in Trail's own checkout under
  `~/.trail/worktrees`, never in your copy. For a local review, Edit mode changes your
  working tree directly.
- **Your notes, viewed marks and conversations** stay in `~/.trail/trail.db`.

## Reviewing code you do not trust

A pull request can contain anything, including files meant to attack whoever opens it.
Trail assumes that:

- Claude Code starts in the pull request's checkout with `--restricted --safe-mode`. No
  hooks, plugins, settings or `CLAUDE.md` are loaded, from the pull request or from your own
  setup, so nothing in the checkout can run a program on your machine. One consequence: the
  "Auto" model there is Claude Code's built-in default, not the one in your settings.
- A local repository gets your normal Claude Code setup only if you have already accepted
  Claude Code's trust prompt for that folder.
- Claude can read and search files, and edit them in Edit mode. It has no shell.
- Descriptions and answers shown on the page cannot contain forms or images, and links
  work only to github.com.
- The web page is reachable only from your own machine, and only by Trail's own page.
- Trail takes nothing from the folder you run it in. Running `trail .` inside another
  project does not load that project's `.env`, and does not run the `preload` scripts of its
  `bunfig.toml`. The one exception is calling `bun /path/to/bin/trail.ts` directly from
  inside another project, where Bun reads both before Trail can stop it. Use `bun trail`
  here or the linked `trail` command instead.

Claude is told to treat text in the repository as material under review, not as
instructions. That lowers the risk of a pull request steering its answers but cannot remove
it, so treat what Claude says as a second opinion.

## Troubleshooting

| Message or symptom | What to do |
| --- | --- |
| `The web UI has not been built yet` | Run `bun install && bun run build` in this folder. |
| `No owner for "my-repo"` | Set `TRAIL_OWNER` in `.env`, or add `--owner <name>`. |
| `Could not resolve to a Repository` | The owner or repository name is wrong, or your `gh` login cannot see it. Check `gh auth status`. |
| `The claude command was not found` | Install Claude Code and make sure `claude` runs in your terminal. |
| `Trail did not start` | Read `~/.trail/server.log`. Most often the port is taken: set another `TRAIL_PORT`. |
| `Note: the Trail server that is running was started before the code last changed` | Run `bun trail stop`, then your command again. After pulling an update, also run `bun install && bun run build`. |
| Refresh says Claude is still working | Wait for the answer to finish or press **Stop** in the chat, then refresh. |

## Limits

- Navigation finds definitions by name, not by compiling the code. Functions that share a
  name all show up, nearest first, and names that come from dependencies are not found.
- Code counts as moved only if its text is identical. A method that was moved and edited
  shows its edited lines as ordinary changes. So does code that changes indentation inside
  one file, because that usually means an `if` or a loop was added or removed around it.
- A viewed mark is tied to a hunk and the lines around it. If new commits change either,
  the hunk comes back as not viewed.
- After a refresh, a note follows its line if the line moved. If the line changed, the note
  is marked outdated and is posted in the review summary, not on a line.
- Only lockfiles, minified files, source maps, snapshots and protobuf output are hidden by
  default as generated files.
- Pushing Claude's edits is offered only for pull requests from a branch of the same
  repository, not from forks.
- Review comments that already exist on GitHub are not shown.

## Development

```sh
bun run dev         # server on :4477, restarting on change; web UI on :4478 with reload
bun run test
bun run typecheck
```

Everything is TypeScript running on Bun. The server runs from source with no compile step;
only the web UI is built.

| Folder | Contents |
| --- | --- |
| `bin/` | The `trail` command |
| `server/` | Local web server: import (`importer.ts`), diff parsing (`diff.ts`), move detection (`moves.ts`), definition index (`symbols.ts`), Claude Code bridge (`claude.ts`, `chat.ts`, `walkthrough.ts`) |
| `web/src/` | The page, in React |
| `shared/` | Types used by both |

## Licence

Trail is free to use and its source is public, with two restrictions. The exact terms are
in [LICENSE](LICENSE); this is a summary.

**You may:**

- use Trail free of charge, for personal work or at your company
- read, copy and change the code
- share it, changed or unchanged, as long as the licence and notices go with it

**You may not:**

- sell Trail, or offer a paid product or service (including paid hosting or support) whose
  value comes mainly from Trail
- remove the copyright and authorship notices, claim you wrote the original, or pass off a
  changed version as the original

The terms are the Apache License 2.0 with the Commons Clause, which removes the right to
sell, and an authorship condition. Because of the no-selling rule this is a
source-available licence, not an open-source one in the formal sense.

Trail was created by Diego Valadares Sá Fortes, working together with
[IARA](https://iara.app.br). For any use these terms do not allow, ask the author.
