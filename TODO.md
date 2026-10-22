# TODO — KEF v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm audit --omit=dev`,
  `npx github:GladysAssistant/integration-store .`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only.

## Status

- [x] **Milestone 1 — local control** (2026-10-21): speakers added by IP
      address, identity by MAC address; one read loop per address at the
      configured interval (never sooner, last read kept in /data); power
      state, Power on, Standby, volume capped by `max_volume`, mute, play,
      pause, next, previous, playback state, source dropdown, title;
      "Find" and "Check" buttons; docs en/fr. Tested against a fake speaker
      on the loopback interface only, never with a real speaker. The store
      validator could not be run from the development session (no access to
      it there): to run before the first release.
- [x] **Fix review 1** (2026-10-21): commands numbered at arrival, the
      Standby guard ended only by a newer wake-up and never started or
      written over one; a Standby maybe sent (5xx, no answer) starts the
      guard and reads the power; one play/pause toggle in flight per
      speaker, a second Pause joins the first, Pause waits for a settled
      state and never says "nothing to send" while a Play toggle is
      unconfirmed; Mute cancels the older volumes waiting; a source chosen
      in standby caps the volume within the command; a cap check step holds
      the queue `preRead` at most. Minor: Standby sent without a model (POST,
      then GET on a 4xx, kept in /data); a read begun before a command keeps
      the value read back; one loop per MAC (a second address of the same
      speaker is only checked, spaced, and named in the status); a 4xx write
      is "refused"; a full table still takes the address from the old
      speaker; /data loaded once (commands wait for it), unused addresses
      pruned; name and model of a speaker without a name read at most every
      10 minutes. Tests in `test/review1.test.js`.
- [x] **Fix review 2** (2026-10-21): the "Play maybe sent" mark expires
      (command budget + one check delay) and is never set by a 4xx; Pause on
      a speaker paused (mark expired), stopped or in standby is "nothing to
      send"; the cap checks read outside the queue (each read bounded by one
      request timeout), only the lowering and its read-back are queued
      (`preRead`), so a slow speaker is still brought back to the cap; every
      waking write (source, play, next, previous) counts as the newest
      wake-up for the Standby guard; the duplicate-address check is made
      again just before a read is kept (two first reads at once).
- [x] **Fix 0.1.2** (2026-10-22, recommendation of approval 2): the queued
      lowering of a cap check that waited in the queue more than
      `confirmEvery` reads the MAC again (bounded by its `preRead` budget)
      before writing; another speaker or an unreadable MAC: nothing written,
      the next step reads again. A free queue costs no extra request.
- [ ] **Milestone 2 — real speakers** (testers with an LS50 Wireless II,
      LSX II, LSX II LT, LS60 or XIO). To check first:
  - the answer to `setData` (body, status) for POST and GET, and whether a
    write is acted on before the answer;
  - `settings:/kef/host/speakerStatus` and `physicalSource` during a
    wake-up and in standby; how long a wake-up takes;
  - whether `player:volume` can be set in standby (a lowering before the
    wake-up would then be possible);
  - `settings:/mediaPlayer/mute` (read here, never written): whether a
    write of `bool_` unmutes, so the mute could stop using volume 0;
  - the play states (`playing`, `paused`, `stopped`...) and what the
    `pause` toggle does from `stopped`;
  - whether a source change on a speaker already on changes the volume
    (a volume per input): if so, start the cap checks (`capChain`) after
    every source change, not only after one made in standby;
  - the inputs of each model (USB on the LSX II? HDMI on the XIO?), and
    whether the XIO takes POST writes;
  - the MAC address format of `settings:/system/primaryMacAddress`;
  - an mDNS or SSDP service announced by the speakers, for an automatic
    search;
  - the rendering on the Gladys dashboard (music buttons, mute press,
    button/push, unknown/binary power, text/select source, text/text title).
- [ ] **Milestone 3 — more**: event queue (`/api/event/modifyQueue`,
      `pollQueue`) instead of polling, if a real speaker shows it is
      reliable; volume up/down buttons; the speaker's own volume limit
      (`settings:/kef/host/maximumVolume`) shown.
- [ ] **Milestone 4 — first release**: Docker image build check, Release
      workflow, topic, then the store validator once the image is published.

## Decisions

- Forum: no dedicated topic, no post from this module's work; one recap per
  wave in /t/10385, posted by the main session.
