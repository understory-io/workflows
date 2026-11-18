#!/usr/bin/env bash
# Usage: promote-per-change.sh SOURCE TARGET
# DRY_RUN=1 builds the branches locally and prints what it would push, open and
# close, without touching the remote.
set -euo pipefail

source_branch="${1:?source branch}"
target_branch="${2:?target branch}"
prefix="release/auto-${target_branch}-"
dry_run="${DRY_RUN:-0}"
remote="${REMOTE:-origin}"

git_bot() {
	git -c user.name='github-actions[bot]' \
		-c user.email='41898282+github-actions[bot]@users.noreply.github.com' "$@"
}

git fetch --quiet "$remote" \
	"+refs/heads/${source_branch}:refs/remotes/${remote}/${source_branch}" \
	"+refs/heads/${target_branch}:refs/remotes/${remote}/${target_branch}"
src="${remote}/${source_branch}"
tgt="${remote}/${target_branch}"
target_sha="$(git rev-parse "$tgt")"

# Cherry-picks get new shas, so ancestry alone would offer them again forever.
promoted="$(git log "$tgt" --format='%(trailers:key=Promoted-from,valueonly)' | sed '/^$/d' | sort -u)"

mapfile -t candidates < <(git rev-list --first-parent --reverse "${tgt}..${src}")
pending=()
for c in "${candidates[@]}"; do
	grep -qx "$c" <<<"$promoted" || pending+=("$c")
done

pr_of() {
	git log -1 --format=%s "$1" | sed -nE 's/^Merge pull request #([0-9]+) .*/\1/p'
}

key_of() {
	local pr
	pr="$(pr_of "$1")"
	if [ -n "$pr" ]; then echo "pr-${pr}"; else git rev-parse --short=10 "$1"; fi
}

# Cherry-picks one SOURCE change onto HEAD with the trailer that marks it
# promoted. Returns 1 on a conflict, leaving the conflicting paths in
# $conflicts, and 2 when the change is already on TARGET.
apply_change() {
	local c="$1" msg mainline=()
	conflicts=""
	[ "$(git rev-list --parents -n1 "$c" | wc -w)" -gt 2 ] && mainline=(-m 1)
	if ! git_bot cherry-pick --no-commit "${mainline[@]}" "$c" >/dev/null 2>&1; then
		conflicts="$(git diff --name-only --diff-filter=U)"
		git cherry-pick --abort >/dev/null 2>&1 || git reset --quiet --hard HEAD
		return 1
	fi
	if git diff --cached --quiet; then
		git reset --quiet --hard HEAD
		return 2
	fi
	msg="$(git log -1 --format=%B "$c" | git interpret-trailers --trailer "Promoted-from: $c")"
	git_bot commit --quiet --no-verify -m "$msg"
}

changed_paths() {
	git diff --name-only "${1}^1" "$1"
}

# Applies the changes in SOURCE order onto TARGET. Returns 1 at the first
# conflict, with $conflicts set.
apply_set() {
	local p rc
	git checkout --quiet --detach "$target_sha"
	applied=()
	for p in "${pending[@]}"; do
		[[ " $* " == *" $p "* ]] || continue
		set +e
		apply_change "$p"
		rc=$?
		set -e
		[ "$rc" -eq 1 ] && return 1
		[ "$rc" -eq 0 ] && applied+=("$p")
	done
	return 0
}

summary="$(mktemp)"
wanted_keys=()
declare -A built_branch built_title built_body

for i in "${!pending[@]}"; do
	c="${pending[$i]}"
	key="$(key_of "$c")"
	git checkout --quiet --detach "$target_sha"

	carried=()
	set +e
	apply_change "$c"
	rc=$?
	set -e
	if [ "$rc" -eq 2 ]; then
		echo "skip ${key}: already on ${target_branch}" | tee -a "$summary"
		continue
	fi
	if [ "$rc" -eq 1 ]; then
		# It conflicts because it builds on an earlier change TARGET lacks. Carry
		# the latest earlier change that touched a conflicting path, and repeat
		# until it applies: the fewest unrelated changes ride along.
		ok=0
		while :; do
			found=""
			for ((j = i - 1; j >= 0; j--)); do
				p="${pending[$j]}"
				[[ " ${carried[*]} " == *" $p "* ]] && continue
				if grep -qxFf <(changed_paths "$p") <<<"$conflicts"; then
					found="$p"
					break
				fi
			done
			[ -z "$found" ] && break
			carried+=("$found")
			if apply_set "${carried[@]}" "$c"; then
				ok=1
				break
			fi
		done
		if [ "$ok" -eq 0 ]; then
			echo "skip ${key}: conflicts with ${target_branch} in $(echo "$conflicts" | paste -sd' '); promote it by hand" | tee -a "$summary"
			continue
		fi
		mapfile -t carried < <(for p in "${applied[@]}"; do [ "$p" != "$c" ] && echo "$p"; done)
	fi

	branch="${prefix}${key}"
	pr="$(pr_of "$c")"
	subject="$(git log -1 --format=%s "$c")"
	if [ -n "$pr" ]; then
		subject="$(git log -1 --format=%b "$c" | sed -n '/./{p;q}')"
		title="Release #${pr} to ${target_branch}: ${subject}"
	else
		title="Release ${key} to ${target_branch}: ${subject}"
	fi
	body="Promotes ${pr:+#${pr} }(\`${c}\`) from \`${source_branch}\` to \`${target_branch}\`, and nothing else from \`${source_branch}\`.

