# Third-party notices

This integration ports to JavaScript the logic of the following project: the
paths of the KEF speaker API (`/api/getData`, `/api/setData`, the
`settings:/…` and `player:…` paths), the shape of the values
(`kefSpeakerStatus`, `kefPhysicalSource`, `i32_`, `bool_`, `string_`), the
power on (`powerOn`), standby and source writes, the track controls, the mute
as a volume set to 0, the release text read as model and firmware, and the
choice of POST or GET for a write by model (`src/kef/`). Nothing of it is
installed at runtime; its notice is reproduced below.

## pykefcontrol 0.9.3

<https://github.com/N0ciple/pykefcontrol>, version `0.9.3` of 2026-05-02

```
MIT License

Copyright (c) 2020 rodupont

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## LM1LC3N7/gladys-cambridge-audio, gladys-nad and gladys-linn

The structure of the app, the `/data` store, the handler wiring, the volume
cap and the command rules follow integrations of the same author, under the
Apache License 2.0 of this repository.
