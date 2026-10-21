# gladys-kef

A [Gladys Assistant](https://gladysassistant.com) external integration for
**KEF wireless speakers** (LS50 Wireless II, LSX II, LSX II LT, LS60), over
their local HTTP API, without any cloud: power state, Power on and Standby
buttons, volume capped by an option, mute, source, play, pause, next,
previous, playback state and the title playing.

> Never tested with a real speaker: the KEF API is not documented, and this
> integration follows the `pykefcontrol` library (MIT). Unofficial, not
> affiliated with KEF.

- User guide: [English](docs/en.md) · [Français](docs/fr.md)
- Changes: [CHANGELOG.md](CHANGELOG.md) · Decisions and next steps:
  [TODO.md](TODO.md)

## How it works

- One read loop per speaker address, at the configured interval (10 s by
  default), never sooner: neither the buttons, a Discovery scan, a
  reconnection to Gladys, a configuration saved again nor a restart (the time
  of the last read is kept in `/data`) make a speaker read sooner.
- A speaker is known by its MAC address, read again at every read and before
  every command (an address given to another speaker is never commanded).
- Power is read only, with two push buttons: no switch, nothing an
  "everything off" could reach.
- Standby and Pause never wait behind another command and cancel the waking
  or playing commands still waiting; a Standby not confirmed is asserted
  again for about 20 s.
- The volume never goes above the cap through Gladys, also at a wake-up,
  after a lowering ignored, and when unmuting.
- Every command is confirmed by the value read back, within 3.5 s, or
  reported "sent, without confirmation" / "nothing sent".
- Answers are bounded (64 KB, 2.5 s), parsed once, only the expected fields
  kept; at most 250 states a minute go to Gladys.

## Development

Node.js 22 or later.

```bash
npm install
npm run format:check
npm run lint
npm test
npm audit --omit=dev
npm run cover        # regenerates cover.png (800×534)
npx --yes github:GladysAssistant/integration-store .
```

The tests run the exact handlers of the container against the fake Gladys of
the SDK and a fake KEF speaker on the loopback interface. See
[CLAUDE.md](CLAUDE.md) for the architecture and the rules.

## License

[Apache License 2.0](LICENSE). The KEF protocol logic is ported from
pykefcontrol (MIT): see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
