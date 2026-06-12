#!/usr/bin/env node
/**
 * Generate release notes from Conventional-Commit messages since the previous tag.
 *
 * Reads `git log <prev-tag>..HEAD`, buckets each commit by its `type(scope): description` prefix into
 * emoji-headed sections, and prints Markdown to stdout. The release workflow captures this as the
 * GitHub Release body; you can also run it locally (`node scripts/changelog.mjs`) to preview.
 *
 * Commit format (see CONTRIBUTING.md): `type(scope): description`, e.g. `feat(files): show thumbnails`.
 * A `!` after the type/scope (`feat(api)!: …`) or a `BREAKING CHANGE:` body line flags a breaking change.
 */
import { execFileSync } from "node:child_process";

// execFileSync (no shell) so git args pass through verbatim - avoids the shell mangling `^`, `%` and
// `..` (cmd.exe on Windows treats `^`/`%` specially; this keeps the script cross-platform).
function git(args) {
	try {
		return execFileSync("git", args, { encoding: "utf8" }).trim();
	} catch {
		return "";
	}
}

// Commit range: from the most recent tag reachable before HEAD, to HEAD. When the workflow checks out
// a tag, HEAD is that tag's commit, so HEAD^ resolves the *previous* release tag. No previous tag →
// whole history.
const prevTag = git(["describe", "--tags", "--abbrev=0", "HEAD^"]);
const range = prevTag ? `${prevTag}..HEAD` : "HEAD";

// %h = short hash, %s = subject, %b = body. Fields/records separated by unit/record separators via
// git's own %x1f/%x1e escapes (printable in the shell command; git emits the actual bytes), so bodies
// that span lines (BREAKING CHANGE) don't break parsing.
const RS = "\x1e";
const FS = "\x1f";
const log = git(["log", range, "--no-merges", "--pretty=format:%h%x1f%s%x1f%b%x1e"]);

const SECTIONS = [
	{ key: "breaking", title: "⚠️ Breaking changes" },
	{ key: "feat", title: "✨ Features" },
	{ key: "fix", title: "🛠️ Fixes" },
	{ key: "perf", title: "⚡ Performance" },
	{ key: "refactor", title: "♻️ Refactoring" },
	{ key: "docs", title: "📄 Documentation" },
	{ key: "test", title: "🧪 Tests" },
	{ key: "chore", title: "🧹 Chores & CI" },
	{ key: "other", title: "📦 Other changes" },
];
const TYPE_TO_SECTION = {
	feat: "feat", fix: "fix", perf: "perf", refactor: "refactor",
	docs: "docs", test: "test", tests: "test",
	chore: "chore", ci: "chore", build: "chore", style: "chore",
};

const buckets = Object.fromEntries(SECTIONS.map((s) => [s.key, []]));

for (const record of log.split(RS).map((r) => r.trim()).filter(Boolean)) {
	const [hash, subject = "", body = ""] = record.split(FS);
	// Skip release/version-bump commits - they're noise in the notes.
	if (/^chore\(release\)/i.test(subject) || /^v?\d+\.\d+\.\d+\b/.test(subject)) {
		continue;
	}
	const m = subject.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/);
	const breaking = !!(m && m[3]) || /(^|\n)BREAKING CHANGE:/.test(body);
	if (m) {
		const [, type, scope, , desc] = m;
		const section = breaking ? "breaking" : (TYPE_TO_SECTION[type.toLowerCase()] ?? "other");
		const text = scope ? `**${scope}:** ${desc}` : desc;
		buckets[section].push(`- ${text} (${hash})`);
	} else {
		buckets[breaking ? "breaking" : "other"].push(`- ${subject} (${hash})`);
	}
}

const out = [];
for (const s of SECTIONS) {
	if (buckets[s.key].length) {
		out.push(`### ${s.title}`, ...buckets[s.key], "");
	}
}
process.stdout.write((out.length ? out.join("\n") : "_No notable changes._\n").trimEnd() + "\n");