- Reuse: N0ciple/pykefcontrol 0.9.3 (MIT, 2026-05-02, LICENSE checked:
  "Copyright (c) 2020 rodupont") is Python (requests/aiohttp), so its paths,
  values and write rules are ported to JavaScript (`src/kef/`); MIT notice in
  `THIRD_PARTY_NOTICES.md`, copied into the image. No runtime dependency
  besides the SDK: Node's `http` with explicit bounds.
- Version 0.1.0 in `package.json`, `package-lock.json`, the manifest and the
  `docker_image` tag, set by hand at milestone 1: the one exception to
  "versions belong to the Release workflow", because the template's 1.0.0 and
  its image were someone else's. The first patch release gives 0.1.1.
- Neighbour modules followed: LM1LC3N7/gladys-cambridge-audio 0.1.2 (app
  structure, confirmation by value, wake-up checks, Standby outside the
  queue), gladys-nad and gladys-linn (HTTP transport bounds, protective
  commands), read only.
- External ids: `gladys.externalIds('kef', <MAC, 12 lowercase hex digits>)`,
  never the IP address. Feature keys are frozen: `power`, `power_on`,
  `standby`, `volume`, `mute`, `play`, `pause`, `next`, `previous`,
  `playback`, `source`, `title`. Every publication carries the full, fixed
  list (a speaker published again never loses a feature).
- **Power: read-only state + two `button/push` ("Power on", "Standby"), not
  a `switch`** (lesson of lot 6). Power on writes `physicalSource: powerOn`,
  Standby `physicalSource: standby`, as pykefcontrol.
- **Polling, not the event queue**: the KEF event queue is a long poll (10 s
  held requests, a queue id renewed every 50 s); polling plain `getData`
  keeps every request short and bounded, and Standby never shares a
  connection with a held request. Interval option 5..300 s, 10 s by default.
  Only the MAC address and the power are required for a read; source,
  volume, mute and player data may fail alone (a secondary failure never
  stops the read).
- **Never sooner than the interval** (lot 11): the Find button and the
  Discovery scan read only the addresses whose read is due; Check reads
  nothing (it shows the last read and its age); `connected` and a
  configuration saved again only keep the loops; one read at a time per
  address (a second request joins it). The time of the last read of each
  address is kept in /data, written at most once a minute for that alone; at
  a restart, an address read less than a minute plus an interval before the
  saved time waits a whole interval (the saved time may be up to a minute
  old). Two failed reads in a row: power 0, then reads spaced, doubled from
  the interval up to 5 minutes.
- **Identity** (lot 11): the MAC address is read first at every read and
  before every command. Another MAC address at the address of a known
  speaker: its address is forgotten (power 0, status says so), the other
  speaker is remembered; an unreadable MAC (junk, timeout) is a failed read
  or a refused command, never "another speaker".
- **Volume cap** (`max_volume`, 1..100, default 40 %: KEF speakers are loud
  at 50): a higher volume asked from Gladys is set to the cap, read just
  before the write. The feature range stays 0..100 (frozen at creation).
  Cap checks after a wake-up (Power on, a source chosen in standby) and after
  a volume write not confirmed (accepted and ignored): every 2.5 s, 6 times,
  through the queue, each step holding the queue `preRead` (1.2 s) at most
  (review 1), the whole window (not stopped at the first good read),
  each one lowering a volume above the cap and confirming by the value read
  back. A Standby does not stop them (they only lower a speaker that says it
  is on).
- **Mute** as pykefcontrol: volume 0, the previous volume kept in /data;
  unmute sets it back, at most the cap read just before the write. The mute
  flag of the speaker (`settings:/mediaPlayer/mute`) is read: true (muted by
  the remote or the app) refuses the press, the integration does not write
  an undocumented path. The Mute state shown is the flag or a volume of 0.
- **Confirmation by value** (lot 11): Power on (status on, within the whole
  budget), Standby (status standby, never while a Power on may still be
  waking it), volume, unmute, source and play/pause (play state) are
  confirmed only by a read-back equal to the value asked, read every 250 ms
  within the budget; otherwise "sent, without confirmation". Next / previous
  have no value: the answer is enough. A write answered 2xx is "may have
  left"; a timeout or reset after the request was written too.
- **Commands**: budget 3.5 s from the Gladys request (queue wait included),
  each request bounded by what is left, the deadline checked again right
  before each write (after a slow identity read too); the ack races a
  wall-clock deadline and never waits for a publication (states go through
  a timer). One queue per speaker, 16 waiting at most; Mute goes before the
  others waiting.
