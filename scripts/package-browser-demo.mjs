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
    body.cena-demo-desktop { margin: 0; background: #000; }
    body.cena-demo-desktop #root { display: grid; place-items: center; }
    .cena-demo-device {
      overflow: hidden; position: relative; border-radius: calc(28px * var(--cena-demo-scale));
      background: #FAF6F3; outline: 1px solid #383838;
    }
    .cena-demo-screen {
      position: absolute; inset: 0 auto auto 0; display: block; border: 0;
      width: ${width}px; height: ${height}px; transform: scale(var(--cena-demo-scale)); transform-origin: top left;
    }
    .cena-demo-fullscreen {
      position: fixed; right: 16px; bottom: 16px; width: 44px; height: 44px;
      display: grid; place-items: center; padding: 0; border: 1px solid #595959;
      background: #171717; color: #FFF; border-radius: 10px; cursor: pointer;
    }
    .cena-demo-fullscreen:hover { background: #292929; }
    .cena-demo-fullscreen:focus-visible { outline: 2px solid #FAF6F3; outline-offset: 3px; }
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
        const scale = Math.min(1, Math.max(1, window.innerWidth - 136) / ${width},
          Math.max(1, window.innerHeight - 32) / ${height});
        device.style.setProperty('--cena-demo-scale', scale);
        device.style.width = ${width} * scale + 'px';
        device.style.height = ${height} * scale + 'px';
      }
      fit();
      window.addEventListener('resize', fit);

      const page = document.documentElement;
      const enter = page.requestFullscreen ?? page.webkitRequestFullscreen;
      const exit = document.exitFullscreen ?? document.webkitExitFullscreen;
      if ((document.fullscreenEnabled ?? document.webkitFullscreenEnabled) && enter && exit) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'cena-demo-fullscreen';
        button.innerHTML = '<svg aria-hidden="true" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path/></svg>';
        const icon = button.querySelector('path');
        const isFullscreen = () => Boolean(document.fullscreenElement ?? document.webkitFullscreenElement);

        function updateFullscreen() {
          const active = isFullscreen();
          const label = active ? 'Exit fullscreen' : 'Enter fullscreen';
          button.setAttribute('aria-label', label);
          button.title = label;
          icon.setAttribute('d', active
            ? 'M8 3v5H3m13-5v5h5M8 21v-5H3m13 5v-5h5'
            : 'M8 3H3v5m13-5h5v5M8 21H3v-5m13 5h5v-5');
          fit();
        }

        button.addEventListener('click', async () => {
          try {
            if (isFullscreen()) await exit.call(document);
            else await enter.call(page);
          } catch {
            button.title = 'Fullscreen is unavailable in this window';
          }
        });
        document.addEventListener('fullscreenchange', updateFullscreen);
        document.addEventListener('webkitfullscreenchange', updateFullscreen);
        document.body.append(button);
        updateFullscreen();
      }
    } else {
      const app = document.createElement('script');
      app.src = ${JSON.stringify(entry[1])};
      document.body.append(app);
    }
  </script>`;

  await writeFile(entryFile, html.replace('</head>', `${frameStyles}\n</head>`).replace(expoEntry, launch));
}
