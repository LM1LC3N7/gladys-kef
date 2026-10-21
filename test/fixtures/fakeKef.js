// -----------------------------------------------------------------------------
// A fake KEF speaker on the loopback interface: the `/api/getData` and
// `/api/setData` answers as pykefcontrol reads them. It records every request,
// and can be told to answer slowly, fail, accept a write and ignore it, or
// take time to wake up.
// -----------------------------------------------------------------------------

import http from 'node:http';

export const MAC = 'aabbccddeeff';

export async function startFakeKef({
  mac = 'AA:BB:CC:DD:EE:FF',
  name = 'Living room',
  release = 'LSXII_4.2.1',
  on = true,
  source = 'wifi',
  volume = 30,
  mute = false,
  playState = 'playing',
  title = 'Get Lucky',
  artist = 'Daft Punk',
} = {}) {
  const fake = {
    state: { mac, name, release, on, source, volume, mute, playState, title, artist },
    /** Every request: { method, kind: 'get'|'set', path, value } */
    requests: [],
    /** path -> ms of delay before answering */
    delays: {},
    /** path -> HTTP status answered instead */
    failures: {},
    /** paths whose writes are accepted (200) and ignored */
    ignore: new Set(),
    /** after a power on, the status stays "standby" this long (ms) */
    wakeDelay: 0,
    /** the volume the speaker comes back with after a power on */
    wakeVolume: undefined,
    /** path -> raw text answered instead (junk, huge...) */
    raw: {},
    get writes() {
      return fake.requests.filter((r) => r.kind === 'set');
    },
    reads(path) {
      return fake.requests.filter((r) => r.kind === 'get' && (!path || r.path === path)).length;
    },
  };
  const s = fake.state;

  const item = (path) => {
    switch (path) {
      case 'settings:/system/primaryMacAddress':
        return { type: 'string_', string_: s.mac };
      case 'settings:/deviceName':
        return { type: 'string_', string_: s.name };
      case 'settings:/releasetext':
        return { type: 'string_', string_: s.release };
      case 'settings:/kef/host/speakerStatus':
        return { type: 'kefSpeakerStatus', kefSpeakerStatus: s.on ? 'powerOn' : 'standby' };
      case 'settings:/kef/play/physicalSource':
        return { type: 'kefPhysicalSource', kefPhysicalSource: s.on ? s.source : 'standby' };
      case 'player:volume':
        return { type: 'i32_', i32_: s.volume };
      case 'settings:/mediaPlayer/mute':
        return { type: 'bool_', bool_: s.mute };
      case 'player:player/data':
        return {
          state: s.on ? s.playState : 'stopped',
          status: { duration: 248000 },
          trackRoles: {
            title: s.title,
            icon: 'http://example.invalid/cover.jpg',
            mediaData: { metaData: { artist: s.artist, album: 'RAM' } },
          },
        };
      default:
        return undefined;
    }
  };

  const write = (path, value) => {
    if (fake.ignore.has(path)) {
      return;
    }
    if (path === 'settings:/kef/play/physicalSource') {
      const target = value?.kefPhysicalSource;
      if (target === 'standby') {
        s.on = false;
      } else if (target === 'powerOn' || typeof target === 'string') {
        if (target !== 'powerOn') {
          s.source = target;
        }
        const wake = () => {
          s.on = true;
          if (fake.wakeVolume !== undefined) {
            s.volume = fake.wakeVolume;
          }
        };
        if (s.on) {
          // already on
        } else if (fake.wakeDelay > 0) {
          setTimeout(wake, fake.wakeDelay);
        } else {
          wake();
        }
      }
    } else if (path === 'player:volume') {
      s.volume = value?.i32_;
    } else if (path === 'player:player/control') {
      if (value?.control === 'pause') {
        s.playState = s.playState === 'playing' ? 'paused' : 'playing';
      }
    }
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let kind;
      let path;
      let value;
      if (url.pathname === '/api/getData') {
        kind = 'get';
        path = url.searchParams.get('path');
      } else if (url.pathname === '/api/setData') {
        kind = 'set';
        if (req.method === 'POST') {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          path = body.path;
          value = body.value;
        } else {
          path = url.searchParams.get('path');
          value = JSON.parse(url.searchParams.get('value') ?? 'null');
        }
      } else {
        res.writeHead(404).end();
        return;
      }
      fake.requests.push({ method: req.method, kind, path, value });
      const answer = () => {
        if (fake.failures[path]) {
          res.writeHead(fake.failures[path]).end();
          return;
        }
        if (fake.raw[path] !== undefined) {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(fake.raw[path]);
          return;
        }
        if (kind === 'set') {
          write(path, value);
          res.writeHead(200, { 'Content-Type': 'application/json' }).end('[]');
          return;
        }
        const data = item(path);
        if (data === undefined) {
          res.writeHead(500).end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify([data]));
      };
      const delay = fake.delays[path] ?? 0;
      if (delay > 0) {
        setTimeout(answer, delay);
      } else {
        answer();
      }
    });
  });
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.port = server.address().port;
  fake.close = () =>
    new Promise((resolve) => {
      sockets.forEach((socket) => socket.destroy());
      server.close(() => resolve());
    });
  return fake;
}
