import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [directory] = process.argv.slice(2);
if (!directory) throw new Error('Pass the customer web export directory.');

const entryFile = resolve(directory, 'index.html');
const html = await readFile(entryFile, 'utf8');
const marker = 'id="cena-browser-frame"';
const expoEntry = /<script\s+src="(\/_expo\/static\/js\/web\/entry-[a-f0-9]+\.js)"\s+defer><\/script>/;
const entry = html.match(expoEntry);

if (!html.includes(marker)) {
  if (!entry || !html.includes('</head>')) throw new Error('Expected a single-page Expo web export.');

  const width = 390;
  const height = 844;
  const frameStyles = `<style>
    body.cena-demo-desktop { margin: 0; background: #EEE5DF; }
    body.cena-demo-desktop #root { display: grid; place-items: center; }
    .cena-demo-device {
      overflow: hidden; position: relative; border-radius: calc(28px * var(--cena-demo-scale));
      background: #FAF6F3; outline: 1px solid #D8C8BF; box-shadow: 0 16px 48px #46110E20;
    }
    .cena-demo-screen {
      position: absolute; inset: 0 auto auto 0; display: block; border: 0;
      width: ${width}px; height: ${height}px; transform: scale(var(--cena-demo-scale)); transform-origin: top left;
    }
  </style>`;

  const launch = `<script ${marker}>
    const url = new URL(window.location.href);
    const desktop = window.matchMedia('(min-width: 600px) and (pointer: fine)').matches;
    if (desktop && url.searchParams.get('screen') !== '1') {
      document.body.classList.add('cena-demo-desktop');
      const device = document.createElement('div');
      device.className = 'cena-demo-device';
      const screen = document.createElement('iframe');
      screen.className = 'cena-demo-screen';
      screen.title = 'Cena iPhone demo';
      screen.allow = 'geolocation';
      url.searchParams.set('screen', '1');
      screen.src = url.href;
      device.append(screen);
      document.getElementById('root').append(device);

      function fit() {
        const scale = Math.min(1, Math.max(1, window.innerWidth - 32) / ${width},
          Math.max(1, window.innerHeight - 32) / ${height});
        device.style.setProperty('--cena-demo-scale', scale);
        device.style.width = ${width} * scale + 'px';
        device.style.height = ${height} * scale + 'px';
      }
      fit();
      window.addEventListener('resize', fit);
    } else {
      const app = document.createElement('script');
      app.src = ${JSON.stringify(entry[1])};
      document.body.append(app);
    }
  </script>`;

  await writeFile(entryFile, html.replace('</head>', `${frameStyles}\n</head>`).replace(expoEntry, launch));
}