- **Protective commands** (lot 11): Standby and Pause are never queued.
  Standby cancels the queued power on, source, play, next and previous, and
  a waking command already running checks the Standby count right before
  each write; Pause cancels play, next and previous the same way. A Standby
  not confirmed starts a guard: every 2.5 s, 8 times, the speaker read "on"
  is put in standby again (outside the queue); a failed write keeps the
  guard going; a waking command of Gladys that may have left ends it.
- (Review 1) Order of the requests: every command gets an arrival number
  per speaker. `lastWakeLeft` is the number of the latest waking command
  (Power on, a source in standby) whose write may have left (set as it
  leaves, put back when nothing left). A Standby guard stops only for a
  waking command asked after its Standby; it never starts, and never
  writes, once a waking command asked after it may have left. A Standby
  write maybe sent (5xx, timeout after writing, connection closed) starts
  the guard and reads the power once (`preRead`) before answering "sent,
  without confirmation"; a 4xx is "refused by the speaker (HTTP 4xx),
  nothing changed" (still counted as reached, for the checks).
- (Review 1) Toggles: one play/pause toggle in flight per speaker
  (`withToggle`, from the read of the state to its confirmation), separate
  from the queue: Pause still never waits in the queue, only behind that
  one toggle. A Pause pressed while one runs joins it. Pause reads the play
  state until it is settled (buffering waits within the budget), and while
  a Play toggle may have left unconfirmed it waits for `playing` instead of
  answering "nothing to send".
- (Review 1) Mute cancels the volumes asked before it and still waiting
  ("cancelled by Mute"); a volume running reads the Mute count again right
  before its write. Mute keeps its place before the other commands.
- (Review 1) Standby without a model read (release text failing): sent
  anyway, POST then GET once on a 4xx; the method that worked is kept in
  /data (`writeMethod`). The other commands still need the model.
- (Review 1) A read begun before a command does not overwrite a value the
  command read back after it began (`version` / `noted` per link). One read
  loop per MAC: a second typed address answering with the MAC of a speaker
  read elsewhere is a duplicate, read only every 5 minutes to notice a
  move, and named in the status.
- Play / pause: the API only has the `pause` toggle; it is sent only after
  the play state read again says it is needed (Play from `paused`, Pause
  from `playing`), nothing sent when already as asked (Pause on `stopped`
  too), refused otherwise. Play, next and previous are refused in standby
  (they never wake the speaker).
- Writes: POST of JSON for LS50WII, LSXIILT, LSXII and LS60 (pykefcontrol's
  list, model from `settings:/releasetext` with its aliases), GET with the
  value in the query string for the others (XIO not confirmed). The model is
  kept in /data; unknown at a command, it is read first.
- Sources: the six inputs pykefcontrol names (`wifi`, `bluetooth`, `tv`,
  `optic`, `coaxial`, `analog`), a fixed select list; another value read is
  not published. Selecting the Bluetooth input of the speaker is not
  Bluetooth from the container.
- Hostile input: 64 KB per answer (declared length and streamed bytes),
  2.5 s for the whole exchange (headers and body), the pieces joined once,
  one `JSON.parse`, only own fields of the expected types (`[ { ... } ]`
  first item), strings cleaned (control and bidi characters) and cut (200
  characters for the title, 64 for names), source ids plain identifiers,
  MAC addresses 12 hex digits (never all zeros or all F). No redirect, no
  keep-alive, no User-Agent of any application. Tables without prototype.
- State budget: one publisher for the whole integration, publications
  serialized, the room taken before the request, 250 states a minute
  (Gladys admits 300), power first and the title last; only changed values;
  everything forgotten (sent again) on `connected` and for a device created.
- Status: "connected" (local integration, no account), with a message naming
  the addresses that do not answer, the speakers without address and those
  off or unreachable. Republished, with the Discovery list and the states,
  at every `connected`.
- Categories and types from the core only: `music` for volume, play, pause,
  next, previous and playback state (as the core Sonos service),
  `television/volume-mute` for mute, `text/select`, `text/text`,
  `button/push`, `unknown/binary`. No unit (`DEVICE_FEATURE_UNITS_BY_CATEGORY`
  lists none for these categories). Store category `multimedia`.
- No automatic search: no announced service is known for these speakers;
  `network_discovery` is not declared.
