---
title: Supporting XDG directories in rustup
description: Project report on rustup's directory layout migration, compatibility, and development retrospective.
date: 2026-10-04
lang: en-US
outline: [2, 3]
---

# Supporting XDG directories in rustup

## Project Summary

This project adds support for XDG directories in rustup, separating
configuration, toolchains, cache and internal state. The existing layout
keeps these resources together under `~/.rustup`, with rustup and its
proxies installed in `~/.cargo/bin` by default.

The Rustup and Cargo teams are working on moving to platform-native dirs
on Unix and Windows. Rustup acts as a BusyBox-like redirector for the
underlying tools and toolchains, so we need to finish this work in rustup
first. This will unblock the Cargo team's [ongoing work on XDG paths](https://blog.rust-lang.org/inside-rust/2025/10/01/this-development-cycle-in-cargo-1.90/#all-hands-xdg-paths) and
[Pre-RFC: Split `$CARGO_HOME`](https://internals.rust-lang.org/t/pre-rfc-split-cargo-home/19747).

The main implementation is largely complete and nearing merge after
several rounds of review. The old layout remains the default. At the time
of this report, the work is split as follows:

| Status       | Work                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Merged       | Shared bin directory uninstall protection ([#4861](https://github.com/rust-lang/rustup/pull/4861)), Windows PATH matching ([#5067](https://github.com/rust-lang/rustup/pull/5067)), Windows handle and GC cleanup refactoring ([#5088](https://github.com/rust-lang/rustup/pull/5088)), and installation helper refactoring ([#5096](https://github.com/rust-lang/rustup/pull/5096)). |
| Under review | Category directory resolution and its integration with installation, shell setup, toolchain execution, self-update and uninstall in [#5056](https://github.com/rust-lang/rustup/pull/5056). Most of the implementation is complete; some directory choices remain open for discussion before full rollout.                                                                            |
| Planned      | A migration CLI for existing installations, compatibility links, and testing the full migration sequence.                                                                                                                                                                                                                                                                             |

For users, the new layout is intended to make these resources easier to
manage separately:

- Rustup keeps its files in the platform's standard locations: XDG
  directories on Unix and Known Folders on Windows.
- Users can back up their settings or put them into version control
  without including toolchains and cache files. They can choose whether
  to back up toolchains and leave out cached downloads and temporary files.
- Users can choose toolchain and cache locations independently of their
  configuration. Previously, changing `RUSTUP_HOME` moved all of these
  together. Installation across filesystems still has a constraint
  described below.
- Rustup and its proxies can use a standard binary directory. If it is
  already on `PATH`, rustup has fewer shell configuration to modify.

Rustup can also manage its binaries and environment scripts separately
from Cargo's storage, while the Cargo team works on its own directory layout.

Splitting the directories also changes how rustup finds its files. Code
that used to append a subdirectory to `RUSTUP_HOME` or `CARGO_HOME` now
needs the appropriate resolved path. That affects installation, shell
setup and child processes, followed by self-update and uninstall. Once
those parts are ready, existing users will still need a way to migrate.

## Compatibility constraints

The new directory layout is experimental and opt-in for now. We still
have open questions to discuss with the Cargo team, and downstream tools
need time to catch up. At the start of the project, I was told that a
previous change to rustup's installation behavior had broken some CI/CD
setups. We don't want that to happen again.

So we kept the following compatibility rules:

- `RUSTUP_USE_CATEGORY_HOME` gates the new layout. When it is unset or
  `0`, all category-home APIs use the old directories. This keeps existing
  behavior unchanged by default. The switch is centralized in
  `src/process.rs`, so we can change it there when we are ready to migrate.
- Explicit `RUSTUP_HOME` and `CARGO_HOME` settings remain in the resolution
  order for backward compatibility.

## Directory resolution

The first question was how users could choose the new directories while
keeping their existing environment overrides meaningful.

The implementation is organized into three layers:

- `process.rs` selects legacy or category mode.
- `process/home.rs` applies the override priorities and resolves the category
  and binary directories.
- `process/home/{unix,windows}.rs` provides the platform base directories,
  using XDG rules on Unix and Known Folders on Windows.

### Resolution rules

In category mode, configuration, data, cache, and state each resolve in
this order:

1. `RUSTUP_<CATEGORY>_HOME`
2. `RUSTUP_HOME`, if explicitly set
3. The platform's category directory

The binary directory has a different resolution order, because we still need to
coordinate its location with Cargo:

1. `RUSTUP_BIN_HOME`
2. `CARGO_HOME/bin` (only if `CARGO_HOME` is explicitly set)
3. The default binary directory

The current implementation uses `~/.local/bin` as the default on both
platforms. However, the Windows default is still an open question, see [discussion](https://github.com/rust-lang/rustup/pull/5056#issuecomment-5557550676).

For example, on Unix with no directory overrides, enabling
`RUSTUP_USE_CATEGORY_HOME=1` changes the locations as follows:

| Resource               | Legacy layout (default)   | Category layout (opt-in)            |
| ---------------------- | ------------------------- | ----------------------------------- |
| Settings               | `~/.rustup/settings.toml` | `~/.config/rustup/settings.toml`    |
| Toolchains             | `~/.rustup/toolchains/`   | `~/.local/share/rustup/toolchains/` |
| Downloads              | `~/.rustup/downloads/`    | `~/.cache/rustup/downloads/`        |
| Rustup and its proxies | `~/.cargo/bin/`           | `~/.local/bin/`                     |

These are the locations the new mode uses; enabling it does not migrate
an existing installation. The migration CLI is left for future work.

.

### Design rationale

During the review, certain details regarding the final semantics have been carefully discussed:

**Putting category overrides behind the same gate.**

In the [Split `CARGO_HOME` pre-RFC](https://internals.rust-lang.org/t/pre-rfc-split-cargo-home/19747),
explicit `CARGO_HOME` overrides were given priority over platform defaults,
while category-specific variables could override individual locations.
This allows users to adopt the new directories without losing their
existing configuration.

I kept the legacy overrides, but made the new category overrides opt-in.
In an earlier version, setting `RUSTUP_DATA_HOME` could move toolchains
even when the platform-directory switch was disabled. Downstream tools
still expecting them under `RUSTUP_HOME` could then fail to find them.

We therefore changed the switch to `RUSTUP_USE_CATEGORY_HOME` and used it
to control both category overrides and platform defaults. Explicit
`RUSTUP_HOME` and `CARGO_HOME` settings remain in the resolution order for
[backward compatibility](https://github.com/rust-lang/rustup/pull/5056#issuecomment-5561729250),
while users must enable category mode to use the new layout.

**The role of `RUSTUP_HOME`.**

Another question was whether `RUSTUP_HOME` should become a common base
directory for all categories in the new mode. Under that interpretation,
the binary directory could also fall back to `RUSTUP_HOME/bin`.

@rami3l suggested leaving this change in semantics as possible follow-up
work. We kept the migration focused on splitting the directories while
preserving the [existing override roles](https://github.com/rust-lang/rustup/pull/5056#issuecomment-5561729250).
For the binary directory, an explicit `CARGO_HOME` therefore still
provides the legacy `CARGO_HOME/bin` fallback.

Using `RUSTUP_HOME/bin` may make sense later, for example when category
mode no longer needs an opt-in switch. For now, redefining `RUSTUP_HOME`
in this way is outside the scope of the migration.

## Migrating the consumers

Previously, many parts of rustup found their files by appending a
subdirectory to `RUSTUP_HOME` or `CARGO_HOME`. Splitting the directories
means updating those places to use the appropriate home. For example,
toolchain installation and lookup must both use `toolchains/` under the
data home. If installation used the new location but lookup still used
the old one, rustup would not find the installed toolchain.

I updated installation, downloads, shell setup and toolchain execution
to use the new paths. `Cfg` stores the resolved homes and builds the
resource paths from them, such as `toolchains/` under data and
`downloads/` under cache.

To prepare the installation code for this, I changed helpers to accept
the paths they need directly from their callers in
[#5096](https://github.com/rust-lang/rustup/pull/5096), which has been merged.

### Resource Locations Splitting

Here is where each resource goes in the new layout.

| Resource                                                              | Directory                                          | Consumers                                 |
| --------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------- |
| User settings, including the default toolchain, profile and overrides | Config: `settings.toml`                            | Settings commands and toolchain selection |
| Installed toolchains; fallback Cargo on Windows                       | Data: `toolchains/`, `fallback/`                   | Toolchain discovery and execution         |
| Downloaded packages, update hashes and temporary files                | Cache: `downloads/`, `update-hashes/`, `tmp/`      | Toolchain installation and updates        |
| Internal state, such as the last release notification time            | State: `state.toml`                                | Release notifications                     |
| The managed self-updater, its lock and status markers                 | State: `self-update/`                              | Self-update                               |
| Generated shell environment scripts on Unix                           | Data: `env`, `env.fish`, and other shell variants  | Shell startup and PATH setup              |
| Rustup and its proxies                                                | Bin: `rustup`, `cargo`, `rustc`, and other proxies | Command lookup and toolchain dispatch     |

Rustup records when it last showed a release notification, even though
this is not a user setting. I moved that timestamp to `state.toml` under
the state home, so recording a notification no longer changes
`settings.toml` under the config home.

Moving the proxy directory must not change which toolchain gets run.
The `rustc` and `cargo` in the bin home are rustup proxies, while each
toolchain has its own executables under the data home. So the proxies
need the resolved data home to find and run the selected toolchain.

### Shell environment setup

After separating the directories, a new shell still needs to find rustup
and its proxies. Previously, both the generated environment scripts and
the bin directory were under `CARGO_HOME`.

I initially used the config home for env scripts. After
[reviewing prior art with @rami3l](https://github.com/rust-lang/rustup/pull/5056#discussion_r4006220616),
I proposed following GHCup and using the data home. This also keeps the
scripts out of a shared bin directory, where uv's `env` script had caused a
[command lookup conflict in SLURM](https://github.com/astral-sh/uv/issues/19023).

For example, with category mode enabled and the default XDG locations, a
POSIX shell sources `~/.local/share/rustup/env`. The script adds
`~/.local/bin` to `PATH` if it is not already there. If the user overrides
either directory, the script and its source command need to use those
resolved locations. The script writer needs both paths; it can no longer
append `bin` to the env script's directory to find the binaries.

This also meant updating the shell startup entries and post-install
instructions alongside script generation. They all need to agree on where
the env script is stored. Windows PATH setup uses the resolved bin directory
as well. I also fixed Windows PATH matching in
[#5067](https://github.com/rust-lang/rustup/pull/5067), which has been merged,
so adding or removing a directory matches a complete entry rather than
part of another path.

The env scripts set up `PATH`; enabling category mode is still controlled
by `RUSTUP_USE_CATEGORY_HOME`.

### Passing paths to child processes

When Cargo invokes `rustc`, the proxy needs to find the same toolchains
and settings as the rustup process that started Cargo. Rustup therefore
needs to pass its directory choices to the programs it starts.

So, when preparing a toolchain command, rustup passes the resolved config,
data, cache and state homes through their corresponding
`RUSTUP_<CATEGORY>_HOME` variables, along with `RUSTUP_BIN_HOME`. It also
sets `RUSTUP_TOOLCHAIN` and puts the proxy directory at the front of the
child's `PATH`. Later proxy invocations can then use the directory choices
already made by the parent.

If rustup uses a default directory, the corresponding environment variable
may not be set. So we pass the resolved path to the child explicitly.

However, `CARGO_HOME` needs separate handling, as Cargo still needs to
choose its own storage location. In the [PR discussion](https://github.com/rust-lang/rustup/pull/5056#issuecomment-5564600989),
I pointed out that forwarding a default computed by rustup could make the
child treat it as an explicit user choice. In legacy mode, rustup keeps the previous
behavior of resolving and passing `CARGO_HOME`. In category mode, we only
do this when the user explicitly sets a non-empty `CARGO_HOME`. Otherwise,
we leave the inherited environment unchanged and let Cargo choose its own
default. This preserves the user's existing Cargo setup while the Cargo team
works on its directory layout.

## Toolchain Management

A shared bin directory may contain programs installed by other tools.
So uninstall can no longer assume that everything in that directory
belongs to rustup. It needs to identify rustup's own files and leave
unrelated programs in place.

Separate data and cache homes can also be on different filesystems.
On Windows, this matters for fallback Cargo: it needs a hard link to
Cargo inside an installed toolchain, and that link cannot cross volumes.

Windows cleanup has another constraint: rustup cannot directly remove
its running executable. A separate GC helper waits for rustup to exit
and finishes the removal. I needed to adjust where this helper runs
from and how it cleans up its own executable.

### Uninstalling from shared directories

Using a shared bin directory changes what rustup is allowed to remove.
A file named `cargo` or `rustc` may belong to another installation, so
checking the filename alone is not enough.

Following what I and @rami3l's [discussion result](https://github.com/rust-lang/rustup/issues/285#issuecomment-4368815390),
I reused the existing same-file checks to identify proxies that point to
the installed rustup executable. This change landed in
[#4861](https://github.com/rust-lang/rustup/pull/4861). Uninstall removes
those proxies and rustup itself, while keeping unrelated files and leaving
a non-empty bin directory in place.

Besides addressing the Cargo home deletion issue, I extracted the
cleanup into a helper, `clean_cargo_home`, to prepare for category mode.
In that mode, the bin home can be a shared directory outside `CARGO_HOME`.
Uninstall needs the same checks there to remove rustup's files without
deleting other tools installed in that directory.

### Keeping fallback Cargo with toolchain data

A custom toolchain may not include Cargo, so rustup can borrow Cargo from
another installed toolchain. On Windows, it creates a hard link to that
Cargo in a separate `fallback/` directory. This prevents the borrowed
Cargo from finding the `rustc.exe` beside its original executable when it
should use the custom toolchain's compiler.

I initially put this fallback under cache because it could be recreated.
However, cache and data homes can be on different volumes, which prevents
creating the hard link. The first approach added a copy fallback to handle
this.

As a result, I moved `fallback/` to the data home alongside `toolchains/` in
[#5056](https://github.com/rust-lang/rustup/pull/5056), and removed the extra
copy branch and its supporting test machinery. This keeps the linked
files on the same volume in the normal layout.

### Windows cleanup and process waiting

On Windows, the running executable also affects the cleanup order. Rustup
uses a GC helper to wait for the parent process and finish removing the
installation.

I first split out the handle and cleanup refactoring into
[#5088](https://github.com/rust-lang/rustup/pull/5088), which has been merged.
It uses standard library types to manage the handles and makes GC attempt
its own cleanup even if uninstalling fails.

In the category-home work in [#5056](https://github.com/rust-lang/rustup/pull/5056),
I also changed the GC helper to use an independent executable copy in the
system temporary directory. This avoids requiring write access to the
parent of `CARGO_HOME`. The copy also needs to be a regular file: the
previous copy helper could preserve a symbolic link, causing the
delete-on-close handle to refer to the original program. Copying the
contents into a new temporary file keeps self-cleanup attached to the
GC copy.

Two related explorations stayed separate from the migration. Running GC
from an Alternate Data Stream in
[#5090](https://github.com/rust-lang/rustup/pull/5090)
[worked on Windows Server 2025](https://github.com/rust-lang/rustup/pull/5088#issuecomment-5719570891).
However, due to time issues, I haven't refined the patch set and git history for
this, which would be done later as my further contribution to project.

In [#5105](https://github.com/rust-lang/rustup/pull/5105), I also proposed
passing an inherited parent-process handle to GC and self-update. This
avoids identifying a different process if the parent exits and its PID
is reused before the child opens it. An intermediate version passed
native Windows installation, self-update and uninstall smoke checks with
older and patched builds. Those results apply only to that independent
implementation: #5105 is still open, and the category branch still uses
the existing parent PID lookup.

## Development retrospective

I also revisited the tests, refactor boundaries and commit history.
LLM tools helped me get started quickly. But I still needed to check the
changes carefully, remove unnecessary parts and decide what to keep.

### Checking what the tests actually prove

I initially checked environment forwarding by setting the category
variables and checking that the child process received the same values.
But when I removed all four explicit forwarding statements as an ablation
check, the complete test suite for that version still passed. The child
could simply inherit the variables already set by the test.

So, I changed the setup to leave the category variables unset and provide
`RUSTUP_HOME` as the resolution input. The child then had to receive the
category variables from rustup. The revised tests caught each missing
forwarding statement, as well as swapped cache and data values. I kept the
existing file-location checks, since those still tested useful behavior.

I also asked @rami3l to help add coverage for environment forwarding.
He contributed a new test commit for this part of the work, as it's
more of a previous missing part of rustup.

### Deciding how far to decouple Process

In [#5096](https://github.com/rust-lang/rustup/pull/5096), I wanted helpers
to reuse resolved installation paths. The first version also moved shell
and registry work into the shared layer.
[Review](https://github.com/rust-lang/rustup/pull/5096#discussion_r4069038401) questioned whether the
extra parameter passing was worth the benefit.

I first tried limiting the refactor to shared code on both platforms.
However, this went too far: `cleanup_self_updater` was changed back to
accept `Process`, even though it only needed the bin directory.

So I asked for each function to be checked against the data it actually
read from `Process`. Helpers that only needed home or bin paths received
those paths directly. Functions that needed shell discovery, other
environment values or
registry access kept their process dependency and platform boundaries.
Some shell methods also needed to keep a common trait signature even when
one implementation used less state.

### Learning to manage commit history in atomic commits

As rustup has a good requirement upon git history: we want atomic commits,
splitted and well ordered for reviewing, backporting and bisect.
I initially had problems upon this, however, my mentor was helpful here,
and timely helped me with it.

Here's the details:
My bin home PR went through several rounds of history rewriting to meet
rustup's expectations for atomic commits that could be reviewed
individually. I wasn't yet comfortable rewriting Git history.

@rami3l worked through this with me. We tried jj together, and he
patiently guided me through reorganizing the Git history. With his help,
I quickly got better at managing the commit history in my later PRs.

## Remaining work and conclusion

### Current PR status

After several rounds of review and feedback, most of the implementation
in [#5056](https://github.com/rust-lang/rustup/pull/5056) is complete, and
the PR is close to being merged.

Some directory choices are still open, such as the
[default bin directory on Windows](https://github.com/rust-lang/rustup/pull/5056#issuecomment-5557550676).
The implementation currently uses `%USERPROFILE%\.local\bin`, with an
AppData location also under discussion. These questions can be settled
before the feature is fully rolled out; they do not all need to be
resolved before merging the opt-in implementation.

### Migrating existing installations

My next step is to create a CLI interface for migrating existing
installations. It should move configuration, toolchains and other
resources from the old layout to their corresponding category homes,
then create symlinks at the old locations. Tools that still use the
legacy paths could then continue finding the same resources.

For example, `~/.rustup/toolchains` could point to `toolchains/` under the
new data home. Since the contents of the old Rustup home now belong to
several categories, the migration needs to handle each resource and its
compatibility link. The source and destination also need to respect the
user's directory overrides.

I still need to design the commands. Users should be able to choose when
to move their existing installation to the new layout.

### Conclusion

The merged changes improve uninstall and Windows behavior while
preparing rustup's installation code for category directories.

The main lesson was that separating storage also means revisiting every
place that assumes where files live or who owns them.

I also learned that software development is a living, evolving process:
while I worked on this project, @cachebag and @rami3l were also improving
rustup in their own ways. I really enjoyed working alongside them, and
I hope to keep contributing to rustup.

Thanks to @rami3l for the continued guidance and review, and to
@ChrisDenton for helping me work through the Windows behavior
and @djc for idiomatic rust, finding out nits and clarify refactor boundaries.
I also appreciate the Rustup and Cargo teams'
discussions on how these layouts should fit together.
