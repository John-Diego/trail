# Trail

Trail is a command-line tool and local web app for reviewing pull requests, built for
changes written by AI coding agents. You pick a pull request in the terminal, and Trail
opens it in your browser with Claude Code next to the diff. It runs entirely on your own
machine and uses your existing GitHub and Claude Code logins.

It helps with the three things that make AI-written pull requests tiring to review:

| Problem | What Trail does |
| --- | --- |
| The change is spread over many files, listed alphabetically. | Claude writes a **walkthrough**: the hunks grouped into chapters, in the order the logic runs. |
| Small methods were moved between files, shown as a deletion and an addition. | **Moved code is folded** into one line that links to where it went. |
| You have to leave the diff to see what a function does. | **Click any name** in the diff to see its definition and usages. |

## Requirements

| What | Version | Needed for |
| --- | --- | --- |
| [Node.js](https://nodejs.org) | **22.13 or newer** | Running Trail. Older versions are refused with a message saying so. |
| `git` | any recent | Reading the code |
| [GitHub CLI](https://cli.github.com) (`gh`), logged in | any recent | Pull requests. Not needed for local repositories. |
| [Claude Code](https://claude.com/claude-code) (`claude`), logged in | a current release | Walkthroughs, questions and edits |

Trail has been used on macOS. Linux should work; Windows is untested.

## Install

```sh
npm install -g @iara/trail
trail doctor
```

`trail doctor` checks each requirement above and tells you how to fix anything missing.

Then save the GitHub user or organisation that owns your repositories, so you only have to
type repository names:

```sh
trail config owner my-org
```

## First review

```sh
trail my-repo        # choose from the repository's open pull requests
trail my-repo 123    # or go straight to one
```

The first time you open a repository, Trail clones it, which can take a minute. Your
browser then opens the review at http://localhost:4477.

## Commands

### Open one pull request

| Command | What it opens |
| --- | --- |
| `trail my-repo 123` | Pull request 123 of `<saved owner>/my-repo` |
| `trail my-repo/123` | The same in one word |
| `trail my-repo 123 --owner other-org` | The same repository name under another owner, for this command only |
| `trail other-org/my-repo 123` | The owner written with the repository |
| `trail other-org/my-repo/123` | The same in one word |
| `trail https://github.com/owner/repo/pull/123` | A pull request by its GitHub address |
| `trail github.com/owner/repo/pull/123/files` | Any pasted form of that address: without `https://`, or with `/files`, `?diff=split`, `#discussion…` after the number |

Quote an address that contains `?` or `#`, so your shell passes it through unchanged. Only
github.com is supported.

### Choose from a list

Leave out the number and Trail lists the pull requests for you to pick one, so you never
have to look the number up on GitHub.

| Command | What it lists |
| --- | --- |
| `trail my-repo` | Open pull requests of `<saved owner>/my-repo` |
| `trail other-org/my-repo` | The same for any repository. Its address (`github.com/other-org/my-repo`) works too |
| `trail --list` | Open pull requests waiting for your review, across the saved owner (across all of GitHub when none is saved) |

In the list:

- **Arrow keys and Enter** move and open the pull request in Trail.
- **Typing** narrows the list by title, number, author or branch. `author:name`,
  `reviewer:name` and `label:name` look in one field.
- **Tab** switches between all pull requests, those waiting for your review, and your own.
- **Esc** leaves.

Each row shows the size of the change, its age, and its review state: draft, approved,
changes requested, or whose review is requested. Pull requests you have already opened in
Trail show how far you got.

To fetch a narrower list from GitHub in the first place, add filters:

| Filter | Meaning |
| --- | --- |
| `--mine` or `--author <login>` | Written by you, or by someone else |
| `--for-me` or `--reviewer <login>` | Review requested from you, from someone else, or from a team (`org/team`) |
| `--label <name>` | Carrying a label |
| `--state open\|closed\|merged\|all` | Default is `open` |
| `--search "<words>"` | Anything in GitHub's search syntax. Write `--search=-label:wip`, with `=`, when it starts with a dash |
| `--limit <n>` | How many to fetch. Default is 50 |

For example, `trail my-repo --for-me` lists what is waiting for you in one repository, and
`trail --list --mine` lists your own open pull requests across the saved owner.

Two things to know about lists across repositories (`--list`):

- They come from GitHub's search, which reports no sizes and no review state. A row there
  says nothing about reviews, which does not mean none is needed.
- Giving any filter replaces the default "waiting for your review".

When the output is piped instead of shown in a terminal, the list is printed one pull
request per line. Leaving the list with Ctrl-C ends with exit status 130.

### Review a local repository

| Command | What it reviews |
| --- | --- |
| `trail .` | The repository you are in: its current branch against the base branch, uncommitted changes included |
| `trail ~/code/app` | The same for a repository elsewhere |
| `trail ~/code/app --base develop` | Against a base branch you choose |

This is the way to review an agent's work before it becomes a pull request.

### Folder or GitHub name?

- Anything starting with `.`, `/` or `~` is a folder. Write a folder in the current
  directory as `./my-folder`.
- Any other word is read as a GitHub repository or pull request.
- When such a word also exists on disk, Trail stops and asks which one you mean, instead of
  guessing. Two exceptions, where only one reading is possible: with `--base` it is the
  folder, and a single name with no owner saved is the folder.
- `name/123` is pull request 123 of the repository `name`. For a repository that is itself
  named with a number, add `--list` or use its address.

### Other commands

| Command | What it does |
| --- | --- |
| `trail` | Opens the list of your reviews in the browser |
| `trail config` | Shows your saved settings. `trail config owner my-org` saves one |
| `trail doctor` | Checks that everything Trail needs is installed and logged in |
| `trail stop` | Stops Trail's background server |
| `trail serve` | Runs the server in the foreground, for watching its output |
| `trail --help` | Lists all commands |

Add `--no-open` to any command to print the address without opening the browser.

## The review page

The page has three columns.

**Left: where you are.** Two tabs. *Walkthrough* lists the chapters once you have generated
one; *Files* lists the changed files. Each entry shows how many of its hunks you have viewed.

**Middle: the diff.**

- Press **Generate walkthrough** on the overview to have Claude order the change into
  chapters. Each chapter explains what that step does and what to check. Every change
  appears in exactly one chapter, including binary files, renames and permission changes;
  anything Claude did not place gets its own chapter, so nothing is hidden.
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

Three things can be saved with `trail config <name> <value>`. `trail config` shows them, and
`trail config <name> --unset` removes one.

| Setting | Default | Meaning |
| --- | --- | --- |
| `owner` | none | GitHub user or organisation used when you give only a repository name |
| `port` | `4477` | Port of the local web page |
| `home` | `~/.trail` | Where Trail keeps its database, clones and checkouts |

They are stored in `~/.trail/config.json`. Changing the port or the folder stops the
running server, and the next command starts it with the new value.

The environment variables `TRAIL_OWNER`, `TRAIL_PORT` and `TRAIL_HOME` override the saved
values for one command or one shell. Setting `TRAIL_HOME` gives you a separate Trail with
its own data and its own settings; give it its own port as well if both should run at once.

The owner for a command is taken from the first of these that is present: an owner written
with the repository, `--owner`, `TRAIL_OWNER`, the saved `owner`. Writing two different
owners in one command is refused.

## Updating

```sh
npm install -g @iara/trail@latest
```

The next command notices the update and restarts Trail's background server, unless Claude
or an import is in the middle of something. In that case it tells you, and you run
`trail stop` once that work is done. Your reviews, notes and settings are kept.

## What Trail does on your machine and on GitHub

- **GitHub, read:** pull requests are fetched with your `gh` login and cloned into
  `~/.trail/repos`.
- **GitHub, write:** only when you press a button and confirm. **Submit to GitHub** posts
  your notes as one review. **Commit and push** pushes Claude's edits to the pull request
  branch. Nothing else is ever sent.
- **Claude:** questions and walkthroughs use your own Claude Code login, as if you had run
  `claude` in a terminal, and count against your own plan. Trail has no API key of its own.
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
- Text from GitHub is cleaned before it is shown. Titles and branch names cannot send
  control codes to your terminal, and descriptions and answers on the page cannot contain
  forms or images. Links on the page work only to github.com.
- The web page is reachable only from your own machine, and only by Trail's own page.
- Trail takes nothing from the folder you run it in. Running `trail .` inside another
  project does not load that project's `.env` or any of its configuration: the installed
  command is one self-contained file, and its settings live in your home folder.

Claude is told to treat text in the repository as material under review, not as
instructions. That lowers the risk of a pull request steering its answers but cannot remove
it, so treat what Claude says as a second opinion.

## Troubleshooting

Start with `trail doctor`. It names what is missing and how to fix it, and shows which
data folder, settings file and port Trail is using.

| Message or symptom | What to do |
| --- | --- |
| `Trail needs Node.js 22.13 or newer` | Update Node.js, then run the command again. |
| `No owner for "my-repo"` | Run `trail config owner <name>`, or add `--owner <name>`. |
| `Could not resolve to a Repository` | The owner or repository name is wrong, or your `gh` login cannot see it. Check `gh auth status`. |
| `… is a file or folder here and also reads as …` | Write `./name` for the folder, or add `--list` (or the number) for the GitHub repository. |
| `The claude command was not found` | Install Claude Code and make sure `claude` runs in your terminal. |
| `Trail did not start` | Read `server.log` in the data folder that `trail doctor` shows. Most often the port is taken: run `trail config port <number>`. |
| `… is in use by a Trail server for another data folder` | Two Trails are set to the same port. Give one of them another with `trail config port <number>`. |
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
- In a list, the "waiting for my review" tab counts requests made to you directly, not to
  a team you belong to.
- Review comments that already exist on GitHub are not shown.
- The box on the home page opens one pull request; choosing from a list is in the terminal.

## Development

Trail is TypeScript and runs on Node.js. To work on it from a clone of the repository:

```sh
npm install
npm run build              # builds the web page and the two files that get published
npm run trail -- my-repo   # runs the command from source
npm run dev                # server on :4477 restarting on change, web page on :4478 with reload
npm test
npm run typecheck
```

| Folder | Contents |
| --- | --- |
| `bin/` | The `trail` command: version check (`trail.ts`), the program (`main.ts`), arguments (`args.ts`), pull request lists (`list.ts`), the terminal picker (`picker.ts`) |
| `server/` | Local web server: import (`importer.ts`), diff parsing (`diff.ts`), move detection (`moves.ts`), definition index (`symbols.ts`), Claude Code bridge (`claude.ts`, `chat.ts`, `walkthrough.ts`) |
| `web/src/` | The page, in React |
| `shared/` | Types, pull request reference parsing and settings used by more than one part |

The published package contains only `dist/`: `cli.js` (a few lines that check the Node
version before anything else loads), `main.js` (the command) and `server.js`, each bundled
with no dependencies to install, and the built web page. `npm pack` shows exactly what
would be published. Reviews are stored with Node's built-in SQLite, which is why Node 22.13
is the minimum.

To change the model and effort Trail starts with, edit `DEFAULT_SETTINGS` in `shared/types.ts`.

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
