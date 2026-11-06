#!/usr/bin/env bash
# An independent repository for exercising JSDoc navigation in review-me.
set -euo pipefail
cd "$(dirname "$0")/.."
dest="${1:-sample-jsdoc}"
if [[ -e "$dest" || -L "$dest" ]]; then
  echo "$dest already exists; keeping its contents."
  exit 0
fi
mkdir -p "$dest/src"
cat > "$dest/package.json" <<'JSON'
{"name":"jsdoc-navigation-sample","private":true,"type":"module","scripts":{"start":"node src/main.js"}}
JSON
cat > "$dest/src/user.js" <<'JS'
/** A real user. */
export class User {
  /** @param {string} name */
  constructor(name) { this.name = name; }
  save() { return `saved ${this.name}`; }
}
/** @typedef {object} Options
 * @property {string} greeting
 */
JS
cat > "$dest/src/other.js" <<'JS'
/** A deliberately unrelated class with the same names. */
export class User {
  save() { return 'other user'; }
}
JS
cat > "$dest/src/index.js" <<'JS'
export {User as Person} from './user.js';
JS
cat > "$dest/src/main.js" <<'JS'
import {Person as Customer} from './index.js';
import {User as OtherUser} from './other.js';
/** @import {Options} from './user.js' */
/** @param {Customer} user @param {Options} options
 * See {@link Customer#save}.
 * @returns {string}
 */
function greet(user, options) { return `${options.greeting}: ${user.save()}`; }
/** @returns {Customer} */
function create() { return new Customer('Ada'); }
/** @param {OtherUser} other */
function other(other) { return other.save(); }
// This remains an unconfirmed reference to either save method.
export function uncertain(value) { return value.save(); }
console.log(greet(create(), {greeting: 'Hello'}));
console.log(other(new OtherUser()));
/** @typedef {{user: Customer, active: boolean}} Session */
/** @callback Loader
 * @param {string} name
 * @returns {Customer}
 */
/** @type {Loader} */
const load = name => new Customer(name);
/** @param {Session} session */
function saveSession(session) { return session.user.save(); }
/** @param {import('./user.js').Options} options */
function greeting(options) { return options.greeting; }
console.log(saveSession({user: load('Grace'), active: true}), greeting({greeting: 'Welcome'}));
JS
cat > "$dest/README.md" <<'MD'
# JSDoc navigation sample

Open this directory as a repository in review-me, enter project mode, and open
`src/main.js`. Run the code with `npm start`; no install is needed.

Manual checks:

- Both `@param` tags on the same line have highlighted tags, types, and names.
- `M-.` or Ctrl/Cmd-click on `Customer` in JSDoc reaches `User` in `src/user.js`.
- Jump on `user.save()` to the method in `src/user.js`; `other.save()` reaches
  the different method in `src/other.js`.
- Jump on `options.greeting` to the `@property` declaration in `src/user.js`.
- Jump on `save` in the documentation link to the user method.
- Jump on `Loader` to its `@callback`, and `Session` to its inline record typedef.
  `session.user` reaches the inline property; `session.user.save()` reaches the
  user method. The inline import type's `Options` reaches its typedef.
- `M-,` returns to the origin; `C-x 4 .` opens the target in another window.
- Find references (`M-?`) on the user class: the renamed imports and JSDoc type
  usages are included. The unrelated `User` stays separate.
- Find references on either `save`: the matching typed call is confirmed, the
  other typed call is excluded, and `value.save()` remains unconfirmed.

The initial contents are committed. Edit them to try worktree review; rerunning
the generator preserves this repository and any edits.
MD
git -C "$dest" init -q
git -C "$dest" add .
git -C "$dest" -c user.name='review-me sample' -c user.email='sample@example.invalid' -c commit.gpgsign=false commit -qm 'Add JSDoc navigation examples'
echo "Created $dest. Open it in review-me; npm --prefix $dest start runs the example."
