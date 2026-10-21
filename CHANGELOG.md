# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- KEF wireless speakers (LS50 Wireless II, LSX II, LSX II LT, LS60) over their
  local HTTP API, without any cloud: added by IP address, kept by their MAC
  address in `/data`.
- Power state (read only), "Power on" and "Standby" buttons, volume (0 to
  100, validated strictly, capped by the `max_volume` option, 40 % by
  default), mute (volume 0, the previous volume kept; unmute at most at the
  cap), play, pause, next, previous, playback state, a "Source" dropdown and
  the title playing.
- A read loop per address at the `poll_interval` option (10 s by default),
  never sooner: buttons, Discovery, reconnections, a configuration saved
  again and restarts (the last read is kept in `/data`) do not hurry it. A
  speaker that does not answer shows as off and is read at spaced intervals.
- "Find the speakers" and "Check the speakers" buttons.

### Security

- Standby and Pause never wait in the command queue and cancel the waking or
  playing commands still waiting; a Standby not confirmed is asserted again
  for about 20 s.
- The identity of the speaker (MAC address) is read again before every
  command and at every read: another speaker at the address is never
  commanded.
- Every command is confirmed by the value read back, never by the answer
  alone, within 3.5 s; a command still waiting at its deadline is dropped,
  never sent late.
- The volume is capped at a wake-up, after a lowering ignored and when
  unmuting.
- Answers are bounded (64 KB, 2.5 s for the whole exchange), parsed once,
  only the expected fields of the expected types kept; no redirect followed.
- At most 250 states a minute are published, simultaneous publications
  included.

[Unreleased]: https://github.com/LM1LC3N7/gladys-kef/commits/main
