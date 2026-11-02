#!/usr/bin/env bash
# Fetch sample-frontend/ — real JavaScript and TypeScript projects, pinned to the commits
# the frontend resolver was measured on — for validating it end to end
# (`cargo test --lib xref::js::validate -- --ignored --nocapture`) and for poking at
# M-. / M-, / M-? by hand in project mode.
#
# Each is a shallow checkout of one commit, its own git repo so review-me can open it.
# The tree is gitignored. Safe to re-run: a sample already at its commit is kept.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p sample-frontend

fetch() {
  local name=$1 url=$2 sha=$3
  local dir="sample-frontend/$name"
  if [ -d "$dir/.git" ] && [ "$(git -C "$dir" rev-parse HEAD 2>/dev/null)" = "$sha" ]; then
    echo "  $name: at ${sha:0:9}"
    return
  fi
  rm -rf "$dir"
  git init -q "$dir"
  git -C "$dir" fetch -q --depth 1 "$url" "$sha"
  git -C "$dir" -c advice.detachedHead=false checkout -q FETCH_HEAD
  echo "  $name: fetched ${sha:0:9}"
}

# A pnpm monorepo of TypeScript packages with paths aliases and dist entries.
fetch vue-core https://github.com/vuejs/core.git 68f25a4a1957710de71731702bd42e05535f494b
# Next.js and the App Router, `@/*`.
fetch next-commerce https://github.com/vercel/commerce.git f7521d57d29f0eb3d23c1399cf9bb299d61fcd21
# A Turborepo of Next apps, templates sharing workspace package names, generated files.
fetch shadcn-ui https://github.com/shadcn-ui/ui.git 4aaea19d9cff3e0908e12a8c1d504b8c5ec34610
# SvelteKit in plain JavaScript, `$lib`.
fetch sveltekit-realworld https://github.com/sveltejs/realworld.git df796708040f5200ec572b28ab7f88ecee5794dd
# Angular with standalone components, signals and the new control flow.
fetch angular-realworld https://github.com/gothinkster/angular-realworld-example-app.git 77829ef749a97341e6d9fd754789a87956d7109f
# Nuxt 4: `app/`, auto-imported components and composables, `#shared`.
fetch nuxt-movies https://github.com/nuxt/movies.git 4d05739da559360e91214815d97dd2cfa37154ce
# Vue with unplugin's auto-imports and components.d.ts.
fetch vitesse https://github.com/antfu-collective/vitesse.git a8785264f83c2ebe1b3cf689296775a4949957c8
# Astro, its components, and a monorepo of them.
fetch starlight https://github.com/withastro/starlight.git e4f3f7fcd52ab4d22458474173f3a96689fb0242
# CommonJS JavaScript.
fetch express https://github.com/expressjs/express.git bcc0551cb7a785b7772f77cb59ce55a2bc94975a
# SCSS: partials, mixins, functions, custom properties.
fetch bootstrap https://github.com/twbs/bootstrap.git e93ba5e5267ac2f74d5d35f1c11bb476957de94b