The plan below is \`${target_branch}\` with only this change. Other promotion pull requests are independent: merge them in any order. After any of them merges, this one is rebuilt on the new \`${target_branch}\` and planned again."
	if [ "${#carried[@]}" -gt 0 ]; then
		body+="

It does not apply without these earlier changes, so it carries them. Merging it promotes them too, and their own pull requests close:
$(for p in "${carried[@]}"; do echo "- $(key_of "$p" | sed 's/^pr-/#/') $(git log -1 --format=%s "$p")"; done)"
	fi

	git branch --quiet --force "promote-tmp/${key}" HEAD
	wanted_keys+=("$key")
	built_branch[$key]="$branch"
	built_title[$key]="$title"
	built_body[$key]="$body"
	carried_keys="$(for p in "${carried[@]}"; do key_of "$p"; done | paste -sd' ')"
	echo "build ${branch}: ${title}${carried_keys:+ (carries ${carried_keys})}" | tee -a "$summary"
done

git checkout --quiet --detach "$target_sha"

# A branch is pushed only when its tree or its base changed: every push replans
# TARGET's workspace and resets the review.
for key in "${wanted_keys[@]}"; do
	branch="${built_branch[$key]}"
	new="promote-tmp/${key}"
	if old="$(git ls-remote --heads "$remote" "$branch" | cut -f1)" && [ -n "$old" ]; then
		git fetch --quiet "$remote" "$old" 2>/dev/null || true
		if [ "$(git rev-parse "${old}^{tree}" 2>/dev/null)" = "$(git rev-parse "${new}^{tree}")" ] &&
			git merge-base --is-ancestor "$target_sha" "$old" 2>/dev/null; then
			echo "unchanged ${branch}"
			continue
		fi
	fi
	if [ "$dry_run" = 1 ]; then
		echo "would push ${branch} ($(git rev-list --count "${target_sha}..${new}") commit(s) on ${target_branch})"
		continue
	fi
	git push --quiet --force "$remote" "${new}:refs/heads/${branch}"
	if gh pr view "$branch" --json state --jq .state 2>/dev/null | grep -qx OPEN; then
		gh pr edit "$branch" --title "${built_title[$key]}" --body "${built_body[$key]}" >/dev/null
	else
		gh pr create --base "$target_branch" --head "$branch" \
			--title "${built_title[$key]}" --body "${built_body[$key]}" >/dev/null
	fi
done

# Promotion pull requests whose change is on TARGET now, or was dropped from
# SOURCE, are closed with their branch.
while read -r branch; do
	[ -z "$branch" ] && continue
	key="${branch#"$prefix"}"
	if [ -z "${built_branch[$key]:-}" ]; then
		if [ "$dry_run" = 1 ]; then
			echo "would close ${branch}"
		else
			gh pr close "$branch" --delete-branch \
				--comment "Its change is on \`${target_branch}\` now, through this or another promotion." >/dev/null 2>&1 ||
				git push --quiet "$remote" --delete "$branch"
		fi
	fi
done < <(git ls-remote --heads "$remote" "${prefix}*" | sed "s#.*refs/heads/##")

for key in "${wanted_keys[@]}"; do git branch --quiet -D "promote-tmp/${key}"; done

if [ "${#pending[@]}" -eq 0 ] && ! git diff --quiet "$tgt" "$src"; then
	echo "::warning::${target_branch} holds every change of ${source_branch} but their trees differ:" | tee -a "$summary"
	git diff --stat "$tgt" "$src" | tee -a "$summary"
fi

[ -n "${GITHUB_STEP_SUMMARY:-}" ] && { echo '```'; cat "$summary"; echo '```'; } >>"$GITHUB_STEP_SUMMARY"
rm -f "$summary"
