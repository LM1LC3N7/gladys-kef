# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for KEF wireless speakers (LS50
Wireless II, LSX II, LSX II LT, LS60), over their local HTTP API: a Node.js
service (Node 22+, ESM, no build step) that runs in its own sandboxed Docker
container and talks to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).
Its only runtime dependency is the SDK. It started from the official
JavaScript template; the speaker logic is ported from the `pykefcontrol`
Python library (MIT, see `THIRD_PARTY_NOTICES.md`). The KEF API is not
documented. Decisions are recorded in `TODO.md`.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "volume"  # tests whose name matches
npm run cover                             # regenerates cover.png
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only (src/handlers.js registers before connect())
src/handlers.js                   every SDK handler -> KefApp (shared with the tests)
src/app.js                        read loops, speakers, commands, volume cap, guards, buttons, status
src/kef/http.js                   one bounded HTTP request (the only network code)
src/kef/client.js                 the getData / setData calls of one address
src/kef/parse.js                  untrusted answers -> clean values (pure)
src/model.js                      speakers -> Gladys devices and states (pure)
src/publisher.js                  every state to Gladys, within 250 a minute
src/store.js                      /data/kef.json
src/constants.js                  frozen keys, paths, limits, timings
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, fake Gladys + fake KEF speaker (test/fixtures/)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **External ids are forever.** `gladys.externalIds('kef', <MAC address>)`,
  never the IP address. Gladys keys devices, their history, scenes and
  dashboards on them. The same goes for every key users store: manifest
  `config_schema`, `actions`, feature keys, source values.
- **The volume cap is a safety rule.** Every volume sent goes through the cap
  read just before sending (commands, unmute, the checks after a wake-up);
  never add a path that bypasses it.
- **No switch** for power: buttons and read-only states only.
- **Standby and Pause are protective**: never queued, never blocked by a
  pause, a read or another command; they cancel the waking / playing
  commands still waiting.
- **Never read a speaker sooner than the interval** from a button, a
  Discovery scan, a reconnection, a configuration saved again or a restart.
  Only a command (its identity check and read-back) and the checks that
  follow it read sooner.
- **Identity before every command**: the MAC address read again; an
  unreadable answer refuses the command, it never means "another speaker".
- **Confirmation by value**: a command is confirmed only by the value read
  back; a write that may have reached the speaker is never "not sent".
- **The container rootfs is read-only.** Write only under `/data`. Never log
  anything secret (there is none today).
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand (0.1.0 was set once by hand, see `TODO.md`).
  `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md`. Never write a version heading: the Release workflow does.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`.
  The catalog `description` holds 10 to 100 characters per language.
- **User-facing text** is bilingual (English and French), kept in sync. Files
  are UTF-8 without BOM, without control bytes (`test/encoding.test.js`).
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never leave the loopback interface.
